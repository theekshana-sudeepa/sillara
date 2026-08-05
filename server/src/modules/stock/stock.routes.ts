import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, ok } from '../../lib/http.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { money, toNumber, D } from '../../lib/money.js';
import { NotFound, PlanLimit, BadRequest } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { postStock, setStockLevel, resolveBranchId, weightedAverageCost } from '../../domain/stock.js';

/**
 * Stock module — the ledger-backed half of inventory.
 *
 * Rules:
 *   • Nothing here writes a balance by hand. Every change goes through
 *     `domain/stock.ts`, which posts the ledger row and both cached balances
 *     (org rollup and per-branch) together or not at all.
 *   • Receiving goods can CREATE products on the fly (Shelfie v2 photographs
 *     a supplier invoice → new lines become new products with cost + price).
 *   • A delivery blends into a weighted-average cost rather than overwriting.
 *     Overwriting made every past sale's margin move whenever new stock
 *     arrived at a different price.
 */

const receiveRowSchema = z
  .object({
    productId: z.string().cuid().optional(),
    // For brand-new products discovered on an invoice:
    name: z.string().trim().min(1).max(180).optional(),
    price: z.coerce.number().positive().max(99_999_999).optional(), // selling price for new products
    categoryName: z.string().trim().max(80).nullable().optional(),
    qty: z.coerce.number().positive().max(999_999),
    unitCost: z.coerce.number().nonnegative().max(99_999_999).nullable().optional(),
  })
  .refine((r) => r.productId || (r.name && r.price !== undefined), {
    message: 'Each row needs a productId, or a name + selling price for a new product',
  });

export const stockRouter = Router();
stockRouter.use(requireAuth);

/**
 * Low-stock list — powers the reorder banner, so it runs on a hot path.
 *
 * The comparison happens in SQL. It used to hydrate every tracked product with
 * a threshold and filter in Node, which means a supermarket with 50k SKUs
 * loaded 50k rows to show a banner listing eleven of them.
 */
stockRouter.get(
  '/low',
  validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(500).default(200) }) }),
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    const rows = await prisma.$queryRaw<
      Array<{ id: string; name: string; stockQty: string; lowStockAt: string; unit: string }>
    >`
      SELECT id, name, stockQty, lowStockAt, unit
      FROM products
      WHERE orgId = ${orgId}
        AND deletedAt IS NULL
        AND isActive = 1
        AND trackStock = 1
        AND lowStockAt IS NOT NULL
        AND stockQty <= lowStockAt
      ORDER BY stockQty ASC
      LIMIT ${Number(req.query.limit)}
    `;

    ok(
      res,
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        stockQty: Number(r.stockQty),
        lowStockAt: Number(r.lowStockAt),
        unit: r.unit,
      })),
    );
  }),
);

/** Movement history for one product — the audit answer to "where did it go?" */
stockRouter.get(
  '/movements/:productId',
  validate({
    params: z.object({ productId: z.string().cuid() }),
    query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
  }),
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    const movements = await prisma.stockMovement.findMany({
      where: { orgId, productId: req.params.productId! },
      orderBy: { createdAt: 'desc' },
      take: Number(req.query.limit),
    });
    ok(res, movements);
  }),
);

/** Manual adjustment with a reason — shrinkage, breakage, found stock. */
stockRouter.post(
  '/adjust',
  requireRole('MANAGER'),
  validate({
    body: z.object({
      productId: z.string().cuid(),
      branchId: z.string().cuid().nullable().optional(),
      qty: z.coerce.number().gte(-999_999).lte(999_999).refine((n) => n !== 0, 'Adjustment cannot be zero'),
      note: z.string().trim().min(2, 'Say why — future-you will ask').max(255),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { orgId, userId } = req.auth!;
    const { productId, branchId, qty, note } = req.body as {
      productId: string;
      branchId?: string | null;
      qty: number;
      note: string;
    };

    const product = await prisma.product.findFirst({ where: { id: productId, orgId, deletedAt: null } });
    if (!product) throw NotFound('Product');
    if (!product.trackStock) throw BadRequest('Enable stock tracking on this product first');

    const updated = await prisma.$transaction(async (tx) => {
      const branch = await resolveBranchId(tx, orgId, branchId);
      await postStock(tx, { orgId, branchId: branch, userId }, [
        { productId, qty, type: 'ADJUST', note },
      ]);
      return tx.product.findUniqueOrThrow({ where: { id: productId }, select: { stockQty: true } });
    });

    ok(res, { productId, stockQty: toNumber(updated.stockQty) });
  }),
);

/** Stocktake: set the counted value; the ledger records the delta. */
stockRouter.post(
  '/count',
  requireRole('MANAGER'),
  validate({
    body: z.object({
      productId: z.string().cuid(),
      branchId: z.string().cuid().nullable().optional(),
      counted: z.coerce.number().min(0).max(999_999),
      note: z.string().trim().max(255).default('Stocktake'),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { orgId, userId } = req.auth!;
    const { productId, branchId, counted, note } = req.body as {
      productId: string;
      branchId?: string | null;
      counted: number;
      note: string;
    };

    const product = await prisma.product.findFirst({ where: { id: productId, orgId, deletedAt: null } });
    if (!product) throw NotFound('Product');

    const result = await prisma.$transaction(async (tx) => {
      const branch = await resolveBranchId(tx, orgId, branchId);
      // A stocktake on an untracked product is how tracking usually starts.
      if (!product.trackStock) {
        await tx.product.update({ where: { id: productId }, data: { trackStock: true } });
      }
      const { delta } = await setStockLevel(tx, { orgId, branchId: branch, userId }, { productId, counted, note });
      const fresh = await tx.product.findUniqueOrThrow({ where: { id: productId }, select: { stockQty: true } });
      return { delta: toNumber(delta), stockQty: toNumber(fresh.stockQty) };
    });

    ok(res, { productId, ...result });
  }),
);

/**
 * Receive goods — the write half of Shelfie v2. One batch = one supplier
 * delivery. Rows either reference an existing product or create a new one
 * (invoice line for something you've never stocked). All-or-nothing.
 */
stockRouter.post(
  '/receive',
  requireRole('MANAGER'),
  validate({
    body: z.object({
      supplier: z.string().trim().max(120).nullable().optional(),
      branchId: z.string().cuid().nullable().optional(),
      rows: z.array(receiveRowSchema).min(1).max(200),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { orgId, userId } = req.auth!;
    const { supplier, branchId, rows } = req.body as {
      supplier?: string | null;
      branchId?: string | null;
      rows: Array<{
        productId?: string;
        name?: string;
        price?: number;
        categoryName?: string | null;
        qty: number;
        unitCost?: number | null;
      }>;
    };

    // Plan cap covers only the NEW products in the batch.
    const newCount = rows.filter((r) => !r.productId).length;
    if (newCount > 0) {
      const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId }, include: { plan: true } });
      if (org.plan.maxProducts >= 0) {
        const count = await prisma.product.count({ where: { orgId, deletedAt: null } });
        if (count + newCount > org.plan.maxProducts) {
          throw PlanLimit(
            `This delivery adds ${newCount} new product(s), exceeding the ${org.plan.name} plan limit of ${org.plan.maxProducts}. Upgrade to receive it all.`,
          );
        }
      }
    }

    const batchId = `rcv_${Date.now().toString(36)}`;
    const note = supplier ? `Received from ${supplier}` : 'Goods received';

    const result = await prisma.$transaction(async (tx) => {
      let created = 0;
      let updated = 0;
      const branch = await resolveBranchId(tx, orgId, branchId);

      // Resolve categories for new products once per name.
      const wantedCategories = [...new Set(rows.map((r) => r.categoryName).filter((n): n is string => Boolean(n)))];
      const categoryIds = new Map<string, string>();
      for (const name of wantedCategories) {
        const existing = await tx.category.findFirst({ where: { orgId, name, deletedAt: null } });
        const category = existing ?? (await tx.category.create({ data: { orgId, name } }));
        categoryIds.set(name, category.id);
      }

      for (const row of rows) {
        let productId = row.productId;

        if (productId) {
          const product = await tx.product.findFirst({ where: { id: productId, orgId, deletedAt: null } });
          if (!product) throw NotFound('Product in receive batch');
          // Quantity is not set here — `postStock` below owns every balance.
          await tx.product.update({
            where: { id: productId },
            data: {
              trackStock: true,
              ...(row.unitCost != null
                ? {
                    cost: weightedAverageCost({
                      currentQty: product.stockQty,
                      currentCost: product.cost,
                      receivedQty: row.qty,
                      receivedCost: row.unitCost,
                    }),
                  }
                : {}),
            },
          });
          updated += 1;
        } else {
          const product = await tx.product.create({
            data: {
              orgId,
              name: row.name!,
              price: money(row.price!),
              cost: row.unitCost != null ? money(row.unitCost) : new Prisma.Decimal(0),
              trackStock: true,
              // Opens at zero; the RECEIVE posting below is what puts it on the
              // shelf, so the ledger explains the whole balance from row one.
              stockQty: D(0),
              categoryId: row.categoryName ? categoryIds.get(row.categoryName) ?? null : null,
            },
          });
          productId = product.id;
          created += 1;
        }

        await postStock(tx, { orgId, branchId: branch, userId }, [
          {
            productId,
            qty: row.qty,
            type: 'RECEIVE',
            unitCost: row.unitCost ?? null,
            note,
            refType: 'receive_batch',
            refId: batchId,
          },
        ]);
      }

      return { created, updated };
    });

    logger.info({ orgId, batchId, ...result, rows: rows.length }, '📥 goods received');
    ok(res, { batchId, newProducts: result.created, restocked: result.updated, rows: rows.length }, 201);
  }),
);
