import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { SupplierAccount } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, ok } from '../../lib/http.js';
import { validate } from '../../middleware/validate.js';
import { publicLimiter } from '../../middleware/rateLimit.js';
import { money, toNumber, D } from '../../lib/money.js';
import { Unauthorized, NotFound, Conflict } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { resolvePortalToken, sendPortalLink } from '../../services/supplierPortal.js';

/**
 * ---------------------------------------------------------------------------
 * SUPPLIER PORTAL (P4) — supplier side
 * ---------------------------------------------------------------------------
 * Token-authenticated, no passwords. A supplier can:
 *   • see and confirm orders placed through the network
 *   • publish and reprice their catalog
 *   • read AGGREGATED demand across the shops they serve
 *
 * The demand view is the reason a supplier joins. It is deliberately
 * aggregated and never names a shop: suppliers get the signal ("42 units of
 * this moved across 7 shops last month"), shops keep their privacy. Break
 * that and shops leave; without shops there is no signal to sell.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      supplier?: SupplierAccount;
    }
  }
}

async function requireSupplier(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const raw = (req.headers['x-supplier-token'] as string | undefined) ?? (req.query.t as string | undefined);
  if (!raw) return next(Unauthorized('Portal link required'));
  const supplier = await resolvePortalToken(raw);
  if (!supplier) return next(Unauthorized('This portal link has expired — request a new one'));
  req.supplier = supplier;
  next();
}

export const supplierRouter = Router();

/** Self-serve listing. A supplier can put themselves on the network. */
supplierRouter.post(
  '/register',
  publicLimiter,
  validate({
    body: z.object({
      name: z.string().trim().min(2).max(180),
      email: z.string().trim().toLowerCase().email(),
      phone: z.string().trim().max(40).optional(),
      country: z.string().trim().length(2),
      currency: z.string().trim().toUpperCase().length(3).default('LKR'),
      description: z.string().trim().max(2000).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const body = req.body as {
      name: string; email: string; phone?: string; country: string; currency: string; description?: string;
    };

    const existing = await prisma.supplierAccount.findUnique({ where: { email: body.email } });
    if (existing) {
      // Don't leak whether an account exists — just re-send the link.
      await sendPortalLink(existing.id);
      return ok(res, { status: 'link_sent' });
    }

    const base = body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'supplier';
    let slug = base;
    for (let i = 2; await prisma.supplierAccount.findUnique({ where: { slug } }); i += 1) slug = `${base}-${i}`;

    const supplier = await prisma.supplierAccount.create({
      data: {
        slug,
        name: body.name,
        email: body.email,
        phone: body.phone ?? null,
        country: body.country.toUpperCase(),
        currency: body.currency,
        description: body.description ?? null,
        // Listed immediately — an empty directory is worth nothing, and a
        // supplier with no catalog is harmless.
        status: 'ACTIVE',
      },
    });

    await sendPortalLink(supplier.id);
    logger.info({ supplierAccountId: supplier.id, slug }, '🏭 supplier joined the network');
    ok(res, { status: 'link_sent' }, 201);
  }),
);

supplierRouter.post(
  '/portal-link',
  publicLimiter,
  validate({ body: z.object({ email: z.string().trim().toLowerCase().email() }) }),
  asyncHandler(async (req, res) => {
    const supplier = await prisma.supplierAccount.findUnique({ where: { email: req.body.email as string } });
    if (supplier) await sendPortalLink(supplier.id);
    // Always the same response — no account enumeration.
    ok(res, { status: 'link_sent' });
  }),
);

// --- authenticated portal ---------------------------------------------------

supplierRouter.get(
  '/me',
  requireSupplier,
  asyncHandler(async (req, res) => {
    const s = req.supplier!;
    const [products, pendingOrders, connections] = await Promise.all([
      prisma.supplierProduct.count({ where: { supplierAccountId: s.id, isActive: true, deletedAt: null } }),
      prisma.purchaseOrder.count({ where: { supplierAccountId: s.id, status: 'SENT' } }),
      prisma.supplierConnection.count({ where: { supplierAccountId: s.id, status: 'ACTIVE' } }),
    ]);
    ok(res, {
      supplier: {
        id: s.id, name: s.name, slug: s.slug, email: s.email, currency: s.currency,
        minOrder: toNumber(s.minOrder), leadDays: s.leadDays, description: s.description,
      },
      stats: { products, pendingOrders, connectedShops: connections },
    });
  }),
);

supplierRouter.get(
  '/orders',
  requireSupplier,
  validate({ query: z.object({ status: z.enum(['SENT', 'PARTIAL', 'RECEIVED', 'CANCELLED']).optional() }) }),
  asyncHandler(async (req, res) => {
    const s = req.supplier!;
    const status = (req.query as { status?: string }).status;
    const orders = await prisma.purchaseOrder.findMany({
      where: { supplierAccountId: s.id, ...(status ? { status: status as never } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        items: true,
        org: { select: { name: true, phone: true, address: true } },
        branch: { select: { name: true, address: true, phone: true } },
      },
    });

    ok(res, orders.map((o) => ({
      id: o.id,
      number: o.number,
      status: o.status,
      total: toNumber(o.total),
      currency: o.currency,
      createdAt: o.createdAt,
      expectedAt: o.expectedAt,
      confirmedAt: o.confirmedAt,
      notes: o.notes,
      // The buyer IS named — they placed an order with this supplier, so the
      // delivery address is exactly what the supplier is entitled to see.
      shop: { name: o.org.name, phone: o.branch?.phone ?? o.org.phone, address: o.branch?.address ?? o.org.address },
      items: o.items.map((i) => ({
        name: i.nameSnapshot,
        qty: toNumber(i.qty),
        qtyReceived: toNumber(i.qtyReceived),
        unitCost: toNumber(i.unitCost),
      })),
    })));
  }),
);

supplierRouter.post(
  '/orders/:id/confirm',
  requireSupplier,
  validate({
    params: z.object({ id: z.string().cuid() }),
    body: z.object({ expectedAt: z.coerce.date().nullable().optional() }),
  }),
  asyncHandler(async (req, res) => {
    const s = req.supplier!;
    const order = await prisma.purchaseOrder.findFirst({ where: { id: req.params.id!, supplierAccountId: s.id } });
    if (!order) throw NotFound('Order');
    if (order.status !== 'SENT') throw Conflict('This order can no longer be confirmed');

    ok(res, await prisma.purchaseOrder.update({
      where: { id: order.id },
      data: {
        confirmedAt: new Date(),
        expectedAt: (req.body as { expectedAt?: Date | null }).expectedAt ?? order.expectedAt,
      },
    }));
  }),
);

// --- catalog management -----------------------------------------------------

supplierRouter.get(
  '/products',
  requireSupplier,
  asyncHandler(async (req, res) => {
    const products = await prisma.supplierProduct.findMany({
      where: { supplierAccountId: req.supplier!.id, deletedAt: null },
      orderBy: { name: 'asc' },
    });
    ok(res, products);
  }),
);

const productSchema = z.object({
  name: z.string().trim().min(1).max(180),
  sku: z.string().trim().max(60).nullable().optional(),
  barcode: z.string().trim().max(60).nullable().optional(),
  category: z.string().trim().max(80).nullable().optional(),
  unitCost: z.coerce.number().nonnegative().max(99_999_999),
  moq: z.coerce.number().positive().max(999_999).default(1),
  packSize: z.coerce.number().positive().max(999_999).default(1),
  unit: z.enum(['pc', 'kg', 'g', 'l', 'ml', 'case', 'box']).default('pc'),
  inStock: z.boolean().default(true),
  isActive: z.boolean().default(true),
});

supplierRouter.post(
  '/products',
  requireSupplier,
  validate({ body: productSchema }),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof productSchema>;
    ok(res, await prisma.supplierProduct.create({
      data: {
        supplierAccountId: req.supplier!.id,
        ...body,
        unitCost: money(body.unitCost),
        moq: D(body.moq),
        packSize: D(body.packSize),
      },
    }), 201);
  }),
);

supplierRouter.patch(
  '/products/:id',
  requireSupplier,
  validate({ params: z.object({ id: z.string().cuid() }), body: productSchema.partial() }),
  asyncHandler(async (req, res) => {
    const existing = await prisma.supplierProduct.findFirst({
      where: { id: req.params.id!, supplierAccountId: req.supplier!.id, deletedAt: null },
    });
    if (!existing) throw NotFound('Product');
    const body = req.body as Partial<z.infer<typeof productSchema>>;
    ok(res, await prisma.supplierProduct.update({
      where: { id: existing.id },
      data: {
        ...body,
        ...(body.unitCost !== undefined ? { unitCost: money(body.unitCost) } : {}),
        ...(body.moq !== undefined ? { moq: D(body.moq) } : {}),
        ...(body.packSize !== undefined ? { packSize: D(body.packSize) } : {}),
      },
    }));
  }),
);

supplierRouter.patch(
  '/profile',
  requireSupplier,
  validate({
    body: z.object({
      name: z.string().trim().min(2).max(180).optional(),
      phone: z.string().trim().max(40).nullable().optional(),
      address: z.string().trim().max(255).nullable().optional(),
      description: z.string().trim().max(2000).nullable().optional(),
      minOrder: z.coerce.number().nonnegative().max(99_999_999).optional(),
      leadDays: z.coerce.number().int().min(0).max(90).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const body = req.body as Record<string, unknown>;
    ok(res, await prisma.supplierAccount.update({
      where: { id: req.supplier!.id },
      data: {
        ...body,
        ...(body.minOrder !== undefined ? { minOrder: money(body.minOrder as number) } : {}),
      },
    }));
  }),
);

/**
 * DEMAND INTELLIGENCE — the reason a supplier joins the network.
 *
 * Aggregated across every shop connected to this supplier. Never names a
 * shop, never exposes a shop's stock levels or margins: the supplier learns
 * WHAT is moving and roughly how widely, not WHO. That boundary is what makes
 * shops willing to be on the other side of it.
 */
supplierRouter.get(
  '/demand',
  requireSupplier,
  validate({ query: z.object({ days: z.coerce.number().int().min(7).max(180).default(30) }) }),
  asyncHandler(async (req, res) => {
    const s = req.supplier!;
    const days = Number(req.query.days);
    const since = new Date(Date.now() - days * 86_400_000);

    const connected = await prisma.supplierConnection.count({ where: { supplierAccountId: s.id, status: 'ACTIVE' } });

    // Ordered-through-me: what these shops actually bought from this supplier.
    const ordered = await prisma.$queryRaw<Array<{ name: string; units: string; shops: bigint; revenue: string }>>`
      SELECT poi.nameSnapshot            AS name,
             SUM(poi.qty)                AS units,
             COUNT(DISTINCT po.orgId)    AS shops,
             SUM(poi.qty * poi.unitCost) AS revenue
      FROM purchase_order_items poi
      JOIN purchase_orders po ON po.id = poi.purchaseOrderId
      WHERE po.supplierAccountId = ${s.id}
        AND po.status <> 'CANCELLED'
        AND po.createdAt >= ${since}
      GROUP BY poi.nameSnapshot
      ORDER BY SUM(poi.qty * poi.unitCost) DESC
      LIMIT 50
    `;

    // Running low right now, across connected shops, for items this supplier
    // lists. This is the actionable half — "seven shops need this today".
    const restock = await prisma.$queryRaw<Array<{ name: string; shops: bigint; unitCost: string }>>`
      SELECT sp.name                  AS name,
             COUNT(DISTINCT p.orgId)  AS shops,
             sp.unitCost              AS unitCost
      FROM supplier_products sp
      JOIN products p
        ON (p.barcode IS NOT NULL AND p.barcode = sp.barcode)
        OR LOWER(p.name) = LOWER(sp.name)
      JOIN supplier_connections sc
        ON sc.orgId = p.orgId AND sc.supplierAccountId = ${s.id} AND sc.status = 'ACTIVE'
      WHERE sp.supplierAccountId = ${s.id}
        AND sp.isActive = 1 AND sp.deletedAt IS NULL
        AND p.deletedAt IS NULL AND p.trackStock = 1
        AND p.lowStockAt IS NOT NULL AND p.stockQty <= p.lowStockAt
      GROUP BY sp.id, sp.name, sp.unitCost
      ORDER BY shops DESC
      LIMIT 50
    `;

    ok(res, {
      days,
      connectedShops: connected,
      topItems: ordered.map((r) => ({
        name: r.name,
        units: Number(r.units),
        shops: Number(r.shops),
        revenue: Math.round(Number(r.revenue) * 100) / 100,
      })),
      needRestocking: restock.map((r) => ({
        name: r.name,
        shopsLow: Number(r.shops),
        unitCost: Number(r.unitCost),
      })),
    });
  }),
);
