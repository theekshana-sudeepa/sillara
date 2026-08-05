import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, ok } from '../../lib/http.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { toNumber } from '../../lib/money.js';
import { NotFound, Conflict, PlanLimit, BadRequest } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { postStock } from '../../domain/stock.js';

/**
 * Branches — multi-location, gated to plans whose feature list includes
 * `multi_branch` (Pro). Every org has exactly one branch from provisioning,
 * so a single-shop tenant never encounters the concept; adding a second is
 * what upgrades them.
 */

export const branchesRouter = Router();
branchesRouter.use(requireAuth);

branchesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    const branches = await prisma.branch.findMany({
      where: { orgId, deletedAt: null },
      orderBy: [{ isDefault: 'desc' }, { code: 'asc' }],
      include: { _count: { select: { registers: true, sales: true } } },
    });
    ok(res, branches);
  }),
);

branchesRouter.post(
  '/',
  requireRole('OWNER'),
  validate({
    body: z.object({
      name: z.string().trim().min(2).max(120),
      address: z.string().trim().max(255).nullable().optional(),
      phone: z.string().trim().max(40).nullable().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId }, include: { plan: true } });

    const features = (org.plan.features as string[] | null) ?? [];
    if (!features.includes('multi_branch')) {
      throw PlanLimit(`Multiple branches are a Pro feature. Upgrade from ${org.plan.name} to open another location.`);
    }

    const count = await prisma.branch.count({ where: { orgId, deletedAt: null } });
    const branch = await prisma.branch.create({
      data: {
        orgId,
        name: (req.body as { name: string }).name,
        code: `BR-${String(count + 1).padStart(2, '0')}`,
        address: (req.body as { address?: string | null }).address ?? null,
        phone: (req.body as { phone?: string | null }).phone ?? null,
        isDefault: count === 0,
      },
    });

    logger.info({ orgId, branchId: branch.id }, 'branch opened');
    ok(res, branch, 201);
  }),
);

branchesRouter.patch(
  '/:id',
  requireRole('OWNER'),
  validate({
    params: z.object({ id: z.string().cuid() }),
    body: z.object({
      name: z.string().trim().min(2).max(120).optional(),
      address: z.string().trim().max(255).nullable().optional(),
      phone: z.string().trim().max(40).nullable().optional(),
      isActive: z.boolean().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    const existing = await prisma.branch.findFirst({ where: { id: req.params.id!, orgId, deletedAt: null } });
    if (!existing) throw NotFound('Branch');
    if ((req.body as { isActive?: boolean }).isActive === false && existing.isDefault) {
      throw Conflict('The main branch cannot be deactivated');
    }
    ok(res, await prisma.branch.update({ where: { id: existing.id }, data: req.body as never }));
  }),
);

/** Per-branch stock for one product — "who has the milk powder?" */
branchesRouter.get(
  '/stock/:productId',
  validate({ params: z.object({ productId: z.string().cuid() }) }),
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    const rows = await prisma.branchStock.findMany({
      where: { orgId, productId: req.params.productId! },
      include: { branch: { select: { id: true, name: true, code: true } } },
    });
    ok(res, rows.map((r) => ({ branch: r.branch, qty: toNumber(r.qty), lowStockAt: r.lowStockAt ? toNumber(r.lowStockAt) : null })));
  }),
);

/**
 * Transfer stock between branches. Two ledger rows, one transaction — the
 * org-wide rollup is untouched because nothing left the business.
 */
branchesRouter.post(
  '/transfer',
  requireRole('MANAGER'),
  validate({
    body: z.object({
      fromBranchId: z.string().cuid(),
      toBranchId: z.string().cuid(),
      productId: z.string().cuid(),
      qty: z.coerce.number().positive().max(999_999),
      note: z.string().trim().max(255).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { orgId, userId } = req.auth!;
    const { fromBranchId, toBranchId, productId, qty, note } = req.body as {
      fromBranchId: string;
      toBranchId: string;
      productId: string;
      qty: number;
      note?: string;
    };
    if (fromBranchId === toBranchId) throw BadRequest('Pick two different branches');

    const [from, to, product] = await Promise.all([
      prisma.branch.findFirst({ where: { id: fromBranchId, orgId, deletedAt: null } }),
      prisma.branch.findFirst({ where: { id: toBranchId, orgId, deletedAt: null } }),
      prisma.product.findFirst({ where: { id: productId, orgId, deletedAt: null } }),
    ]);
    if (!from || !to) throw NotFound('Branch');
    if (!product) throw NotFound('Product');

    const label = note ?? `${from.name} → ${to.name}`;
    await prisma.$transaction(async (tx) => {
      // Lock the product before reading the source shelf. Checking stock
      // outside the transaction lets two transfers each see enough and both
      // proceed, sending more than the branch holds.
      await tx.$queryRaw`SELECT id FROM products WHERE id = ${productId} FOR UPDATE`;

      const source = await tx.branchStock.findUnique({
        where: { branchId_productId: { branchId: fromBranchId, productId } },
        select: { qty: true },
      });
      if (!source || toNumber(source.qty) < qty) {
        throw BadRequest(`${from.name} only has ${source ? toNumber(source.qty) : 0} in stock`);
      }

      // Two postings, two branches. Neither moves the org rollup — nothing
      // left the business, it just changed shelf.
      await postStock(tx, { orgId, branchId: fromBranchId, userId }, [
        { productId, qty: -qty, type: 'TRANSFER_OUT', note: label },
      ]);
      await postStock(tx, { orgId, branchId: toBranchId, userId }, [
        { productId, qty, type: 'TRANSFER_IN', note: label },
      ]);
    });

    logger.info({ orgId, productId, qty, fromBranchId, toBranchId }, 'stock transferred');
    ok(res, { transferred: qty, from: from.name, to: to.name });
  }),
);

/** Consolidated performance across locations — the HQ view. */
branchesRouter.get(
  '/performance',
  requireRole('MANAGER'),
  validate({ query: z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }) }),
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    const since = new Date(Date.now() - Number(req.query.days) * 86_400_000);

    const [branches, grouped] = await Promise.all([
      prisma.branch.findMany({ where: { orgId, deletedAt: null }, select: { id: true, name: true, code: true } }),
      prisma.sale.groupBy({
        by: ['branchId'],
        where: { orgId, status: 'COMPLETED', soldAt: { gte: since } },
        _sum: { total: true },
        _count: true,
      }),
    ]);

    ok(res, {
      days: Number(req.query.days),
      branches: branches.map((b) => {
        const row = grouped.find((g) => g.branchId === b.id);
        return { ...b, sales: row?._count ?? 0, revenue: toNumber(row?._sum.total) };
      }),
    });
  }),
);
