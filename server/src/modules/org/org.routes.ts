import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, ok } from '../../lib/http.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { invalidateOrgCache } from '../../middleware/org.js';
import { canWrite } from '../../services/lifecycle.js';
import { Prisma, BusinessType } from '@prisma/client';
import { BadRequest, PlanLimit } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { resolveCapabilities } from '../../capabilities/resolve.js';
import { CAPABILITIES, CAPABILITY_IDS, isCapabilityId, type CapabilityId } from '../../capabilities/registry.js';
import { templateFor, offeredTemplates } from '../../capabilities/templates.js';
import { seedCatalog } from '../../capabilities/seed.js';

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

/**
 * The settings screen for what this shop can do.
 *
 * Returns the whole catalogue rather than only what is on, because the screen
 * has to show what could be switched on — including the things the plan does
 * not cover, which is where an upgrade gets sold.
 */
orgRouter.get(
  '/capabilities',
  asyncHandler(async (req, res) => {
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: req.auth!.orgId },
      include: { plan: true },
    });

    const planFeatures = (org.plan.features as string[] | null) ?? [];
    const resolved = resolveCapabilities({
      businessType: org.businessType,
      overrides: org.capabilities,
      planFeatures,
      layout: org.layout,
    });
    const active = new Set(resolved.active);
    const preset = new Set(templateFor(org.businessType).capabilities);
    const plan = new Set(planFeatures);

    ok(res, {
      businessType: org.businessType,
      // Only what has actually shipped. A preset whose headline feature does
      // not exist yet is a churn risk dressed as a feature list.
      businessTypes: offeredTemplates(),
      layout: resolved.layout,
      capabilities: CAPABILITY_IDS.map((id) => {
        const def = CAPABILITIES[id];
        // Not the same question `/auth/me` answers. There, `blockedByPlan`
        // means "your preset wanted this and your plan refused". Here every
        // row needs "could you ever switch this on?" — including rows the
        // preset never asked for, because that is where the upgrade is sold.
        const requiresUpgrade = Boolean(def.planFeature) && !plan.has(def.planFeature!);
        return {
          id,
          label: def.label,
          description: def.description,
          core: Boolean(def.core),
          active: active.has(id),
          requiresUpgrade,
          /// True when it is on because of the preset rather than a choice —
          /// so the screen can say "included with Pharmacy" instead of
          /// implying the owner turned it on themselves.
          fromPreset: preset.has(id),
          requires: def.requires ?? [],
        };
      }),
    });
  }),
);

/**
 * Switch a capability on or off.
 *
 * Disabling hides the module and stops the API answering for it. It never
 * deletes anything: a pharmacy that turns batches off for a month and back on
 * finds its batches exactly where it left them. Data written by a module
 * outlives the switch, always.
 */
orgRouter.patch(
  '/capabilities',
  requireRole('OWNER'),
  validate({
    body: z.object({
      capability: z.string().refine(isCapabilityId, 'Unknown capability'),
      enabled: z.boolean(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { orgId, userId } = req.auth!;
    const { capability, enabled } = req.body as { capability: CapabilityId; enabled: boolean };

    if (CAPABILITIES[capability].core) {
      throw BadRequest(`${CAPABILITIES[capability].label} is part of every till and cannot be switched off`);
    }

    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: orgId },
      include: { plan: true },
    });

    const current = (org.capabilities ?? {}) as { enabled?: string[]; disabled?: string[] };
    const overrides = {
      enabled: (current.enabled ?? []).filter((id) => id !== capability),
      disabled: (current.disabled ?? []).filter((id) => id !== capability),
    };
    // Recorded as an explicit choice either way, so a later change of business
    // type re-applies the preset without quietly undoing this.
    if (enabled) overrides.enabled.push(capability);
    else overrides.disabled.push(capability);

    const resolved = resolveCapabilities({
      businessType: org.businessType,
      overrides,
      planFeatures: (org.plan.features as string[] | null) ?? [],
      layout: org.layout,
    });

    if (enabled && !resolved.active.includes(capability)) {
      const def = CAPABILITIES[capability];
      // Entitlement is checked before dependencies, deliberately. Loyalty
      // needs Customers, and on a free plan Customers is itself unavailable —
      // telling someone to "switch on Customers first" sends them to a switch
      // they cannot throw either. The honest answer is that the plan is the
      // obstacle.
      if (resolved.blockedByPlan.includes(capability)) {
        throw PlanLimit(`${def.label} is not included in the ${org.plan.name} plan. Upgrade to switch it on.`);
      }
      const unmet = (def.requires ?? []).filter((dep) => !resolved.active.includes(dep));
      if (unmet.length > 0) {
        const blocked = unmet.filter((dep) => resolved.blockedByPlan.includes(dep));
        if (blocked.length > 0) {
          throw PlanLimit(
            `${def.label} needs ${blocked.map((d) => CAPABILITIES[d].label).join(' and ')}, ` +
              `which the ${org.plan.name} plan does not include.`,
          );
        }
        throw BadRequest(`Switch on ${unmet.map((d) => CAPABILITIES[d].label).join(' and ')} first`);
      }
      throw PlanLimit(`${def.label} is not included in the ${org.plan.name} plan. Upgrade to switch it on.`);
    }

    await prisma.organization.update({ where: { id: orgId }, data: { capabilities: overrides } });
    invalidateOrgCache(orgId);
    await audit({
      orgId,
      actorId: userId,
      action: enabled ? 'capability.enabled' : 'capability.disabled',
      entity: 'Organization',
      entityId: orgId,
      detail: { capability },
      ip: req.ip,
    });

    ok(res, { capabilities: resolved.active, blockedByPlan: resolved.blockedByPlan });
  }),
);

/**
 * Change the preset.
 *
 * Applies a different capability set without discarding what the owner chose:
 * their explicit switches survive, because overrides were never merged into
 * the preset in the first place. Owners misclassify themselves constantly —
 * "General Retail" until they discover they needed expiry dates — so this has
 * to be a safe, reversible thing to do rather than a decision made once at
 * signup and regretted.
 */
orgRouter.patch(
  '/business-type',
  requireRole('OWNER'),
  validate({
    body: z.object({
      businessType: z.nativeEnum(BusinessType),
      /// Write this preset's starter categories. Ignored when the shop already
      /// has a catalogue — sample items must never appear among real stock.
      seedCatalog: z.boolean().default(false),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { orgId, userId } = req.auth!;
    const { businessType, seedCatalog: shouldSeed } = req.body as {
      businessType: BusinessType;
      seedCatalog: boolean;
    };

    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: orgId },
      include: { plan: true },
    });
    const planFeatures = (org.plan.features as string[] | null) ?? [];

    const before = resolveCapabilities({
      businessType: org.businessType,
      overrides: org.capabilities,
      planFeatures,
      layout: org.layout,
    });
    // Resolved WITHOUT the stored layout on purpose. Provisioning writes a
    // layout, and `resolveCapabilities` prefers a stored one over the
    // template's — so passing it here would mean a shop could never change
    // its shell again. Someone picking a new trade is asking for its shape.
    const after = resolveCapabilities({
      businessType,
      overrides: org.capabilities,
      planFeatures,
    });

    const seeded = await prisma.$transaction(async (tx) => {
      await tx.organization.update({
        where: { id: orgId },
        // The layout follows the new preset. Provisioning wrote the first one,
        // and someone changing type in the wizard is asking for the new shape.
        data: { businessType, layout: after.layout as never },
      });
      return shouldSeed
        ? seedCatalog(tx, {
            orgId,
            businessType,
            currency: org.currency,
            // Clears the previous preset's untouched samples so a pharmacy
            // does not open next to Drinks and Snacks.
            replacing: org.businessType,
            force: true,
          })
        : { categories: 0, products: 0, removed: 0, skipped: true };
    });
    invalidateOrgCache(orgId);
    await audit({
      orgId,
      actorId: userId,
      action: 'business_type.changed',
      entity: 'Organization',
      entityId: orgId,
      detail: { from: org.businessType, to: businessType },
      ip: req.ip,
    });

    ok(res, {
      businessType,
      capabilities: after.active,
      blockedByPlan: after.blockedByPlan,
      layout: after.layout,
      seeded,
      // The diff, so the UI can say what is about to change rather than
      // silently rearranging someone's till.
      added: after.active.filter((id) => !before.active.includes(id)),
      removed: before.active.filter((id) => !after.active.includes(id)),
    });
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
