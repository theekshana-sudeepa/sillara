import type { BillingProvider, Organization, PlanCode } from '@prisma/client';
import { prisma, isUniqueViolation } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { env } from '../config/env.js';
import { enqueue, flushEmails } from './email/outbox.js';
import { activationEmail } from './email/templates.js';
import { addMonths } from './lifecycle.js';
import { awardReferral } from '../modules/referrals/referrals.routes.js';
import { Prisma } from '@prisma/client';

/**
 * ---------------------------------------------------------------------------
 * THE PROVISIONER — Sillara's entire competitive wedge lives in this file.
 * ---------------------------------------------------------------------------
 * Contract: from "payment confirmed" (or free signup) to "owner is inside a
 * working shop" in ONE unattended pass, sub-second on the database side.
 * Every manual step added here is the moat leaking.
 *
 * Flow:
 *   signup → org created as PENDING (holds name/country/currency/plan)
 *   FREE plan          → provision() called inline, instantly
 *   paid plan          → provider webhook (Paddle/PayHere) → provision()
 *   provision() is idempotent: replayed webhooks re-mint the magic link at
 *   most, they never duplicate the org, the seed data or the counter.
 */

// Country → sensible defaults. Everything is overridable in the wizard;
// wrong defaults cost seconds, missing defaults cost signups.
const COUNTRY_DEFAULTS: Record<string, { currency: string; timezone: string; language: string }> = {
  LK: { currency: 'LKR', timezone: 'Asia/Colombo', language: 'en' },
  IN: { currency: 'INR', timezone: 'Asia/Kolkata', language: 'en' },
  BD: { currency: 'BDT', timezone: 'Asia/Dhaka', language: 'en' },
  NP: { currency: 'NPR', timezone: 'Asia/Kathmandu', language: 'en' },
  PK: { currency: 'PKR', timezone: 'Asia/Karachi', language: 'en' },
  AE: { currency: 'AED', timezone: 'Asia/Dubai', language: 'en' },
  SG: { currency: 'SGD', timezone: 'Asia/Singapore', language: 'en' },
  MY: { currency: 'MYR', timezone: 'Asia/Kuala_Lumpur', language: 'en' },
  AU: { currency: 'AUD', timezone: 'Australia/Sydney', language: 'en' },
  GB: { currency: 'GBP', timezone: 'Europe/London', language: 'en' },
  US: { currency: 'USD', timezone: 'America/New_York', language: 'en' },
  CA: { currency: 'CAD', timezone: 'America/Toronto', language: 'en' },
  KE: { currency: 'KES', timezone: 'Africa/Nairobi', language: 'en' },
  NG: { currency: 'NGN', timezone: 'Africa/Lagos', language: 'en' },
  ZA: { currency: 'ZAR', timezone: 'Africa/Johannesburg', language: 'en' },
  PH: { currency: 'PHP', timezone: 'Asia/Manila', language: 'en' },
  ID: { currency: 'IDR', timezone: 'Asia/Jakarta', language: 'en' },
};

export const defaultsForCountry = (country: string) =>
  COUNTRY_DEFAULTS[country.toUpperCase()] ?? { currency: 'USD', timezone: 'Etc/UTC', language: 'en' };

/** Starter catalog — the shop must LOOK alive the second the owner walks in. */
const SAMPLE_CATALOG = [
  { category: 'Drinks', color: '#0EA5E9', items: [{ name: 'Water Bottle 500ml', price: 1.0 }, { name: 'Soft Drink', price: 1.5 }] },
  { category: 'Snacks', color: '#F59E0B', items: [{ name: 'Biscuits', price: 0.8 }, { name: 'Chips', price: 1.2 }] },
  { category: 'General', color: '#6366F1', items: [{ name: 'Sample Item — edit me', price: 5.0 }] },
];

// LKR shops get LKR-shaped sample prices, not $1 water.
const PRICE_SCALE: Record<string, number> = { LKR: 300, INR: 80, BDT: 110, NPR: 130, PKR: 280, IDR: 15000, NGN: 1500, KES: 130 };

export function slugify(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'shop';
  return base;
}

async function uniqueSlug(name: string): Promise<string> {
  const base = slugify(name);
  for (let i = 0; i < 50; i += 1) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const exists = await prisma.organization.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!exists) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export interface SignupInput {
  shopName: string;
  email: string;
  ownerName: string;
  country: string;
  planCode: PlanCode;
  language?: string;
  /**
   * Set when the user chose their password AT signup (in-app flow). The org
   * then activates with zero email round-trips — no codes, no waiting. When
   * absent (marketing-page flow) we fall back to the magic-link email.
   */
  passwordHash?: string | null;
  /// Referral code from ?ref= on the marketing site. Credit is awarded at
  /// provisioning, not here — an abandoned checkout earns nobody anything.
  referralCode?: string | null;
}

/** Step 1 — reserve the org (PENDING). No side effects beyond the row. */
export async function createPendingOrg(input: SignupInput): Promise<Organization> {
  const defaults = defaultsForCountry(input.country);
  const slug = await uniqueSlug(input.shopName);

  const org = await prisma.organization.create({
    data: {
      slug,
      name: input.shopName,
      country: input.country.toUpperCase(),
      currency: defaults.currency,
      timezone: defaults.timezone,
      language: input.language ?? defaults.language,
      planCode: input.planCode,
      status: 'PENDING',
      receiptHeader: input.shopName,
      receiptFooter: 'Thank you! · Powered by Sillara — sillara.com',
      // Parked here until provisioning; awardReferral() resolves it to the
      // referrer org and replaces it with the real id.
      referredByOrgId: input.referralCode?.toUpperCase().slice(0, 16) ?? null,
    },
  });

  await prisma.orgUser.create({
    data: {
      orgId: org.id,
      email: input.email.toLowerCase(),
      name: input.ownerName,
      role: 'OWNER',
      passwordHash: input.passwordHash ?? null,
    },
  });

  logger.info({ orgId: org.id, slug, plan: input.planCode }, 'pending org created');
  return org;
}

export interface ProvisionResult {
  org: Organization;
  activationUrl: string;
  alreadyProvisioned: boolean;
}

/**
 * Step 2 — make the shop real. Idempotent: safe under webhook replays,
 * double-clicks and provider retries.
 */
export async function provisionOrg(
  orgId: string,
  billing: { provider: BillingProvider; ref?: string | null },
): Promise<ProvisionResult> {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, include: { users: true } });
  if (!org) throw new Error(`provision: org ${orgId} not found`);

  const owner = org.users.find((u) => u.role === 'OWNER');
  if (!owner) throw new Error(`provision: org ${orgId} has no owner`);

  // Password-at-signup users need no activation link at all — they sign
  // straight in. Magic links exist only for the email-first (marketing) flow.
  const hasPassword = Boolean(owner.passwordHash);
  const rawToken = randomToken();
  const activationUrl = hasPassword ? `${env.APP_URL}/login` : `${env.APP_URL}/activate?token=${rawToken}`;

  if (org.provisionedAt) {
    if (!hasPassword) {
      // Replayed webhook: re-mint a fresh link instead of duplicating a shop.
      await prisma.orgUser.update({
        where: { id: owner.id },
        data: { magicToken: sha256(rawToken), magicExpiresAt: new Date(Date.now() + 7 * 86_400_000) },
      });
      logger.info({ orgId }, 'provision replay — activation link re-minted');
    }
    return { org, activationUrl, alreadyProvisioned: true };
  }

  const scale = PRICE_SCALE[org.currency] ?? 1;

  const updated = await prisma.$transaction(async (tx) => {
    for (const [i, group] of SAMPLE_CATALOG.entries()) {
      const category = await tx.category.create({
        data: { orgId, name: group.category, color: group.color, sortOrder: i },
      });
      await tx.product.createMany({
        data: group.items.map((item) => ({
          orgId,
          categoryId: category.id,
          name: item.name,
          price: new Prisma.Decimal(Math.round(item.price * scale * 100) / 100),
        })),
      });
    }

    // Every org gets exactly one branch. Single-shop tenants never see the
    // concept; multi-branch is purely additive on top of this row.
    const branch = await tx.branch.create({
      data: { orgId, name: 'Main', code: 'BR-01', isDefault: true },
    });

    await tx.register.create({ data: { orgId, branchId: branch.id, name: 'Counter 1' } });

    try {
      await tx.orgSequence.create({ data: { orgId, scope: 'sale', current: 0 } });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }

    if (!hasPassword) {
      await tx.orgUser.update({
        where: { id: owner.id },
        data: { magicToken: sha256(rawToken), magicExpiresAt: new Date(Date.now() + 7 * 86_400_000) },
      });
    }

    // Three shapes of shop, three billing states:
    //   FREE            → ACTIVE forever, no period, never dunned
    //   paid + provider → ACTIVE with a period the provider will renew
    //   paid + MANUAL   → TRIAL for 14 days, then the lifecycle job decides
    const paid = org.planCode !== 'FREE';
    const trialing = paid && billing.provider === 'MANUAL';

    return tx.organization.update({
      where: { id: orgId },
      data: {
        status: trialing ? 'TRIAL' : 'ACTIVE',
        billingProvider: billing.provider,
        billingRef: billing.ref ?? null,
        provisionedAt: new Date(),
        trialEndsAt: trialing ? new Date(Date.now() + 14 * 86_400_000) : null,
        // A paid shop that just checked out owns the next month. Without this
        // the lifecycle sweep would find no period end and dun them on night one.
        currentPeriodEnd: paid && !trialing ? addMonths(new Date(), 1) : null,
        graceUntil: null,
      },
    });
  });

  // Referral credit — after the shop is real, so abandoned signups earn nothing.
  if (org.referredByOrgId) {
    await awardReferral(orgId, org.referredByOrgId).catch((err) =>
      logger.error({ err, orgId }, 'referral credit failed'),
    );
  }

  await prisma.auditLog.create({
    data: { orgId, action: 'org.provisioned', entity: 'Organization', entityId: orgId, detail: { provider: billing.provider, plan: org.planCode } },
  });

  // Queued, not sent: a Resend outage must never fail a signup. The flush job
  // owns delivery and retries. Skipped for password-at-signup users, who are
  // already standing inside their shop.
  if (!hasPassword) {
    await enqueue({
      orgId,
      template: 'activation',
      to: owner.email,
      // The token is in the key, so a re-minted link is a genuinely new email
      // while a replayed webhook with the same link is not.
      dedupeKey: `activation:${orgId}:${sha256(rawToken).slice(0, 32)}`,
      ...activationEmail(owner.name, org.name, activationUrl),
    }).catch((err) => logger.error({ err, orgId }, 'activation email could not be queued'));
    void flushEmails(5).catch(() => undefined); // someone is watching the screen
  }

  logger.info({ orgId, slug: updated.slug, provider: billing.provider }, '🏪 shop provisioned');
  return { org: updated, activationUrl, alreadyProvisioned: false };
}
