import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { Prisma, type TenderType } from '@prisma/client';
import { prisma, isUniqueViolation } from '../../lib/prisma.js';
import { asyncHandler, ok } from '../../lib/http.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { D, money, toNumber } from '../../lib/money.js';
import { logger } from '../../lib/logger.js';
import { NotFound, Conflict, BadRequest } from '../../lib/errors.js';
import { computeLoyalty } from '../loyalty/loyalty.routes.js';
import { postStock, resolveBranchId } from '../../domain/stock.js';
import { assertSellable } from '../../domain/variants.js';
import { resolveSaleRefs } from '../../domain/tenancy.js';
import { settle, settleLegacy } from '../../domain/payments.js';
import { postCredit, creditPortion } from '../../domain/credit.js';
import { localDay, localDayOf } from '../../lib/time.js';
import { computeTotals, resolveTaxRate } from '../../lib/tax.js';

/**
 * ---------------------------------------------------------------------------
 * OFFLINE-FIRST SALE SYNC
 * ---------------------------------------------------------------------------
 * The terminal is the source of truth for WHAT was sold and WHEN (its clock,
 * its UUID). The server is the source of truth for the receipt NUMBER and the
 * stock ledger. Reconciliation rules:
 *
 *   • UNIQUE(orgId, clientUuid): a batch replayed after a dropped connection
 *     inserts nothing twice. The response tells the device which UUIDs are
 *     safe to purge from its outbox.
 *   • Totals are RECOMPUTED server-side from the lines. The client's totals
 *     are advisory; money maths is never trusted from a device.
 *   • Receipt numbers come from the per-org sequence at sync time — two
 *     tills syncing simultaneously get distinct, gap-free numbers.
 *   • Stock decrements happen exactly once, inside the same transaction as
 *     the insert.
 * ---------------------------------------------------------------------------
 */

const saleLineSchema = z.object({
  productId: z.string().cuid().nullable().optional(),
  name: z.string().trim().min(1).max(180),
  unitPrice: z.coerce.number().nonnegative(),
  qty: z.coerce.number().positive().max(999_999),
  /// Omitted (or null) means "inherit" — the product's rate, else the org's.
  /// An explicit 0 is a zero-rated line and survives the chain: untaxed bread
  /// is not the same fact as a line nobody set a rate on.
  taxRate: z.coerce.number().min(0).max(100).nullable().optional(),
  lineDiscount: z.coerce.number().nonnegative().default(0),
});

const offlineSaleSchema = z.object({
  clientUuid: z.string().uuid(),
  // Device-minted short id for the public receipt page (/r/:publicId).
  publicId: z.string().regex(/^[a-z0-9]{8,24}$/i).optional(),
  registerId: z.string().cuid().nullable().optional(),
  branchId: z.string().cuid().nullable().optional(),
  shiftId: z.string().cuid().nullable().optional(),
  customerId: z.string().cuid().nullable().optional(),
  /// Points the cashier asked to spend. The server decides what's actually
  /// allowed — a device must never be trusted to mint or spend points.
  redeemPoints: z.coerce.number().nonnegative().max(1_000_000).default(0),
  items: z.array(saleLineSchema).min(1).max(200),
  discount: z.coerce.number().nonnegative().default(0),
  /// Split payment. When present this is the settlement; `tender`/`tendered`
  /// below are the pre-split shape and still accepted, because an outbox can
  /// hold sales written by an older build for days.
  payments: z
    .array(
      z.object({
        type: z.enum(['CASH', 'CARD', 'QR', 'CREDIT', 'OTHER']),
        amount: z.coerce.number(),
        tendered: z.coerce.number().nonnegative().nullable().optional(),
        reference: z.string().trim().max(80).nullable().optional(),
      }),
    )
    .min(1)
    .max(10)
    .optional(),
  tender: z.enum(['CASH', 'CARD', 'QR', 'CREDIT', 'OTHER']).default('CASH'),
  tendered: z.coerce.number().nonnegative().default(0),
  note: z.string().trim().max(255).optional(),
  soldAt: z.coerce.date(),
});

const syncSchema = z.object({
  sales: z.array(offlineSaleSchema).min(1).max(100), // one outbox flush per request
});

async function nextSaleNumber(orgId: string, tx: Prisma.TransactionClient): Promise<number> {
  await tx.$executeRaw`
    INSERT INTO org_sequences (orgId, scope, current, updatedAt)
    VALUES (${orgId}, 'sale', LAST_INSERT_ID(1), UTC_TIMESTAMP(3))
    ON DUPLICATE KEY UPDATE current = LAST_INSERT_ID(current + 1), updatedAt = UTC_TIMESTAMP(3)
  `;
  const rows = await tx.$queryRaw<Array<{ seq: bigint }>>`SELECT LAST_INSERT_ID() AS seq`;
  return Number(rows[0]?.seq ?? 0);
}

export const salesRouter = Router();
salesRouter.use(requireAuth);

salesRouter.post(
  '/sync',
  validate({ body: syncSchema }),
  asyncHandler(async (req, res) => {
    const { orgId, userId } = req.auth!;
    const batchTracking = req.org?.capabilities.includes("stock.batches") ?? false;
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: {
        currency: true,
        taxRate: true,
        taxInclusive: true,
        loyaltyEnabled: true,
        loyaltyEarnRate: true,
        loyaltyRedeemValue: true,
        loyaltyMinRedeem: true,
      },
    });
    if (!org) throw NotFound('Organization');

    // Single-branch shops don't send branchId — fall back to the default
    // branch so per-branch stock and reporting work without any UI change.
    const defaultBranch = await prisma.branch.findFirst({
      where: { orgId, isDefault: true, deletedAt: null },
      select: { id: true },
    });

    const results: Array<{ clientUuid: string; status: 'created' | 'duplicate' | 'failed'; number?: number; id?: string; error?: string }> = [];

    // Sequential, one transaction per sale: a bad sale in a batch must not
    // poison the 40 good ones around it.
    for (const sale of (req.body as z.infer<typeof syncSchema>).sales) {
      try {
        const created = await prisma.$transaction(async (tx) => {
          // One scoped query answers three questions about the products on
          // this sale: what tax rate applies, what they cost us, and whether
          // stock moves. Scoped by orgId, so an id from another tenant simply
          // resolves to nothing.
          const lineProductIds = [
            ...new Set(sale.items.map((i) => i.productId).filter((id): id is string => Boolean(id))),
          ];
          const products = lineProductIds.length
            ? await tx.product.findMany({
                where: { id: { in: lineProductIds }, orgId, deletedAt: null },
                select: { id: true, name: true, trackStock: true, taxRate: true, cost: true, variantOptions: true },
              })
            : [];
          const byId = new Map(products.map((p) => [p.id, p]));

          // A variant parent is a folder, not a thing on the shelf. Ringing
          // one up would take money for an unidentified item and move no
          // stock — so the line fails and the device keeps it to be fixed.
          for (const product of products) assertSellable(product);

          // The other three device-supplied ids. Anything this org does not
          // own is dropped rather than written — see domain/tenancy.ts for why
          // these are nulled while a bad branchId refuses outright.
          const refs = await resolveSaleRefs(tx, orgId, {
            shiftId: sale.shiftId,
            registerId: sale.registerId,
            customerId: sale.customerId,
          });

          // Server-side money maths — device totals are never trusted.
          const lines = sale.items.map((item) => {
            const gross = money(D(item.unitPrice).mul(item.qty));
            const lineTotal = money(gross.minus(money(item.lineDiscount)));
            const product = item.productId ? byId.get(item.productId) : undefined;
            return {
              ...item,
              lineTotal,
              resolvedTaxRate: resolveTaxRate(item.taxRate, product?.taxRate, org.taxRate),
              // Frozen now. What this cost us can never be restated by a
              // delivery that arrives next month.
              unitCost: product ? product.cost : null,
            };
          });
          const subtotal = lines.reduce((s, l) => s.plus(l.lineTotal), D(0));
          const discount = money(sale.discount);
          const afterDiscount = money(subtotal.minus(discount));

          // Loyalty is computed server-side inside this transaction — points
          // are money, so the device only ever *requests* a redemption.
          const loyalty = await computeLoyalty(tx, {
            orgId,
            customerId: refs.customerId,
            requestedRedeemPoints: sale.redeemPoints,
            subtotalAfterDiscount: toNumber(afterDiscount),
            org,
          });

          // Per-line rates, and inclusive/exclusive as an actual branch rather
          // than an assumption. Bill-level reductions are spread across lines
          // before tax, because tax is a per-line question.
          const totals = computeTotals({
            lines: lines.map((l) => ({ lineTotal: l.lineTotal, taxRate: l.resolvedTaxRate })),
            billDiscount: discount,
            loyaltyDiscount: D(loyalty.discount),
            taxInclusive: org.taxInclusive,
          });
          const tax = totals.tax;
          const total = totals.total;

          // How the bill was settled. Split payments come as a list; older
          // devices send one tender and are folded into the same shape, so
          // every sale from here down has payment rows.
          const settlement = sale.payments
            ? settle(total, sale.payments)
            : settleLegacy(total, sale.tender, sale.tendered);
          const tendered = settlement.tendered;
          const change = settlement.change;
          // A device that sends no branch lands in the default one. A device
          // that names a branch has to prove it owns it — an id from another
          // org would otherwise write that org's shelf. Costs a query only on
          // the multi-branch path.
          const branchId = sale.branchId
            ? await resolveBranchId(tx, orgId, sale.branchId)
            : defaultBranch?.id ?? null;

          const number = await nextSaleNumber(orgId, tx);

          const row = await tx.sale.create({
            data: {
              orgId,
              clientUuid: sale.clientUuid,
              publicId: sale.publicId ?? null,
              number,
              registerId: refs.registerId,
              branchId,
              shiftId: refs.shiftId,
              cashierId: userId,
              customerId: refs.customerId,
              currency: org.currency,
              subtotal: money(subtotal),
              discount,
              tax,
              total,
              tendered,
              change,
              tender: settlement.primaryTender,
              payments: {
                create: settlement.payments.map((p) => ({
                  orgId,
                  type: p.type,
                  amount: p.amount,
                  tendered: p.tendered,
                  change: p.change,
                  reference: p.reference,
                })),
              },
              pointsEarned: money(loyalty.pointsEarned),
              pointsRedeemed: money(loyalty.pointsRedeemed),
              loyaltyDiscount: money(loyalty.discount),
              note: sale.note ?? null,
              soldAt: sale.soldAt,
              items: {
                create: lines.map((l, i) => ({
                  productId: l.productId ?? null,
                  nameSnapshot: l.name,
                  unitPrice: money(l.unitPrice),
                  qty: D(l.qty),
                  taxRate: l.resolvedTaxRate,
                  lineDiscount: money(l.lineDiscount),
                  lineTotal: l.lineTotal,
                  unitCost: l.unitCost,
                  netExTax: totals.lines[i]!.netExTax,
                  taxAmount: totals.lines[i]!.taxAmount,
                })),
              },
            },
          });

          // Stock decrement + ledger row — same transaction, exactly once.
          // Reuses the lookup above: a product missing from `byId` belongs to
          // another tenant or is deleted, and moves nobody's stock.
          const movingLines = lines.filter(
            (l): l is typeof l & { productId: string } =>
              Boolean(l.productId) && Boolean(byId.get(l.productId!)?.trackStock),
          );
          if (movingLines.length > 0) {
            await postStock(
              tx,
              { orgId, branchId, userId, batches: batchTracking },
              movingLines.map((l) => ({
                productId: l.productId,
                qty: -l.qty,
                type: 'SALE' as const,
                refType: 'sale',
                refId: row.id,
              })),
            );
          }

          // Anything settled on account is a receivable, not takings. Without
          // this the sale counted itself into the day's money and left no
          // record of who owed it.
          const onAccount = creditPortion(settlement.payments);
          if (!onAccount.isZero()) {
            if (!refs.customerId) {
              throw BadRequest('An account sale needs a customer — otherwise nobody owes the money');
            }
            await postCredit(tx, { orgId, userId }, [
              {
                customerId: refs.customerId,
                type: 'CHARGE',
                amount: onAccount,
                saleId: row.id,
                note: `Receipt #${number}`,
              },
            ]);
          }

          // Loyalty ledger — one row per direction, balance updated once.
          // `refs.customerId` has been proven to belong to this org; the raw
          // device value had not, and this update carried no org scope of its
          // own — it would have moved another tenant's points.
          const loyaltyCustomerId = refs.customerId;
          if (loyaltyCustomerId && (loyalty.pointsRedeemed > 0 || loyalty.pointsEarned > 0)) {
            const net = loyalty.pointsEarned - loyalty.pointsRedeemed;
            await tx.customer.update({
              where: { id: loyaltyCustomerId },
              data: { loyaltyPoints: { increment: net } },
            });
            if (loyalty.pointsRedeemed > 0) {
              await tx.loyaltyTransaction.create({
                data: {
                  orgId,
                  customerId: loyaltyCustomerId,
                  saleId: row.id,
                  type: 'REDEEM',
                  points: money(-loyalty.pointsRedeemed),
                  value: money(loyalty.discount),
                  note: `Receipt #${number}`,
                },
              });
            }
            if (loyalty.pointsEarned > 0) {
              await tx.loyaltyTransaction.create({
                data: {
                  orgId,
                  customerId: loyaltyCustomerId,
                  saleId: row.id,
                  type: 'EARN',
                  points: money(loyalty.pointsEarned),
                  note: `Receipt #${number}`,
                },
              });
            }
          }

          return row;
        });

        results.push({ clientUuid: sale.clientUuid, status: 'created', number: created.number, id: created.id });
      } catch (err) {
        if (isUniqueViolation(err)) {
          const existing = await prisma.sale.findUnique({
            where: { uniq_org_client_sale: { orgId, clientUuid: sale.clientUuid } },
            select: { id: true, number: true },
          });
          results.push({ clientUuid: sale.clientUuid, status: 'duplicate', number: existing?.number, id: existing?.id });
        } else {
          const message = err instanceof Error ? err.message : String(err);
          logger.error({ err, clientUuid: sale.clientUuid, orgId }, 'sale sync failed');
          results.push({ clientUuid: sale.clientUuid, status: 'failed', error: message });
        }
      }
    }

    // created + duplicate ⇒ the device may purge those outbox rows.
    ok(res, { results, purgeable: results.filter((r) => r.status !== 'failed').map((r) => r.clientUuid) });
  }),
);

salesRouter.get(
  '/',
  validate({
    query: z.object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(25),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
      search: z.string().trim().max(60).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    const q = req.query as unknown as { page: number; pageSize: number; from?: Date; to?: Date; search?: string };
    const where: Prisma.SaleWhereInput = {
      orgId,
      ...(q.from || q.to ? { soldAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
      ...(q.search && /^\d+$/.test(q.search) ? { number: Number(q.search) } : {}),
    };

    const [total, items] = await prisma.$transaction([
      prisma.sale.count({ where }),
      prisma.sale.findMany({
        where,
        orderBy: { soldAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: {
          items: true,
          cashier: { select: { name: true } },
          customer: { select: { id: true, name: true } },
        },
      }),
    ]);

    res.json({ ok: true, data: items, meta: { page: q.page, pageSize: q.pageSize, total, totalPages: Math.max(1, Math.ceil(total / q.pageSize)) } });
  }),
);

/**
 * Daily Z-report — the number every shop owner checks before locking up.
 *
 * The day is the shop's day. This used to cut it on UTC midnight, so a Colombo
 * shop's "today" ran 05:30 to 05:30 and their whole evening — the busiest part
 * of the trade — landed in tomorrow's figure. Wrong for every tenant outside
 * UTC, which is every tenant in the launch market. `lib/time.ts` and the
 * digest job always did this correctly; this endpoint simply never used them.
 */
salesRouter.get(
  '/z-report',
  validate({ query: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }) }),
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    const timezone = req.org?.timezone ?? 'UTC';
    const requested = (req.query as { date?: string }).date;
    const day = requested ? localDayOf(timezone, requested) : localDay(timezone, new Date());
    const dayStart = day.start;
    const dayEnd = day.end;

    const [agg, byTender, count, topItems] = await prisma.$transaction([
      prisma.sale.aggregate({
        where: { orgId, status: 'COMPLETED', soldAt: { gte: dayStart, lt: dayEnd } },
        _sum: { total: true, discount: true, tax: true },
      }),
      // From the payment rows: a split bill contributes to each tender it
      // actually used, and refunds subtract themselves.
      prisma.salePayment.groupBy({
        by: ['type'],
        where: { orgId, sale: { status: 'COMPLETED', soldAt: { gte: dayStart, lt: dayEnd } } },
        orderBy: { type: 'asc' },
        _sum: { amount: true },
        _count: true,
      }),
      prisma.sale.count({
        where: { orgId, status: 'COMPLETED', kind: 'SALE', soldAt: { gte: dayStart, lt: dayEnd } },
      }),
      prisma.saleItem.groupBy({
        by: ['nameSnapshot'],
        where: { sale: { orgId, status: 'COMPLETED', soldAt: { gte: dayStart, lt: dayEnd } } },
        _sum: { qty: true, lineTotal: true },
        orderBy: { _sum: { lineTotal: 'desc' } },
        take: 10,
      }),
    ]);

    ok(res, {
      date: day.date,
      timezone,
      salesCount: count,
      gross: toNumber(agg._sum.total),
      discounts: toNumber(agg._sum.discount),
      tax: toNumber(agg._sum.tax),
      byTender: byTender.map((t) => ({ tender: t.type, total: toNumber(t._sum?.amount), count: t._count })),
      topItems: topItems.map((i) => ({ name: i.nameSnapshot, qty: toNumber(i._sum?.qty), total: toNumber(i._sum?.lineTotal) })),
    });
  }),
);

/**
 * Refund — give back some or all of a sale.
 *
 * A void says "this never happened" and only works on the whole thing. A
 * refund is a real, separate event: the customer keeps two of the three, hands
 * one back, and gets money for it. That distinction is why this writes a new
 * `Sale` with `kind: REFUND` rather than mutating the original — the original
 * receipt has to keep reading the way it did when it was printed, and a credit
 * note is its own numbered document wherever a tax authority is looking.
 *
 * Everything downstream nets automatically because the row is signed: negative
 * quantities, negative revenue and tax, negative payments.
 */
salesRouter.post(
  '/:id/refund',
  requireRole('MANAGER'),
  validate({
    params: z.object({ id: z.string().cuid() }),
    body: z.object({
      reason: z.string().trim().min(3).max(255),
      /// Omit to give the whole remaining sale back.
      lines: z
        .array(z.object({ saleItemId: z.string().cuid(), qty: z.coerce.number().positive() }))
        .min(1)
        .max(200)
        .optional(),
      payments: z
        .array(
          z.object({
            type: z.enum(['CASH', 'CARD', 'QR', 'CREDIT', 'OTHER']),
            amount: z.coerce.number(),
            reference: z.string().trim().max(80).nullable().optional(),
          }),
        )
        .min(1)
        .max(10)
        .optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { orgId, userId } = req.auth!;
    const body = req.body as {
      reason: string;
      lines?: Array<{ saleItemId: string; qty: number }>;
      payments?: Array<{ type: TenderType; amount: number; reference?: string | null }>;
    };

    const original = await prisma.sale.findFirst({
      where: { id: req.params.id!, orgId },
      include: { items: true, payments: true },
    });
    if (!original) throw NotFound('Sale');
    if (original.kind === 'REFUND') throw Conflict('A refund cannot itself be refunded');
    if (original.status === 'VOID') throw Conflict('This sale was voided — there is nothing to give back');

    // The money leaves the drawer that is open now, not the one that took it
    // last Tuesday. Attaching a refund to the original sale's shift would put
    // a variance on a shift that was counted and closed days ago.
    const openShift = await prisma.shift.findFirst({
      where: {
        orgId,
        status: 'OPEN',
        // Prefer the branch the sale belongs to, but accept a shift opened
        // before branches were resolved on this path.
        ...(original.branchId ? { OR: [{ branchId: original.branchId }, { branchId: null }] } : {}),
      },
      orderBy: { openedAt: 'desc' },
      select: { id: true },
    });

    const refund = await prisma.$transaction(async (tx) => {
      // What is still refundable, line by line.
      const byId = new Map(original.items.map((i) => [i.id, i]));
      const requested =
        body.lines ??
        original.items
          .map((i) => ({ saleItemId: i.id, qty: toNumber(i.qty) - toNumber(i.refundedQty) }))
          .filter((l) => l.qty > 0);

      if (requested.length === 0) throw Conflict('This sale has already been refunded in full');

      const lines = requested.map((req_) => {
        const item = byId.get(req_.saleItemId);
        if (!item) throw NotFound('Sale line');
        const remaining = D(item.qty).minus(item.refundedQty);
        if (D(req_.qty).gt(remaining)) {
          throw Conflict(
            `Only ${remaining.toString()} of "${item.nameSnapshot}" is left to refund (${toNumber(item.refundedQty)} already returned)`,
          );
        }
        // Refund proportionally: two of the three go back at two thirds of
        // whatever that line actually earned after its share of the discount.
        const share = D(req_.qty).div(item.qty);
        return {
          item,
          qty: D(req_.qty),
          lineTotal: money(D(item.lineTotal).mul(share)),
          netExTax: money(D(item.netExTax ?? 0).mul(share)),
          taxAmount: money(D(item.taxAmount).mul(share)),
        };
      });

      const total = money(lines.reduce((s, l) => s.plus(l.netExTax).plus(l.taxAmount), D(0)));
      if (total.lte(0)) throw BadRequest('Nothing to refund on those lines');

      const settlement = body.payments
        ? settle(total.negated(), body.payments.map((p) => ({ ...p, amount: -Math.abs(p.amount) })))
        : settleLegacy(total.negated(), original.tender, 0);

      const number = await nextSaleNumber(orgId, tx);

      const row = await tx.sale.create({
        data: {
          orgId,
          kind: 'REFUND',
          originalSaleId: original.id,
          clientUuid: crypto.randomUUID(),
          number,
          branchId: original.branchId,
          shiftId: openShift?.id ?? null,
          registerId: original.registerId,
          cashierId: userId,
          customerId: original.customerId,
          currency: original.currency,
          subtotal: money(lines.reduce((s, l) => s.plus(l.lineTotal), D(0))).negated(),
          discount: D(0),
          tax: money(lines.reduce((s, l) => s.plus(l.taxAmount), D(0))).negated(),
          total: total.negated(),
          tendered: D(0),
          change: D(0),
          tender: settlement.primaryTender,
          note: body.reason,
          soldAt: new Date(),
          items: {
            create: lines.map((l) => ({
              productId: l.item.productId,
              originalItemId: l.item.id,
              nameSnapshot: l.item.nameSnapshot,
              unitPrice: l.item.unitPrice,
              qty: l.qty.negated(),
              taxRate: l.item.taxRate,
              lineDiscount: D(0),
              lineTotal: l.lineTotal.negated(),
              unitCost: l.item.unitCost,
              netExTax: l.netExTax.negated(),
              taxAmount: l.taxAmount.negated(),
            })),
          },
          payments: {
            create: settlement.payments.map((p) => ({
              orgId,
              type: p.type,
              amount: p.amount,
              reference: p.reference,
            })),
          },
        },
      });

      // Mark the original so the same goods cannot come back twice.
      for (const l of lines) {
        await tx.saleItem.update({
          where: { id: l.item.id },
          data: { refundedQty: { increment: l.qty } },
        });
      }

      // Goods returned to the shelf they left, for tracked products only.
      const productIds = lines.map((l) => l.item.productId).filter((id): id is string => Boolean(id));
      const tracked = productIds.length
        ? await tx.product.findMany({
            where: { id: { in: productIds }, orgId, trackStock: true },
            select: { id: true },
          })
        : [];
      const trackedIds = new Set(tracked.map((p) => p.id));
      await postStock(
        tx,
        { orgId, branchId: original.branchId, userId },
        lines
          .filter((l) => l.item.productId && trackedIds.has(l.item.productId))
          .map((l) => ({
            productId: l.item.productId!,
            qty: l.qty,
            type: 'REFUND_RETURN' as const,
            note: body.reason,
            refType: 'refund',
            refId: row.id,
          })),
      );

      // Money refunded onto the tab reduces what the customer owes.
      const onAccount = creditPortion(settlement.payments);
      if (!onAccount.isZero() && original.customerId) {
        await postCredit(tx, { orgId, userId }, [
          {
            customerId: original.customerId,
            type: 'ADJUST',
            amount: onAccount,
            saleId: row.id,
            note: `Refund of receipt #${original.number}`,
          },
        ]);
      }

      // Points move with the money: take back what this portion earned,
      // return what it spent. Clamped so a balance never goes negative.
      if (original.customerId) {
        const portion = D(total).div(original.total.abs().isZero() ? D(1) : original.total.abs());
        const granted = money(D(original.pointsEarned).mul(portion));
        const spent = money(D(original.pointsRedeemed).mul(portion));
        if (!granted.isZero() || !spent.isZero()) {
          const customer = await tx.customer.findFirst({
            where: { id: original.customerId, orgId, deletedAt: null },
            select: { loyaltyPoints: true },
          });
          if (customer) {
            const wanted = spent.minus(granted);
            const applied = Prisma.Decimal.max(wanted, D(customer.loyaltyPoints).negated());
            if (!applied.isZero()) {
              await tx.customer.update({
                where: { id: original.customerId },
                data: { loyaltyPoints: { increment: money(applied) } },
              });
              await tx.loyaltyTransaction.create({
                data: {
                  orgId,
                  customerId: original.customerId,
                  saleId: row.id,
                  type: 'ADJUST',
                  points: money(applied),
                  note: `Refund of receipt #${original.number}`,
                },
              });
            }
          }
        }
      }

      return row;
    });

    logger.info({ orgId, saleId: original.id, refundId: refund.id }, 'sale refunded');
    ok(res, refund, 201);
  }),
);

salesRouter.post(
  '/:id/void',
  requireRole('MANAGER'),
  validate({ params: z.object({ id: z.string().cuid() }), body: z.object({ reason: z.string().trim().min(3).max(255) }) }),
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    const sale = await prisma.sale.findFirst({ where: { id: req.params.id!, orgId }, include: { items: true } });
    if (!sale) throw NotFound('Sale');
    if (sale.status === 'VOID') throw Conflict('Sale is already void');

    const reason = req.body.reason as string;

    const voided = await prisma.$transaction(async (tx) => {
      // Stock goes back to the branch it left. Posting through the domain
      // layer is what keeps the per-branch balance in step — voiding used to
      // credit only the org rollup, so every void quietly shorted a branch.
      const itemProductIds = sale.items.map((i) => i.productId).filter((id): id is string => Boolean(id));
      const tracked = itemProductIds.length
        ? await tx.product.findMany({ where: { id: { in: itemProductIds }, orgId, trackStock: true }, select: { id: true } })
        : [];
      const trackedIds = new Set(tracked.map((p) => p.id));

      await postStock(
        tx,
        { orgId, branchId: sale.branchId, userId: req.auth!.userId },
        sale.items
          .filter((i): i is typeof i & { productId: string } => Boolean(i.productId) && trackedIds.has(i.productId!))
          .map((i) => ({
            productId: i.productId,
            qty: i.qty,
            type: 'VOID_RETURN' as const,
            note: reason,
            refType: 'sale',
            refId: sale.id,
          })),
      );

      // Points are money, so a void has to undo them too: take back what the
      // sale granted, return what it spent. If the customer has already spent
      // the points we granted, we eat the difference rather than push a
      // balance negative — a shop chasing a customer for points is worse than
      // the loss. The ledger records what was actually applied, so the cached
      // balance still reconciles against it.
      const granted = toNumber(sale.pointsEarned);
      const spent = toNumber(sale.pointsRedeemed);
      if (sale.customerId && (granted > 0 || spent > 0)) {
        const customer = await tx.customer.findFirst({
          where: { id: sale.customerId, orgId, deletedAt: null },
          select: { loyaltyPoints: true },
        });
        if (customer) {
          const balance = toNumber(customer.loyaltyPoints);
          const wanted = spent - granted;
          const applied = Math.max(wanted, -balance);

          if (applied !== 0) {
            await tx.customer.update({
              where: { id: sale.customerId },
              data: { loyaltyPoints: { increment: money(applied) } },
            });
            await tx.loyaltyTransaction.create({
              data: {
                orgId,
                customerId: sale.customerId,
                saleId: sale.id,
                type: 'ADJUST',
                points: money(applied),
                value: spent > 0 ? money(-toNumber(sale.loyaltyDiscount)) : null,
                note: `Void of receipt #${sale.number} — ${reason}`,
              },
            });
          }
        }
      }

      return tx.sale.update({
        where: { id: sale.id },
        data: { status: 'VOID', voidedAt: new Date(), voidReason: reason },
      });
    });

    ok(res, voided);
  }),
);
