import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, ok } from '../../lib/http.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { requireCapability } from '../../middleware/org.js';
import { money } from '../../lib/money.js';
import { NotFound, PlanLimit, Conflict, BadRequest } from '../../lib/errors.js';
import { buildCombinations, attributeKey, type VariantOption } from '../../domain/variants.js';
import { extractInvoiceItems, extractProductsFromImages, shelfieEnabled } from '../../services/shelfie.js';
import { logger } from '../../lib/logger.js';
import { postStock, setStockLevel, resolveBranchId } from '../../domain/stock.js';

const productSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(180),
  categoryId: z.string().cuid().nullable().optional(),
  sku: z.string().trim().max(60).nullable().optional(),
  barcode: z.string().trim().max(60).nullable().optional(),
  price: z.coerce.number().nonnegative(),
  cost: z.coerce.number().nonnegative().default(0),
  taxRate: z.coerce.number().min(0).max(100).nullable().optional(),
  trackStock: z.boolean().default(false),
  stockQty: z.coerce.number().default(0),
  lowStockAt: z.coerce.number().nonnegative().nullable().optional(),
  unit: z.enum(['pc', 'kg', 'g', 'l', 'ml', 'm']).default('pc'),
  isActive: z.boolean().default(true),
});

const idParam = z.object({ id: z.string().cuid() });

const variantOptionSchema = z.object({
  name: z.string().trim().min(1).max(40),
  values: z.array(z.string().trim().min(1).max(60)).min(1).max(40),
});

export const productsRouter = Router();
productsRouter.use(requireAuth);

/**
 * Create every variant of a product at once.
 *
 * A clothing shop thinks in "T-Shirt, S/M/L, red and blue" — six things on the
 * shelf, entered once. Each combination becomes its own product row, so it
 * gets its own barcode, price and stock without the ledger knowing variants
 * exist. The parent is a folder: no stock, and the sale path refuses it.
 */
productsRouter.post(
  '/variants',
  requireRole('MANAGER'),
  requireCapability('stock.variants'),
  validate({
    body: productSchema.extend({
      options: z.array(variantOptionSchema).min(1).max(3),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    const body = req.body as z.infer<typeof productSchema> & { options: VariantOption[] };

    const combinations = buildCombinations(body.name, body.options);

    const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId }, include: { plan: true } });
    if (org.plan.maxProducts >= 0) {
      const count = await prisma.product.count({ where: { orgId, deletedAt: null } });
      // The parent counts too — it occupies a row and shows on the grid.
      if (count + combinations.length + 1 > org.plan.maxProducts) {
        throw PlanLimit(
          `That is ${combinations.length} variants, and the ${org.plan.name} plan allows ${org.plan.maxProducts} products. Upgrade to add them.`,
        );
      }
    }

    const created = await prisma.$transaction(async (tx) => {
      const parent = await tx.product.create({
        data: {
          orgId,
          name: body.name,
          categoryId: body.categoryId ?? null,
          price: money(body.price),
          cost: money(body.cost),
          taxRate: body.taxRate == null ? null : new Prisma.Decimal(body.taxRate),
          unit: body.unit,
          isActive: body.isActive,
          // A folder holds nothing. Stock lives on the children, and the
          // rollup for reporting is the sum of them.
          trackStock: false,
          stockQty: new Prisma.Decimal(0),
          variantOptions: body.options as never,
        },
      });

      await tx.product.createMany({
        data: combinations.map((combo) => ({
          orgId,
          parentId: parent.id,
          name: combo.name,
          categoryId: body.categoryId ?? null,
          price: money(body.price),
          cost: money(body.cost),
          taxRate: body.taxRate == null ? null : new Prisma.Decimal(body.taxRate),
          unit: body.unit,
          isActive: body.isActive,
          trackStock: body.trackStock,
          // Opening stock is per-variant and nobody has counted it yet; the
          // owner receives or counts each one. Seeding the same number into
          // every child would be a lie the ledger then has to carry.
          stockQty: new Prisma.Decimal(0),
          variantAttributes: combo.attributes as never,
        })),
      });

      return tx.product.findUniqueOrThrow({
        where: { id: parent.id },
        include: { variants: { orderBy: { name: 'asc' } } },
      });
    });

    logger.info({ orgId, parentId: created.id, variants: combinations.length }, 'variant product created');
    ok(res, created, 201);
  }),
);

/**
 * Add values to an existing variant product — a new colour arrives mid-season.
 *
 * Only the missing combinations are created, so calling this twice with the
 * same colour is a no-op rather than a duplicate shelf.
 */
productsRouter.post(
  '/:id/variants',
  requireRole('MANAGER'),
  requireCapability('stock.variants'),
  validate({ params: idParam, body: z.object({ options: z.array(variantOptionSchema).min(1).max(3) }) }),
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    const { options } = req.body as { options: VariantOption[] };

    const parent = await prisma.product.findFirst({
      where: { id: req.params.id!, orgId, deletedAt: null },
      include: { variants: { where: { deletedAt: null } } },
    });
    if (!parent) throw NotFound('Product');
    if (!parent.variantOptions) throw BadRequest(`"${parent.name}" does not have variants`);

    const combinations = buildCombinations(parent.name, options);
    const existing = new Set(
      parent.variants.map((v) => attributeKey((v.variantAttributes ?? {}) as Record<string, string>)),
    );
    const missing = combinations.filter((c) => !existing.has(c.key));

    if (missing.length === 0) {
      ok(res, { added: 0, parent });
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.product.createMany({
        data: missing.map((combo) => ({
          orgId,
          parentId: parent.id,
          name: combo.name,
          categoryId: parent.categoryId,
          price: parent.price,
          cost: parent.cost,
          taxRate: parent.taxRate,
          unit: parent.unit,
          trackStock: parent.variants[0]?.trackStock ?? false,
          stockQty: new Prisma.Decimal(0),
          variantAttributes: combo.attributes as never,
        })),
      });
      // The option list is what the picker renders, so it has to grow too.
      await tx.product.update({
        where: { id: parent.id },
        data: { variantOptions: options as never },
      });
    });

    ok(res, { added: missing.length }, 201);
  }),
);

/**
 * The POS bootstrap: full catalog in one call, cached into IndexedDB by the
 * terminal. Sell screens never wait on the network after this.
 */
productsRouter.get(
  '/bootstrap',
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    const [org, categories, products, registers, staff, customers] = await prisma.$transaction([
      prisma.organization.findUniqueOrThrow({
        where: { id: orgId },
        select: {
          id: true, slug: true, name: true, currency: true, timezone: true, language: true,
          taxRate: true, taxInclusive: true, receiptHeader: true, receiptFooter: true,
          address: true, phone: true, taxId: true, status: true, planCode: true,
        },
      }),
      prisma.category.findMany({ where: { orgId, deletedAt: null }, orderBy: { sortOrder: 'asc' } }),
      prisma.product.findMany({ where: { orgId, deletedAt: null, isActive: true }, orderBy: { name: 'asc' } }),
      prisma.register.findMany({ where: { orgId, isActive: true } }),
      prisma.orgUser.findMany({
        where: { orgId, deletedAt: null, isActive: true },
        select: { id: true, name: true, role: true },
      }),
      prisma.customer.findMany({
        where: { orgId, deletedAt: null },
        select: { id: true, name: true, phone: true, loyaltyPoints: true },
        take: 2000,
      }),
    ]);
    ok(res, { org, categories, products, registers, staff, customers, syncedAt: new Date().toISOString() });
  }),
);

productsRouter.get(
  '/',
  validate({
    query: z.object({
      search: z.string().trim().max(120).optional(),
      categoryId: z.string().cuid().optional(),
      lowStock: z.coerce.boolean().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    const q = req.query as { search?: string; categoryId?: string; lowStock?: boolean };
    const products = await prisma.product.findMany({
      where: {
        orgId,
        deletedAt: null,
        ...(q.categoryId ? { categoryId: q.categoryId } : {}),
        ...(q.search
          ? { OR: [{ name: { contains: q.search } }, { sku: { contains: q.search } }, { barcode: { contains: q.search } }] }
          : {}),
      },
      include: { category: { select: { id: true, name: true, color: true } } },
      orderBy: { name: 'asc' },
      take: 500,
    });
    const filtered = q.lowStock
      ? products.filter((p) => p.trackStock && p.lowStockAt !== null && p.stockQty.lte(p.lowStockAt))
      : products;
    ok(res, filtered);
  }),
);

productsRouter.post(
  '/',
  requireRole('MANAGER'),
  validate({ body: productSchema }),
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;

    // Plan enforcement — the FREE tier's product cap is the upgrade trigger.
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId }, include: { plan: true } });
    if (org.plan.maxProducts >= 0) {
      const count = await prisma.product.count({ where: { orgId, deletedAt: null } });
      if (count >= org.plan.maxProducts) {
        throw PlanLimit(`The ${org.plan.name} plan allows ${org.plan.maxProducts} products. Upgrade to add more.`);
      }
    }

    const body = req.body as z.infer<typeof productSchema>;
    if (body.sku) {
      const dupe = await prisma.product.findFirst({ where: { orgId, sku: body.sku, deletedAt: null } });
      if (dupe) throw Conflict(`SKU ${body.sku} is already used by "${dupe.name}"`);
    }

    const product = await prisma.$transaction(async (tx) => {
      const created = await tx.product.create({
        data: {
          orgId,
          ...body,
          price: money(body.price),
          cost: money(body.cost),
          taxRate: body.taxRate === null || body.taxRate === undefined ? null : new Prisma.Decimal(body.taxRate),
          // Opens empty; the posting below is what puts it on the shelf, so
          // the ledger explains the balance from the very first row.
          stockQty: new Prisma.Decimal(0),
          lowStockAt: body.lowStockAt === null || body.lowStockAt === undefined ? null : new Prisma.Decimal(body.lowStockAt),
        },
      });

      if (body.trackStock && body.stockQty !== 0) {
        const branchId = await resolveBranchId(tx, orgId);
        await postStock(tx, { orgId, branchId, userId: req.auth!.userId }, [
          { productId: created.id, qty: body.stockQty, type: 'ADJUST', note: 'Opening stock' },
        ]);
        return tx.product.findUniqueOrThrow({ where: { id: created.id } });
      }
      return created;
    });

    ok(res, product, 201);
  }),
);

productsRouter.patch(
  '/:id',
  requireRole('MANAGER'),
  validate({ params: idParam, body: productSchema.partial() }),
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    const existing = await prisma.product.findFirst({ where: { id: req.params.id!, orgId, deletedAt: null } });
    if (!existing) throw NotFound('Product');

    const body = req.body as Partial<z.infer<typeof productSchema>>;

    const product = await prisma.$transaction(async (tx) => {
      // `stockQty` is deliberately not settable here. Editing a product used
      // to be a way to change stock with no ledger row and no audit trail —
      // which is precisely how shrinkage gets quietly written off. A quantity
      // change is a stocktake (`POST /stock/count`) or an adjustment with a
      // reason (`POST /stock/adjust`), both of which leave a record.
      const { stockQty, ...editable } = body;

      await tx.product.update({
        where: { id: existing.id },
        data: {
          ...editable,
          ...(body.price !== undefined ? { price: money(body.price) } : {}),
          ...(body.cost !== undefined ? { cost: money(body.cost) } : {}),
        },
      });

      // A folder has no shelf. Stock belongs to the variant, and letting the
      // parent carry a number would double-count it in every valuation.
      if (stockQty !== undefined && existing.variantOptions) {
        throw BadRequest(`"${existing.name}" has variants — set stock on the size or colour, not the group`);
      }

      if (stockQty !== undefined && Number(stockQty) !== Number(existing.stockQty)) {
        const branchId = await resolveBranchId(tx, orgId);
        await setStockLevel(
          tx,
          { orgId, branchId, userId: req.auth!.userId },
          { productId: existing.id, counted: Number(stockQty), note: 'Set from product edit' },
        );
      }

      return tx.product.findUniqueOrThrow({ where: { id: existing.id } });
    });

    ok(res, product);
  }),
);

productsRouter.delete(
  '/:id',
  requireRole('MANAGER'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    const existing = await prisma.product.findFirst({ where: { id: req.params.id!, orgId, deletedAt: null } });
    if (!existing) throw NotFound('Product');
    // Soft delete — sale history keeps its snapshot either way.
    await prisma.product.update({ where: { id: existing.id }, data: { deletedAt: new Date(), isActive: false } });
    ok(res, { deleted: true });
  }),
);

// --- Shelfie: photo → draft catalog -----------------------------------------

productsRouter.post(
  '/shelfie',
  requireRole('MANAGER'),
  validate({
    body: z.object({
      // 'catalog' reads shelves/price lists → new products.
      // 'invoice' reads supplier invoices → goods received (Shelfie v2).
      mode: z.enum(['catalog', 'invoice']).default('catalog'),
      images: z
        .array(
          z.object({
            data: z.string().min(100).max(8_000_000), // ~6MB decoded
            mediaType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
          }),
        )
        .min(1, 'Add at least one photo')
        .max(4, 'Maximum 4 photos per scan'),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    const { mode, images } = req.body as {
      mode: 'catalog' | 'invoice';
      images: Parameters<typeof extractProductsFromImages>[0];
    };
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: orgId },
      select: { currency: true, language: true },
    });

    if (mode === 'invoice') {
      const result = await extractInvoiceItems(images, { currency: org.currency });
      return ok(res, result);
    }
    const result = await extractProductsFromImages(images, { currency: org.currency, language: org.language });
    ok(res, result);
  }),
);

/** Feature flag for the client — hides the Shelfie button when unconfigured. */
productsRouter.get('/shelfie/status', asyncHandler(async (_req, res) => ok(res, { enabled: shelfieEnabled() })));

/**
 * Bulk insert — the second half of Shelfie, also useful for CSV-style imports
 * later. Categories are created on demand by name; the plan cap is enforced
 * on the whole batch up front so the operator gets one clear message instead
 * of a half-imported catalog.
 */
productsRouter.post(
  '/bulk',
  requireRole('MANAGER'),
  validate({
    body: z.object({
      products: z
        .array(
          z.object({
            name: z.string().trim().min(1).max(180),
            price: z.coerce.number().nonnegative().max(99_999_999),
            categoryName: z.string().trim().max(80).nullable().optional(),
            barcode: z.string().trim().max(60).nullable().optional(),
          }),
        )
        .min(1)
        .max(300),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    const { products } = req.body as {
      products: Array<{ name: string; price: number; categoryName?: string | null; barcode?: string | null }>;
    };

    const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId }, include: { plan: true } });
    if (org.plan.maxProducts >= 0) {
      const count = await prisma.product.count({ where: { orgId, deletedAt: null } });
      if (count + products.length > org.plan.maxProducts) {
        throw PlanLimit(
          `Adding ${products.length} products would exceed the ${org.plan.name} plan limit of ${org.plan.maxProducts}. Upgrade to import them all.`,
        );
      }
    }

    // Resolve categories once per distinct name.
    const wantedCategories = [...new Set(products.map((p) => p.categoryName).filter((n): n is string => Boolean(n)))];
    const categoryIds = new Map<string, string>();
    for (const name of wantedCategories) {
      const existing = await prisma.category.findFirst({ where: { orgId, name, deletedAt: null } });
      const category = existing ?? (await prisma.category.create({ data: { orgId, name } }));
      categoryIds.set(name, category.id);
    }

    const created = await prisma.product.createMany({
      data: products.map((p) => ({
        orgId,
        name: p.name,
        price: money(p.price),
        barcode: p.barcode ?? null,
        categoryId: p.categoryName ? categoryIds.get(p.categoryName) ?? null : null,
      })),
    });

    logger.info({ orgId, created: created.count }, 'bulk product import');
    ok(res, { created: created.count }, 201);
  }),
);

// --- Barcode auto-fill via Open Food Facts ----------------------------------

productsRouter.get(
  '/lookup/:barcode',
  validate({ params: z.object({ barcode: z.string().regex(/^\d{6,14}$/, 'Barcode must be 6–14 digits') }) }),
  asyncHandler(async (req, res) => {
    const barcode = req.params.barcode!;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    try {
      const upstream = await fetch(
        `https://world.openfoodfacts.org/api/v2/product/${barcode}.json?fields=product_name,brands,quantity`,
        { signal: controller.signal, headers: { 'User-Agent': 'SillaraPOS/1.0 (hello@sillara.com)' } },
      );
      const json = (await upstream.json()) as {
        status: number;
        product?: { product_name?: string; brands?: string; quantity?: string };
      };
      if (json.status !== 1 || !json.product?.product_name) return ok(res, { found: false });
      const name = [json.product.brands?.split(',')[0], json.product.product_name, json.product.quantity]
        .filter(Boolean)
        .join(' ')
        .slice(0, 180);
      ok(res, { found: true, name });
    } catch {
      // Offline or upstream slow — autofill is a nicety, never an error.
      ok(res, { found: false });
    } finally {
      clearTimeout(timer);
    }
  }),
);

// --- categories -------------------------------------------------------------

productsRouter.post(
  '/categories',
  requireRole('MANAGER'),
  validate({ body: z.object({ name: z.string().trim().min(1).max(80), color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#6366F1') }) }),
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    const category = await prisma.category.create({
      data: { orgId, name: req.body.name as string, color: req.body.color as string },
    });
    ok(res, category, 201);
  }),
);
