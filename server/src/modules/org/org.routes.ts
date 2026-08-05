import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, ok } from '../../lib/http.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { invalidateOrgCache } from '../../middleware/org.js';
import { canWrite } from '../../services/lifecycle.js';
import { Prisma } from '@prisma/client';

const settingsSchema = z.object({
  name: z.string().trim().min(2).max(180).optional(),
  language: z.enum(['en', 'si', 'ta']).optional(),
  timezone: z.string().trim().max(64).optional(),
  receiptHeader: z.string().trim().max(255).nullable().optional(),
  receiptFooter: z.string().trim().max(255).nullable().optional(),
  address: z.string().trim().max(255).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  taxId: z.string().trim().max(60).nullable().optional(),
  taxRate: z.coerce.number().min(0).max(100).optional(),
  taxInclusive: z.boolean().optional(),
  // Loyalty economics (P3) — owner-tunable, applied server-side on every sale.
  loyaltyEnabled: z.boolean().optional(),
  loyaltyEarnRate: z.coerce.number().min(0).max(1000).optional(),
  loyaltyRedeemValue: z.coerce.number().min(0).max(1000).optional(),
  loyaltyMinRedeem: z.coerce.number().int().min(0).max(1_000_000).optional(),
  // The end-of-day email (P5). On by default; one toggle, no preference tree.
  dailyDigestEnabled: z.boolean().optional(),
});

export const orgRouter = Router();
orgRouter.use(requireAuth);

orgRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: req.auth!.orgId },
      include: { plan: true },
    });
    ok(res, org);
  }),
);

orgRouter.patch(
  '/',
  requireRole('OWNER'),
  validate({ body: settingsSchema }),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof settingsSchema>;
    const org = await prisma.organization.update({
      where: { id: req.auth!.orgId },
      data: {
        ...body,
        ...(body.taxRate !== undefined ? { taxRate: new Prisma.Decimal(body.taxRate) } : {}),
        ...(body.loyaltyEarnRate !== undefined ? { loyaltyEarnRate: new Prisma.Decimal(body.loyaltyEarnRate) } : {}),
        ...(body.loyaltyRedeemValue !== undefined ? { loyaltyRedeemValue: new Prisma.Decimal(body.loyaltyRedeemValue) } : {}),
      },
    });
    // Timezone and currency are cached per request; a settings save must be
    // visible on the next call, not five seconds later.
    invalidateOrgCache(org.id);
    ok(res, org);
  }),
);

/**
 * Billing state, in the words a shop owner uses.
 *
 * The POS shows this as a banner the moment anything is not "fine", because a
 * 402 on a sale with no explanation is how you get a furious phone call
 * instead of a payment. Every field here answers a question they would
 * otherwise have to ask: am I paid up, until when, what happens if I don't,
 * and can I still sell right now?
 */
orgRouter.get(
  '/billing',
  asyncHandler(async (req, res) => {
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: req.auth!.orgId },
      select: {
        status: true,
        planCode: true,
        currency: true,
        trialEndsAt: true,
        currentPeriodEnd: true,
        graceUntil: true,
        creditMonths: true,
        billingProvider: true,
        plan: { select: { name: true, priceUsd: true, priceLkr: true, maxTerminals: true, maxProducts: true, maxUsers: true } },
      },
    });

    const now = new Date();
    const until = org.status === 'TRIAL' ? org.trialEndsAt : org.currentPeriodEnd;
    const daysLeft = until ? Math.max(0, Math.ceil((until.getTime() - now.getTime()) / 86_400_000)) : null;

    ok(res, {
      status: org.status,
      canSell: canWrite(org.status),
      plan: { code: org.planCode, ...org.plan },
      currency: org.currency,
      renewsAt: until,
      daysLeft,
      graceUntil: org.graceUntil,
      graceDaysLeft: org.graceUntil ? Math.max(0, Math.ceil((org.graceUntil.getTime() - now.getTime()) / 86_400_000)) : null,
      creditMonths: org.creditMonths,
      provider: org.billingProvider,
      message: billingMessage(org.status, daysLeft, org.creditMonths),
    });
  }),
);

function billingMessage(status: string, daysLeft: number | null, credits: number): string | null {
  switch (status) {
    case 'TRIAL':
      return daysLeft === null
        ? null
        : daysLeft <= 3
          ? `Your trial ends in ${daysLeft} ${daysLeft === 1 ? 'day' : 'days'}. Add a payment method to keep selling.`
          : `${daysLeft} days left in your trial.`;
    case 'PAST_DUE':
      return 'We could not take payment. Your till still works — update your card to avoid a pause.';
    case 'SUSPENDED':
      return 'Selling is paused. Your data is safe and reports still work. One payment brings the till back.';
    case 'CANCELLED':
      return 'This shop is closed. Reactivate any time — nothing has been deleted.';
    case 'ACTIVE':
      return credits > 0 ? `${credits} free ${credits === 1 ? 'month' : 'months'} from referrals waiting to be used.` : null;
    default:
      return null;
  }
}
