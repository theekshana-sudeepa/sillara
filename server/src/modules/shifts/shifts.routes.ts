import { Router } from 'express';
import { z } from 'zod';
import { prisma, isUniqueViolation } from '../../lib/prisma.js';
import { asyncHandler, ok } from '../../lib/http.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { money, toNumber, D } from '../../lib/money.js';
import { NotFound, Conflict } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { resolveBranchId } from '../../domain/stock.js';

/**
 * Shifts — cash-drawer sessions.
 *
 * Open with a float, sell, close by counting the drawer. `variance` is the
 * number that matters: counted − expected. Negative means the till is short.
 * Every sale made while a shift is open carries its `shiftId`, so the close
 * report is computed from the sales themselves, never from a running counter
 * a device could get wrong offline.
 *
 * One OPEN shift per register at a time — enforced on open, not by a unique
 * index, because a register is optional (a phone till has none).
 */

export const shiftsRouter = Router();
shiftsRouter.use(requireAuth);

/** The shift this device should be selling into, if any. */
shiftsRouter.get(
  '/current',
  validate({ query: z.object({ registerId: z.string().cuid().optional() }) }),
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    const registerId = (req.query as { registerId?: string }).registerId;
    const shift = await prisma.shift.findFirst({
      where: { orgId, status: 'OPEN', ...(registerId ? { registerId } : {}) },
      orderBy: { openedAt: 'desc' },
      include: { register: { select: { name: true } }, branch: { select: { name: true } } },
    });
    ok(res, shift);
  }),
);

shiftsRouter.post(
  '/open',
  validate({
    body: z.object({
      registerId: z.string().cuid().nullable().optional(),
      branchId: z.string().cuid().nullable().optional(),
      openingFloat: z.coerce.number().nonnegative().max(99_999_999).default(0),
      note: z.string().trim().max(255).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { orgId, userId } = req.auth!;
    const { registerId, branchId, openingFloat, note } = req.body as {
      registerId?: string | null;
      branchId?: string | null;
      openingFloat: number;
      note?: string;
    };

    const shift = await prisma.$transaction(async (tx) => {
      // Same branch resolution as a sale: default when unspecified, and proven
      // to belong to this org when it is. A shift left on a null branch while
      // its sales landed in the default one meant nothing could match the two
      // up — a refund could not find the drawer it was supposed to come out of.
      const branch = await resolveBranchId(tx, orgId, branchId);
      return tx.shift.create({
        data: {
          orgId,
          registerId: registerId ?? null,
          branchId: branch,
          // Populated only while open — UNIQUE(orgId, openRegisterKey) is what
          // actually prevents a second drawer on the same register. The
          // sentinel keeps the rule applying to tills that have no register.
          openRegisterKey: registerId ?? '__no_register__',
          openingFloat: money(openingFloat),
          openedById: userId,
          note: note ?? null,
        },
      });
    }).catch((err: unknown) => {
      // Lost the race rather than checked-and-lost it: the database refused
      // the second insert, so only one drawer is ever open.
      if (isUniqueViolation(err)) {
        throw Conflict('A shift is already open on this register — close it first');
      }
      throw err;
    });

    logger.info({ orgId, shiftId: shift.id }, 'shift opened');
    ok(res, shift, 201);
  }),
);

/**
 * Preview the close numbers without committing — what the cashier sees while
 * counting the drawer, so the expected figure is on screen beside the cash.
 */
shiftsRouter.get(
  '/:id/summary',
  validate({ params: z.object({ id: z.string().cuid() }) }),
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    ok(res, await buildSummary(orgId, req.params.id!));
  }),
);

shiftsRouter.post(
  '/:id/close',
  validate({
    params: z.object({ id: z.string().cuid() }),
    body: z.object({
      countedCash: z.coerce.number().nonnegative().max(99_999_999),
      note: z.string().trim().max(255).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { orgId, userId } = req.auth!;
    const { countedCash, note } = req.body as { countedCash: number; note?: string };

    const summary = await buildSummary(orgId, req.params.id!);
    if (summary.shift.status === 'CLOSED') throw Conflict('This shift is already closed');

    const expected = summary.expectedCash;
    const variance = Math.round((countedCash - expected) * 100) / 100;

    const closed = await prisma.shift.update({
      where: { id: req.params.id! },
      data: {
        status: 'CLOSED',
        // Frees the register for the next shift — see the UNIQUE index.
        openRegisterKey: null,
        expectedCash: money(expected),
        countedCash: money(countedCash),
        variance: money(variance),
        closedById: userId,
        closedAt: new Date(),
        note: note ?? summary.shift.note,
      },
    });

    logger.info({ orgId, shiftId: closed.id, variance }, variance === 0 ? 'shift closed balanced' : 'shift closed with variance');
    ok(res, { shift: closed, summary: { ...summary, countedCash, variance } });
  }),
);

shiftsRouter.get(
  '/',
  requireRole('MANAGER'),
  validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }) }),
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    const shifts = await prisma.shift.findMany({
      where: { orgId },
      orderBy: { openedAt: 'desc' },
      take: Number(req.query.limit),
      include: { register: { select: { name: true } }, branch: { select: { name: true } } },
    });
    ok(res, shifts);
  }),
);

/** Expected cash = float + cash sales − cash change given, plus a tender split. */
async function buildSummary(orgId: string, shiftId: string) {
  const shift = await prisma.shift.findFirst({ where: { id: shiftId, orgId } });
  if (!shift) throw NotFound('Shift');

  // Tender split comes from the payment rows, not from the sale's headline
  // tender. A bill settled half in cash and half by card contributed only its
  // cash half to the drawer — reading the enum counted the whole thing and
  // told the cashier they were short by the card portion.
  const [byTender, agg, count] = await prisma.$transaction([
    prisma.salePayment.groupBy({
      by: ['type'],
      where: { orgId, sale: { shiftId, status: 'COMPLETED' } },
      orderBy: { type: 'asc' },
      _sum: { amount: true, change: true, tendered: true },
      _count: true,
    }),
    prisma.sale.aggregate({
      where: { orgId, shiftId, status: 'COMPLETED' },
      _sum: { total: true, discount: true, tax: true, loyaltyDiscount: true },
    }),
    prisma.sale.count({ where: { orgId, shiftId, status: 'COMPLETED', kind: 'SALE' } }),
  ]);

  // Refund payments are negative, so cash paid back out of the drawer nets
  // itself off here without a special case.
  const cashRow = byTender.find((t) => t.type === 'CASH');
  const cashSales = toNumber(cashRow?._sum?.amount);
  const expectedCash = Math.round((toNumber(shift.openingFloat) + cashSales) * 100) / 100;

  return {
    shift,
    salesCount: count,
    gross: toNumber(agg._sum.total),
    discounts: toNumber(agg._sum.discount),
    loyaltyDiscounts: toNumber(agg._sum.loyaltyDiscount),
    tax: toNumber(agg._sum.tax),
    openingFloat: toNumber(shift.openingFloat),
    cashSales,
    expectedCash,
    byTender: byTender.map((t) => ({ tender: t.type, total: toNumber(t._sum?.amount), count: t._count })),
  };
}

export { buildSummary };
export const shiftMoney = D;
