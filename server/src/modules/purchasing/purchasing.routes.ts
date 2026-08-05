import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, ok } from '../../lib/http.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { money, toNumber, D } from '../../lib/money.js';
import { NotFound, Conflict } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { postStock, resolveBranchId, weightedAverageCost } from '../../domain/stock.js';

/**
 * Suppliers & purchase orders — the ordering half of the supply chain.
 *
 * Receiving without a PO still works (Shelfie v2 photographs an invoice and
 * pushes straight to /stock/receive). A PO adds the piece that photo alone
 * can't give you: **expected vs delivered**. Short-shipping stops being
 * invisible the moment there's an order to compare against.
 *
 * Receiving against a PO updates qtyReceived per line and moves the order
 * DRAFT/SENT → PARTIAL → RECEIVED automatically.
 */

export const purchasingRouter = Router();
purchasingRouter.use(requireAuth);

// ------------------------------- suppliers ---------------------------------

purchasingRouter.get(
  '/suppliers',
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    ok(res, await prisma.supplier.findMany({ where: { orgId, deletedAt: null }, orderBy: { name: 'asc' } }));
  }),
);

purchasingRouter.post(
  '/suppliers',
  requireRole('MANAGER'),
  validate({
    body: z.object({
      name: z.string().trim().min(2).max(180),
      phone: z.string().trim().max(40).nullable().optional(),
      email: z.string().trim().toLowerCase().email().nullable().optional().or(z.literal('').transform(() => null)),
      address: z.string().trim().max(255).nullable().optional(),
      notes: z.string().trim().max(2000).nullable().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    const exists = await prisma.supplier.findFirst({
      where: { orgId, name: (req.body as { name: string }).name, deletedAt: null },
    });
    if (exists) throw Conflict('A supplier with that name already exists');
    const supplierBody = req.body as { name: string; phone?: string | null; email?: string | null; address?: string | null; notes?: string | null };
    ok(res, await prisma.supplier.create({ data: { orgId, ...supplierBody } }), 201);
  }),
);

// ---------------------------- purchase orders ------------------------------

purchasingRouter.get(
  '/orders',
  validate({
    query: z.object({
      status: z.enum(['DRAFT', 'SENT', 'PARTIAL', 'RECEIVED', 'CANCELLED']).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(30),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    const q = req.query as unknown as { status?: string; limit: number };
    const orders = await prisma.purchaseOrder.findMany({
      where: { orgId, ...(q.status ? { status: q.status as never } : {}) },
      orderBy: { createdAt: 'desc' },
      take: Number(q.limit),
      include: {
        supplier: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true } },
        _count: { select: { items: true } },
      },
    });
    ok(res, orders);
  }),
);

purchasingRouter.get(
  '/orders/:id',
  validate({ params: z.object({ id: z.string().cuid() }) }),
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    const order = await prisma.purchaseOrder.findFirst({
      where: { id: req.params.id!, orgId },
      include: { supplier: true, branch: { select: { id: true, name: true } }, items: true },
    });
    if (!order) throw NotFound('Purchase order');
    ok(res, order);
  }),
);

purchasingRouter.post(
  '/orders',
  requireRole('MANAGER'),
  validate({
    body: z.object({
      supplierId: z.string().cuid().nullable().optional(),
      branchId: z.string().cuid().nullable().optional(),
      expectedAt: z.coerce.date().nullable().optional(),
      notes: z.string().trim().max(2000).nullable().optional(),
      items: z
        .array(
          z.object({
            productId: z.string().cuid().nullable().optional(),
            name: z.string().trim().min(1).max(180),
            qty: z.coerce.number().positive().max(999_999),
            unitCost: z.coerce.number().nonnegative().max(99_999_999).default(0),
          }),
        )
        .min(1, 'A purchase order needs at least one line')
        .max(200),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { orgId, userId } = req.auth!;
    const body = req.body as {
      supplierId?: string | null;
      branchId?: string | null;
      expectedAt?: Date | null;
      notes?: string | null;
      items: Array<{ productId?: string | null; name: string; qty: number; unitCost: number }>;
    };

    const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { currency: true } });
    const total = body.items.reduce((s, i) => s + i.qty * i.unitCost, 0);

    const order = await prisma.$transaction(async (tx) => {
      const last = await tx.purchaseOrder.findFirst({
        where: { orgId },
        orderBy: { number: 'desc' },
        select: { number: true },
      });
      return tx.purchaseOrder.create({
        data: {
          orgId,
          supplierId: body.supplierId ?? null,
          branchId: body.branchId ?? null,
          number: (last?.number ?? 0) + 1,
          currency: org.currency,
          total: money(total),
          expectedAt: body.expectedAt ?? null,
          notes: body.notes ?? null,
          createdById: userId,
          items: {
            create: body.items.map((i) => ({
              productId: i.productId ?? null,
              nameSnapshot: i.name,
              qty: D(i.qty),
              unitCost: money(i.unitCost),
            })),
          },
        },
        include: { items: true },
      });
    });

    logger.info({ orgId, poId: order.id, number: order.number }, 'purchase order created');
    ok(res, order, 201);
  }),
);

purchasingRouter.post(
  '/orders/:id/status',
  requireRole('MANAGER'),
  validate({
    params: z.object({ id: z.string().cuid() }),
    body: z.object({ status: z.enum(['DRAFT', 'SENT', 'CANCELLED']) }),
  }),
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    const order = await prisma.purchaseOrder.findFirst({ where: { id: req.params.id!, orgId } });
    if (!order) throw NotFound('Purchase order');
    if (order.status === 'RECEIVED') throw Conflict('A fully received order cannot change status');
    ok(res, await prisma.purchaseOrder.update({ where: { id: order.id }, data: { status: req.body.status as never } }));
  }),
);

/**
 * Receive against a PO. Each row references a PO line; stock, per-branch
 * balance, ledger and qtyReceived all move in one transaction, and the order
 * status is recomputed from the lines rather than set by the caller.
 */
purchasingRouter.post(
  '/orders/:id/receive',
  requireRole('MANAGER'),
  validate({
    params: z.object({ id: z.string().cuid() }),
    body: z.object({
      branchId: z.string().cuid().nullable().optional(),
      rows: z
        .array(
          z.object({
            itemId: z.string().cuid(),
            qty: z.coerce.number().positive().max(999_999),
            unitCost: z.coerce.number().nonnegative().max(99_999_999).nullable().optional(),
          }),
        )
        .min(1)
        .max(200),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { orgId, userId } = req.auth!;
    const { branchId, rows } = req.body as {
      branchId?: string | null;
      rows: Array<{ itemId: string; qty: number; unitCost?: number | null }>;
    };

    const order = await prisma.purchaseOrder.findFirst({
      where: { id: req.params.id!, orgId },
      include: { items: true, supplier: { select: { name: true } } },
    });
    if (!order) throw NotFound('Purchase order');
    if (order.status === 'CANCELLED') throw Conflict('This order was cancelled');

    // Validates the caller's branch (or the order's) against this org before
    // anything is written; falls back to the default branch otherwise.
    const targetBranch = await resolveBranchId(prisma, orgId, branchId ?? order.branchId);

    const note = order.supplier?.name ? `PO #${order.number} · ${order.supplier.name}` : `PO #${order.number}`;

    const summary = await prisma.$transaction(async (tx) => {
      let received = 0;

      for (const row of rows) {
        const item = order.items.find((i) => i.id === row.itemId);
        if (!item) throw NotFound('Purchase order line');

        // Create the product on first receipt if the line was free-text.
        const lineCost = row.unitCost ?? toNumber(item.unitCost);
        let productId = item.productId;
        if (!productId) {
          const created = await tx.product.create({
            data: {
              orgId,
              name: item.nameSnapshot,
              // No selling price on a PO line — mark up 25% as a starting point.
              price: money(lineCost * 1.25),
              cost: money(lineCost),
              trackStock: true,
              stockQty: D(0),
            },
          });
          productId = created.id;
          await tx.purchaseOrderItem.update({ where: { id: item.id }, data: { productId } });
        }

        // Quantity is not set here — `postStock` owns every balance.
        const onShelf = await tx.product.findUniqueOrThrow({
          where: { id: productId },
          select: { stockQty: true, cost: true },
        });
        await tx.product.update({
          where: { id: productId },
          data: {
            trackStock: true,
            ...(row.unitCost != null
              ? {
                  cost: weightedAverageCost({
                    currentQty: onShelf.stockQty,
                    currentCost: onShelf.cost,
                    receivedQty: row.qty,
                    receivedCost: row.unitCost,
                  }),
                }
              : {}),
          },
        });

        await postStock(tx, { orgId, branchId: targetBranch, userId }, [
          {
            productId,
            qty: row.qty,
            type: 'RECEIVE',
            unitCost: row.unitCost ?? item.unitCost,
            note,
            refType: 'purchase_order',
            refId: order.id,
          },
        ]);

        await tx.purchaseOrderItem.update({
          where: { id: item.id },
          data: { qtyReceived: { increment: row.qty } },
        });
        received += 1;
      }

      // Recompute status from the lines — never trust a caller-supplied one.
      const fresh = await tx.purchaseOrderItem.findMany({ where: { purchaseOrderId: order.id } });
      const complete = fresh.every((i) => new Prisma.Decimal(i.qtyReceived).gte(i.qty));
      const any = fresh.some((i) => new Prisma.Decimal(i.qtyReceived).gt(0));
      const status = complete ? 'RECEIVED' : any ? 'PARTIAL' : order.status;

      await tx.purchaseOrder.update({
        where: { id: order.id },
        data: { status, receivedAt: complete ? new Date() : null },
      });

      return { received, status };
    });

    logger.info({ orgId, poId: order.id, ...summary }, '📥 received against purchase order');
    ok(res, summary);
  }),
);
