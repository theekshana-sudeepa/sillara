import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import type { Organization, Plan } from '@prisma/client';
import { prisma, isUniqueViolation } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../config/env.js';
import { md5Upper } from '../../lib/crypto.js';
import { provisionOrg } from '../../services/provisioner.js';
import { addMonths, GRACE_DAYS } from '../../services/lifecycle.js';
import { invalidateOrgCache } from '../../middleware/org.js';
import { toNumber } from '../../lib/money.js';

/**
 * Webhook idempotency mirrors the AutoBilling philosophy: claim the event id
 * in `webhook_events` (UNIQUE provider+eventId) BEFORE doing any work. A
 * replayed webhook loses the insert and exits — one event, one effect.
 */
async function claimEvent(provider: string, eventId: string, eventType: string, payload: unknown): Promise<boolean> {
  try {
    await prisma.webhookEvent.create({
      data: { provider, eventId, eventType, payload: payload as never },
    });
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) {
      logger.info({ provider, eventId }, 'webhook replay ignored');
      return false;
    }
    throw err;
  }
}

async function markProcessed(provider: string, eventId: string, error?: string): Promise<void> {
  await prisma.webhookEvent.updateMany({
    where: { provider, eventId },
    data: { processedAt: new Date(), error: error ?? null },
  });
}

/**
 * A successful charge, applied.
 *
 * Extends from whichever is later — the period they already had, or now — so
 * paying early adds a month rather than throwing away the remainder, and
 * paying late does not backdate into a period that already lapsed. Clearing
 * `graceUntil` and lifting SUSPENDED is what makes reactivation instant: the
 * shop is selling again before the owner has closed the payment tab.
 */
async function renewPeriod(orgId: string, provider: 'PADDLE' | 'PAYHERE', ref: string | null): Promise<void> {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { currentPeriodEnd: true, planCode: true },
  });
  if (!org || org.planCode === 'FREE') return;

  const now = new Date();
  const base = org.currentPeriodEnd && org.currentPeriodEnd > now ? org.currentPeriodEnd : now;

  await prisma.organization.update({
    where: { id: orgId },
    data: {
      status: 'ACTIVE',
      billingProvider: provider,
      ...(ref ? { billingRef: ref } : {}),
      currentPeriodEnd: addMonths(base, 1),
      graceUntil: null,
      suspendedAt: null,
      trialEndsAt: null,
      lastBillingEmailAt: null,
    },
  });
  invalidateOrgCache(orgId);
  logger.info({ orgId, provider, until: addMonths(base, 1) }, '💰 billing period renewed');
}

// ---------------------------------------------------------------------------
// PADDLE (worldwide — merchant of record)
// Signature: `Paddle-Signature: ts=...;h1=...` — HMAC-SHA256 of `${ts}:${rawBody}`
// with the endpoint secret. Docs: developer.paddle.com → Webhooks → Verify.
// ---------------------------------------------------------------------------

function verifyPaddleSignature(rawBody: Buffer, header: string | undefined): boolean {
  if (!env.PADDLE_WEBHOOK_SECRET || !header) return false;
  const parts = Object.fromEntries(header.split(';').map((p) => p.split('=') as [string, string]));
  const ts = parts.ts;
  const h1 = parts.h1;
  if (!ts || !h1) return false;

  const computed = crypto
    .createHmac('sha256', env.PADDLE_WEBHOOK_SECRET)
    .update(`${ts}:${rawBody.toString('utf8')}`)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(h1));
  } catch {
    return false;
  }
}

export async function handlePaddleWebhook(req: Request, res: Response): Promise<void> {
  const rawBody = req.body as Buffer;

  if (!verifyPaddleSignature(rawBody, req.headers['paddle-signature'] as string | undefined)) {
    logger.warn('paddle webhook rejected — bad signature');
    res.status(401).json({ ok: false });
    return;
  }

  const event = JSON.parse(rawBody.toString('utf8')) as {
    event_id: string;
    event_type: string;
    data: { id?: string; status?: string; custom_data?: { orgId?: string } };
  };

  // Always 200 fast — Paddle retries on non-2xx and we already own the event.
  res.status(200).json({ ok: true });

  if (!(await claimEvent('paddle', event.event_id, event.event_type, event))) return;

  try {
    const orgId = event.data.custom_data?.orgId;

    switch (event.event_type) {
      case 'subscription.created':
      case 'subscription.activated':
      case 'transaction.completed': {
        if (!orgId) break;
        await provisionOrg(orgId, { provider: 'PADDLE', ref: event.data.id ?? null });
        // A payment landed: own the next month, clear any grace, come back
        // from PAST_DUE or SUSPENDED without an operator touching anything.
        await renewPeriod(orgId, 'PADDLE', event.data.id ?? null);
        break;
      }
      case 'subscription.past_due':
        if (orgId) {
          await prisma.organization.updateMany({
            where: { id: orgId, status: { in: ['TRIAL', 'ACTIVE'] } },
            data: { status: 'PAST_DUE', graceUntil: new Date(Date.now() + GRACE_DAYS * 86_400_000) },
          });
          invalidateOrgCache(orgId);
        }
        break;
      case 'subscription.canceled':
        if (orgId) {
          await prisma.organization.updateMany({
            where: { id: orgId },
            data: { status: 'CANCELLED', suspendedAt: new Date(), graceUntil: null },
          });
          invalidateOrgCache(orgId);
        }
        break;
      default:
        logger.debug({ type: event.event_type }, 'paddle event ignored');
    }
    await markProcessed('paddle', event.event_id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, eventId: event.event_id }, 'paddle webhook processing failed');
    await markProcessed('paddle', event.event_id, message);
  }
}

// ---------------------------------------------------------------------------
// PAYHERE (Sri Lanka — local cards + LankaQR)
// Checkout: client POSTs a signed form to PayHere. Notify: PayHere calls us
// server-to-server with an md5sig we recompute. Docs: support.payhere.lk.
// ---------------------------------------------------------------------------

const PAYHERE_CHECKOUT_URL: Record<string, string> = {
  sandbox: 'https://sandbox.payhere.lk/pay/checkout',
  production: 'https://www.payhere.lk/pay/checkout',
};

export function payhereCheckoutParams(org: Organization, plan: Plan, ownerName: string, email: string) {
  const merchantId = env.PAYHERE_MERCHANT_ID!;
  const secret = env.PAYHERE_MERCHANT_SECRET!;
  const orderId = `sillara-${org.id}`;
  const amount = toNumber(plan.priceLkr).toFixed(2);
  const currency = 'LKR';

  // hash = UPPER(MD5(merchant_id + order_id + amount + currency + UPPER(MD5(secret))))
  const hash = md5Upper(`${merchantId}${orderId}${amount}${currency}${md5Upper(secret)}`);

  const [firstName, ...rest] = ownerName.split(' ');

  return {
    action: PAYHERE_CHECKOUT_URL[env.PAYHERE_ENV],
    fields: {
      merchant_id: merchantId,
      return_url: `${env.APP_URL}/activate?pending=${org.id}`,
      cancel_url: `${env.SITE_URL}/#pricing`,
      notify_url: `${env.API_URL}/api/v1/public/webhooks/payhere`,
      order_id: orderId,
      items: `Sillara ${plan.name} — monthly`,
      recurrence: '1 Month',
      duration: 'Forever',
      amount,
      currency,
      first_name: firstName ?? 'Shop',
      last_name: rest.join(' ') || 'Owner',
      email,
      phone: '',
      address: '',
      city: '',
      country: 'Sri Lanka',
      hash,
    },
  };
}

export async function handlePayhereNotify(req: Request, res: Response): Promise<void> {
  const p = req.body as Record<string, string>;
  const { merchant_id, order_id, payhere_amount, payhere_currency, status_code, md5sig, subscription_id } = p;

  // md5sig = UPPER(MD5(merchant_id + order_id + amount + currency + status_code + UPPER(MD5(secret))))
  const local = md5Upper(
    `${merchant_id}${order_id}${payhere_amount}${payhere_currency}${status_code}${md5Upper(env.PAYHERE_MERCHANT_SECRET ?? '')}`,
  );

  if (!md5sig || local !== md5sig || merchant_id !== env.PAYHERE_MERCHANT_ID) {
    logger.warn({ order_id }, 'payhere notify rejected — bad signature');
    res.status(401).send('bad signature');
    return;
  }

  res.status(200).send('ok');

  const eventId = `${order_id}:${p.payment_id ?? status_code}:${status_code}`;
  if (!(await claimEvent('payhere', eventId, `status_${status_code}`, p))) return;

  try {
    const orgId = order_id?.replace(/^sillara-/, '');
    if (!orgId) throw new Error(`unparseable order_id: ${order_id}`);

    // status_code: 2 = success, 0 = pending, -1 = cancelled, -2 = failed, -3 = chargedback
    if (status_code === '2') {
      await provisionOrg(orgId, { provider: 'PAYHERE', ref: subscription_id ?? p.payment_id ?? null });
      await renewPeriod(orgId, 'PAYHERE', subscription_id ?? p.payment_id ?? null);
    } else if (status_code === '-3') {
      // Chargeback: no grace. Someone disputed a charge they already made.
      await prisma.organization.updateMany({
        where: { id: orgId },
        data: { status: 'SUSPENDED', suspendedAt: new Date(), graceUntil: null },
      });
      invalidateOrgCache(orgId);
    }
    await markProcessed('payhere', eventId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, order_id }, 'payhere notify processing failed');
    await markProcessed('payhere', eventId, message);
  }
}
