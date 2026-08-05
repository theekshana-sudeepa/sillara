import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, ok } from '../../lib/http.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { money, toNumber, D } from '../../lib/money.js';
import { NotFound, BadRequest } from '../../lib/errors.js';

/**
 * Loyalty — points earned on spend, redeemed as a discount.
 *
 * The economics live on the org, not in code:
 *   loyaltyEarnRate    points per 1 currency unit spent
 *   loyaltyRedeemValue currency value of 1 point
 *   loyaltyMinRedeem   points a customer must hold before spending any
 *
 * `Customer.loyaltyPoints` is a cached balance; `loyalty_transactions` is the
 * append-only truth. Same shape as the stock ledger — one place to audit,
 * one place to rebuild from.
 *
 * Earning happens server-side during sale sync (see sales.routes), never on
 * the device: points are money, and a device clock or a stale rate must not
 * be able to mint them.
 */

export const loyaltyRouter = Router();
loyaltyRouter.use(requireAuth);

/** What a cashier needs at the till: balance, cash value, spendable now? */
loyaltyRouter.get(
  '/balance/:customerId',
  validate({ params: z.object({ customerId: z.string().cuid() }) }),
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    const [customer, org] = await Promise.all([
      prisma.customer.findFirst({
        where: { id: req.params.customerId!, orgId, deletedAt: null },
        select: { id: true, name: true, phone: true, loyaltyPoints: true },
      }),
      prisma.organization.findUniqueOrThrow({
        where: { id: orgId },
        select: { loyaltyEnabled: true, loyaltyRedeemValue: true, loyaltyMinRedeem: true, currency: true },
      }),
    ]);
    if (!customer) throw NotFound('Customer');

    const points = toNumber(customer.loyaltyPoints);
    ok(res, {
      customer,
      points,
      value: Math.round(points * toNumber(org.loyaltyRedeemValue) * 100) / 100,
      canRedeem: org.loyaltyEnabled && points >= org.loyaltyMinRedeem,
      minRedeem: org.loyaltyMinRedeem,
      currency: org.currency,
      enabled: org.loyaltyEnabled,
    });
  }),
);

loyaltyRouter.get(
  '/history/:customerId',
  validate({
    params: z.object({ customerId: z.string().cuid() }),
    query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
  }),
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    const txns = await prisma.loyaltyTransaction.findMany({
      where: { orgId, customerId: req.params.customerId! },
      orderBy: { createdAt: 'desc' },
      take: Number(req.query.limit),
      include: { sale: { select: { number: true } } },
    });
    ok(res, txns);
  }),
);

/** Manual correction — goodwill points, or clawing back a mistake. */
loyaltyRouter.post(
  '/adjust',
  requireRole('MANAGER'),
  validate({
    body: z.object({
      customerId: z.string().cuid(),
      points: z.coerce.number().gte(-1_000_000).lte(1_000_000).refine((n) => n !== 0, 'Adjustment cannot be zero'),
      note: z.string().trim().min(2, 'Say why').max(255),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    const { customerId, points, note } = req.body as { customerId: string; points: number; note: string };

    const customer = await prisma.customer.findFirst({ where: { id: customerId, orgId, deletedAt: null } });
    if (!customer) throw NotFound('Customer');
    if (points < 0 && toNumber(customer.loyaltyPoints) + points < 0) {
      throw BadRequest('That would take the balance below zero');
    }

    const [updated] = await prisma.$transaction([
      prisma.customer.update({ where: { id: customerId }, data: { loyaltyPoints: { increment: points } } }),
      prisma.loyaltyTransaction.create({
        data: { orgId, customerId, type: 'ADJUST', points: money(points), note },
      }),
    ]);

    ok(res, { customerId, points: toNumber(updated.loyaltyPoints) });
  }),
);

/** Top customers by points — the "who are my regulars?" list. */
loyaltyRouter.get(
  '/top',
  validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }) }),
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    const customers = await prisma.customer.findMany({
      where: { orgId, deletedAt: null, loyaltyPoints: { gt: 0 } },
      orderBy: { loyaltyPoints: 'desc' },
      take: Number(req.query.limit),
      select: { id: true, name: true, phone: true, loyaltyPoints: true },
    });
    ok(res, customers);
  }),
);

/**
 * The maths itself lives in loyalty.logic.ts — no express, no prisma, so it
 * unit-tests without a database. Re-exported here so the sale path keeps one
 * obvious import.
 */
export { computeLoyalty } from './loyalty.logic.js';
export type { LoyaltyOutcome } from './loyalty.logic.js';

export const loyaltyDecimal = D;
