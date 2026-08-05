import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, ok } from '../../lib/http.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { money, toNumber, D } from '../../lib/money.js';
import { NotFound, Conflict, BadRequest } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { notifySupplierOfOrder } from '../../services/supplierPortal.js';

/**
 * ---------------------------------------------------------------------------
 * THE SUPPLIER NETWORK (P4) — shop side
 * ---------------------------------------------------------------------------
 * Shops discover suppliers, connect, browse published catalogs and order —
 * all inside Sillara. Orders become ordinary PurchaseOrders, so the existing
 * receive flow (and Shelfie v2) works unchanged; the only difference is that
 * a network order also appears in the supplier's portal.
 *
 * Why this is the moat: a competitor can copy every screen in this codebase.
 * They cannot copy the shops and suppliers who have already found each other
 * here. Every connection makes the next one more valuable — which is the
 * definition of a network effect, and the one thing a feature list can't buy.
 */

export const networkRouter = Router();
networkRouter.use(requireAuth);

/** Directory — suppliers serving this shop's country. */
networkRouter.get(
  '/suppliers',
  validate({ query: z.object({ search: z.string().trim().max(120).optional() }) }),
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    const search = (req.query as { search?: string }).search;

    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: orgId },
      select: { country: true },
    });

    const [suppliers, connections] = await Promise.all([
      prisma.supplierAccount.findMany({
        where: {
          status: 'ACTIVE',
          deletedAt: null,
          country: org.country,
          ...(search ? { name: { contains: search } } : {}),
        },
        orderBy: { name: 'asc' },
        take: 100,
        select: {
          id: true,
          name: true,
          slug: true,
          description: true,
          minOrder: true,
          leadDays: true,
          currency: true,
          _count: { select: { products: { where: { isActive: true, deletedAt: null } } } },
        },
      }),
      prisma.supplierConnection.findMany({ where: { orgId }, select: { supplierAccountId: true, status: true } }),
    ]);

    const byId = new Map(connections.map((c) => [c.supplierAccountId, c.status]));
    ok(res, suppliers.map((s) => ({
      id: s.id,
      name: s.name,
      slug: s.slug,
      description: s.description,
      minOrder: toNumber(s.minOrder),
      leadDays: s.leadDays,
      currency: s.currency,
      productCount: s._count.products,
      connection: byId.get(s.id) ?? null,
    })));
  }),
);

/** Shops this org already buys from. */
networkRouter.get(
  '/connections',
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    const connections = await prisma.supplierConnection.findMany({
      where: { orgId },
      include: {
        supplier: {
          select: { id: true, name: true, slug: true, minOrder: true, leadDays: true, currency: true, phone: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    ok(res, connections);
  }),
);

networkRouter.post(
  '/connect/:supplierAccountId',
  requireRole('MANAGER'),
  validate({
    params: z.object({ supplierAccountId: z.string().cuid() }),
    body: z.object({ accountRef: z.string().trim().max(80).nullable().optional() }),
  }),
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    const supplierAccountId = req.params.supplierAccountId!;

    const supplier = await prisma.supplierAccount.findFirst({
      where: { id: supplierAccountId, status: 'ACTIVE', deletedAt: null },
    });
    if (!supplier) throw NotFound('Supplier');

    // Connections are auto-accepted: friction here is what kills a young
    // network. Suppliers can BLOCK from their portal if they need to.
    const connection = await prisma.supplierConnection.upsert({
      where: { orgId_supplierAccountId: { orgId, supplierAccountId } },
      create: {
        orgId,
        supplierAccountId,
        status: 'ACTIVE',
        accountRef: (req.body as { accountRef?: string | null }).accountRef ?? null,
      },
      update: { status: 'ACTIVE' },
    });

    logger.info({ orgId, supplierAccountId }, '🔗 supplier connected');
    ok(res, connection, 201);
  }),
);

/** A connected supplier's published price list. */
networkRouter.get(
  '/catalog/:supplierAccountId',
  validate({
    params: z.object({ supplierAccountId: z.string().cuid() }),
    query: z.object({ search: z.string().trim().max(120).optional() }),
  }),
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    const supplierAccountId = req.params.supplierAccountId!;

    const connection = await prisma.supplierConnection.findUnique({
      where: { orgId_supplierAccountId: { orgId, supplierAccountId } },
    });
    if (!connection || connection.status !== 'ACTIVE') throw NotFound('Connection — connect to this supplier first');

    const search = (req.query as { search?: string }).search;
    const products = await prisma.supplierProduct.findMany({
      where: {
        supplierAccountId,
        isActive: true,
        deletedAt: null,
        ...(search
          ? { OR: [{ name: { contains: search } }, { sku: { contains: search } }, { barcode: { contains: search } }] }
          : {}),
      },
      orderBy: { name: 'asc' },
      take: 500,
    });

    // Match against the shop's own catalog by barcode, then by name, so the
    // UI can say "you stock this" and reuse the existing product on receive.
    const barcodes = products.map((p) => p.barcode).filter((b): b is string => Boolean(b));
    const mine = await prisma.product.findMany({
      where: { orgId, deletedAt: null, OR: [{ barcode: { in: barcodes } }, { name: { in: products.map((p) => p.name) } }] },
      select: { id: true, name: true, barcode: true, stockQty: true, price: true },
    });
    const byBarcode = new Map(mine.filter((m) => m.barcode).map((m) => [m.barcode!, m]));
    const byName = new Map(mine.map((m) => [m.name.toLowerCase(), m]));

    ok(res, products.map((p) => {
      const match = (p.barcode ? byBarcode.get(p.barcode) : undefined) ?? byName.get(p.name.toLowerCase());
      return {
        id: p.id,
        name: p.name,
        sku: p.sku,
        barcode: p.barcode,
        category: p.category,
        unitCost: toNumber(p.unitCost),
        moq: toNumber(p.moq),
        packSize: toNumber(p.packSize),
        unit: p.unit,
        inStock: p.inStock,
        myProduct: match ? { id: match.id, stockQty: toNumber(match.stockQty), price: toNumber(match.price) } : null,
      };
    }));
  }),
);

/**
 * Place an order through the network. Creates a PurchaseOrder in SENT state
 * and notifies the supplier — from here it flows through the existing PO
 * receive path, so nothing downstream had to change.
 */
networkRouter.post(
  '/order',
  requireRole('MANAGER'),
  validate({
    body: z.object({
      supplierAccountId: z.string().cuid(),
      branchId: z.string().cuid().nullable().optional(),
      notes: z.string().trim().max(2000).nullable().optional(),
      items: z
        .array(
          z.object({
            supplierProductId: z.string().cuid(),
            qty: z.coerce.number().positive().max(999_999),
          }),
        )
        .min(1, 'Add at least one item')
        .max(200),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { orgId, userId } = req.auth!;
    const body = req.body as {
      supplierAccountId: string;
      branchId?: string | null;
      notes?: string | null;
      items: Array<{ supplierProductId: string; qty: number }>;
    };

    const connection = await prisma.supplierConnection.findUnique({
      where: { orgId_supplierAccountId: { orgId, supplierAccountId: body.supplierAccountId } },
      include: { supplier: true },
    });
    if (!connection || connection.status !== 'ACTIVE') throw NotFound('Connection — connect to this supplier first');

    const catalog = await prisma.supplierProduct.findMany({
      where: {
        id: { in: body.items.map((i) => i.supplierProductId) },
        supplierAccountId: body.supplierAccountId,
        isActive: true,
        deletedAt: null,
      },
    });
    if (catalog.length !== body.items.length) throw BadRequest('Some items are no longer available');

    // Enforce the supplier's own rules rather than trusting the client.
    const lines = body.items.map((item) => {
      const product = catalog.find((c) => c.id === item.supplierProductId)!;
      const moq = toNumber(product.moq);
      if (item.qty < moq) {
        throw BadRequest(`${product.name}: minimum order is ${moq} ${product.unit}`);
      }
      return { product, qty: item.qty, lineTotal: item.qty * toNumber(product.unitCost) };
    });

    const total = lines.reduce((s, l) => s + l.lineTotal, 0);
    const minOrder = toNumber(connection.supplier.minOrder);
    if (minOrder > 0 && total < minOrder) {
      throw BadRequest(`${connection.supplier.name} has a minimum order of ${minOrder} ${connection.supplier.currency}`);
    }

    const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { currency: true, name: true } });

    const order = await prisma.$transaction(async (tx) => {
      const last = await tx.purchaseOrder.findFirst({ where: { orgId }, orderBy: { number: 'desc' }, select: { number: true } });
      return tx.purchaseOrder.create({
        data: {
          orgId,
          branchId: body.branchId ?? null,
          supplierAccountId: body.supplierAccountId,
          number: (last?.number ?? 0) + 1,
          status: 'SENT',
          sentAt: new Date(),
          currency: org.currency,
          total: money(total),
          notes: body.notes ?? null,
          createdById: userId,
          expectedAt: new Date(Date.now() + connection.supplier.leadDays * 86_400_000),
          items: {
            create: lines.map((l) => ({
              supplierProductId: l.product.id,
              nameSnapshot: l.product.name,
              qty: D(l.qty),
              unitCost: money(toNumber(l.product.unitCost)),
            })),
          },
        },
        include: { items: true },
      });
    });

    // Best-effort: a mail failure must not undo a placed order.
    void notifySupplierOfOrder(body.supplierAccountId, order.number, org.name, total).catch((err) =>
      logger.error({ err, orderId: order.id }, 'supplier order notification failed'),
    );

    logger.info({ orgId, orderId: order.id, supplierAccountId: body.supplierAccountId, total }, '🛒 network order placed');
    ok(res, order, 201);
  }),
);

/**
 * Suggested reorder — the network's payoff for the shop. Anything at or below
 * its reorder level that a connected supplier actually sells, matched by
 * barcode then name, with the cheapest source first.
 */
networkRouter.get(
  '/suggested',
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;

    const [low, connections] = await Promise.all([
      prisma.product.findMany({
        where: { orgId, deletedAt: null, isActive: true, trackStock: true, NOT: { lowStockAt: null } },
        select: { id: true, name: true, barcode: true, stockQty: true, lowStockAt: true },
      }),
      prisma.supplierConnection.findMany({
        where: { orgId, status: 'ACTIVE' },
        select: { supplierAccountId: true, supplier: { select: { name: true } } },
      }),
    ]);

    const needed = low.filter((p) => p.lowStockAt !== null && p.stockQty.lte(p.lowStockAt));
    if (needed.length === 0 || connections.length === 0) return ok(res, []);

    const supplierIds = connections.map((c) => c.supplierAccountId);
    const offers = await prisma.supplierProduct.findMany({
      where: {
        supplierAccountId: { in: supplierIds },
        isActive: true,
        inStock: true,
        deletedAt: null,
        OR: [
          { barcode: { in: needed.map((n) => n.barcode).filter((b): b is string => Boolean(b)) } },
          { name: { in: needed.map((n) => n.name) } },
        ],
      },
      orderBy: { unitCost: 'asc' },
    });

    const supplierName = new Map(connections.map((c) => [c.supplierAccountId, c.supplier.name]));

    ok(res, needed.map((p) => {
      const matches = offers.filter(
        (o) => (p.barcode && o.barcode === p.barcode) || o.name.toLowerCase() === p.name.toLowerCase(),
      );
      return {
        product: { id: p.id, name: p.name, stockQty: toNumber(p.stockQty), lowStockAt: toNumber(p.lowStockAt!) },
        offers: matches.map((o) => ({
          supplierProductId: o.id,
          supplierAccountId: o.supplierAccountId,
          supplierName: supplierName.get(o.supplierAccountId) ?? '',
          unitCost: toNumber(o.unitCost),
          moq: toNumber(o.moq),
          unit: o.unit,
        })),
      };
    }).filter((r) => r.offers.length > 0));
  }),
);
