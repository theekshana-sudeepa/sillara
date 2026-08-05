import { Router, raw } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, ok } from '../../lib/http.js';
import { validate } from '../../middleware/validate.js';
import { publicLimiter } from '../../middleware/rateLimit.js';
import { BadRequest, Conflict, NotFound } from '../../lib/errors.js';
import { env } from '../../config/env.js';
import { createPendingOrg, defaultsForCountry, provisionOrg } from '../../services/provisioner.js';
import { handlePaddleWebhook, handlePayhereNotify, payhereCheckoutParams } from './webhooks.js';
import { toNumber } from '../../lib/money.js';
import { hashPassword } from '../../lib/crypto.js';
import { signToken } from '../../middleware/auth.js';

const signupSchema = z.object({
  shopName: z.string().trim().min(2, 'Shop name is required').max(180),
  ownerName: z.string().trim().min(2, 'Your name is required').max(120),
  email: z.string().trim().toLowerCase().email(),
  country: z.string().trim().length(2, 'Use a 2-letter country code'),
  planCode: z.enum(['FREE', 'SHOP', 'PRO']).default('FREE'),
  language: z.enum(['en', 'si', 'ta']).optional(),
  // In-app flow: password chosen at signup → instant activation, no email
  // round-trip. Marketing flow omits it and gets the magic-link email.
  password: z.string().min(8, 'Password must be at least 8 characters').max(128).optional(),
  // From ?ref= on the marketing site — both shops get a free month.
  referralCode: z.string().trim().toUpperCase().max(16).optional(),
});

export const publicRouter = Router();

/** Plans + localized pricing — powers the marketing pricing table. */
publicRouter.get(
  '/plans',
  asyncHandler(async (req, res) => {
    const country = String(req.query.country ?? 'US').toUpperCase();
    const local = country === 'LK';
    const plans = await prisma.plan.findMany({ orderBy: { sortOrder: 'asc' } });
    ok(res, {
      currency: local ? 'LKR' : 'USD',
      country,
      plans: plans.map((p) => ({
        code: p.code,
        name: p.name,
        price: local ? toNumber(p.priceLkr) : toNumber(p.priceUsd),
        priceUsd: toNumber(p.priceUsd),
        priceLkr: toNumber(p.priceLkr),
        maxTerminals: p.maxTerminals,
        maxProducts: p.maxProducts,
        maxUsers: p.maxUsers,
        features: p.features,
      })),
    });
  }),
);

/**
 * THE front door. One POST, three outcomes:
 *   FREE       → provisioned inline; activation URL returned immediately
 *   paid + LK  → PayHere checkout params (client posts to PayHere)
 *   paid other → Paddle checkout config (client opens Paddle overlay)
 * The org exists in PENDING either way, so an abandoned checkout can resume.
 */
publicRouter.post(
  '/signup',
  publicLimiter,
  validate({ body: signupSchema }),
  asyncHandler(async (req, res) => {
    const input = req.body as z.infer<typeof signupSchema>;

    const emailTaken = await prisma.orgUser.findFirst({
      where: { email: input.email, deletedAt: null, org: { status: { not: 'PENDING' } } },
      select: { id: true },
    });
    if (emailTaken) throw Conflict('This email already runs a Sillara shop. Sign in instead.');

    const passwordHash = input.password ? await hashPassword(input.password) : null;
    const org = await createPendingOrg({ ...input, passwordHash });

    if (input.planCode === 'FREE') {
      const result = await provisionOrg(org.id, { provider: 'MANUAL' });

      if (passwordHash) {
        // Password already set → hand back a live session. Signup IS login.
        const owner = await prisma.orgUser.findFirst({ where: { orgId: org.id, role: 'OWNER' } });
        const live = result.org;
        return ok(res, {
          orgId: org.id,
          mode: 'ready',
          token: signToken({ userId: owner!.id, orgId: org.id, role: 'OWNER', email: owner!.email }),
          org: { id: live.id, slug: live.slug, name: live.name, currency: live.currency, language: live.language },
          user: { id: owner!.id, name: owner!.name, email: owner!.email, role: 'OWNER' as const },
        }, 201);
      }

      return ok(res, { orgId: org.id, mode: 'provisioned', activationUrl: result.activationUrl }, 201);
    }

    const plan = await prisma.plan.findUnique({ where: { code: input.planCode } });
    if (!plan) throw BadRequest('Unknown plan');

    if (input.country.toUpperCase() === 'LK') {
      if (!env.PAYHERE_MERCHANT_ID) throw BadRequest('PayHere is not configured yet — choose the Free plan for now');
      return ok(res, {
        orgId: org.id,
        mode: 'payhere',
        checkout: payhereCheckoutParams(org, plan, req.body.ownerName as string, input.email),
      }, 201);
    }

    if (!plan.paddlePriceId) throw BadRequest('Card checkout is not configured yet — choose the Free plan for now');
    return ok(res, {
      orgId: org.id,
      mode: 'paddle',
      checkout: {
        environment: env.PADDLE_ENV,
        priceId: plan.paddlePriceId,
        customData: { orgId: org.id },
        customerEmail: input.email,
        successUrl: `${env.APP_URL}/activate?pending=${org.id}`,
      },
    }, 201);
  }),
);

/** The "Setting up your shop…" screen polls this. */
publicRouter.get(
  '/provision-status/:orgId',
  validate({ params: z.object({ orgId: z.string().cuid() }) }),
  asyncHandler(async (req, res) => {
    const org = await prisma.organization.findUnique({
      where: { id: req.params.orgId! },
      select: { status: true, provisionedAt: true, slug: true, name: true },
    });
    if (!org) throw NotFound('Signup');
    ok(res, { status: org.status, ready: Boolean(org.provisionedAt), slug: org.slug, name: org.name });
  }),
);

/**
 * Public receipt page data — what the customer's WhatsApp link opens.
 * No auth: the publicId is an unguessable device-minted token, and the
 * payload is exactly what was printed on paper, nothing more. Every view
 * ends with a "create your own shop" CTA — the receipt IS the funnel.
 */
publicRouter.get(
  '/receipt/:publicId',
  validate({ params: z.object({ publicId: z.string().regex(/^[a-z0-9]{8,24}$/i) }) }),
  asyncHandler(async (req, res) => {
    const sale = await prisma.sale.findUnique({
      where: { publicId: req.params.publicId! },
      include: {
        items: true,
        org: {
          select: { name: true, receiptHeader: true, receiptFooter: true, address: true, phone: true, taxId: true, currency: true },
        },
      },
    });
    if (!sale || sale.status === 'VOID') throw NotFound('Receipt');

    ok(res, {
      number: sale.number,
      soldAt: sale.soldAt,
      currency: sale.currency,
      subtotal: toNumber(sale.subtotal),
      discount: toNumber(sale.discount),
      tax: toNumber(sale.tax),
      total: toNumber(sale.total),
      tender: sale.tender,
      tendered: toNumber(sale.tendered),
      change: toNumber(sale.change),
      items: sale.items.map((i) => ({
        name: i.nameSnapshot,
        qty: toNumber(i.qty),
        unitPrice: toNumber(i.unitPrice),
        lineTotal: toNumber(i.lineTotal),
      })),
      shop: {
        name: sale.org.receiptHeader ?? sale.org.name,
        address: sale.org.address,
        phone: sale.org.phone,
        taxId: sale.org.taxId,
        footer: sale.org.receiptFooter,
      },
    });
  }),
);

/** Country sniff for pricing/currency defaults (client may override). */
publicRouter.get(
  '/geo',
  asyncHandler(async (req, res) => {
    // Behind Cloudflare/Vercel this header is free; otherwise default US.
    const country = (req.headers['cf-ipcountry'] as string | undefined)?.toUpperCase() ?? 'US';
    ok(res, { country, ...defaultsForCountry(country) });
  }),
);

// --- payment webhooks -------------------------------------------------------
// Paddle signs the RAW body — mount raw() BEFORE any json parsing on this path.
publicRouter.post('/webhooks/paddle', raw({ type: '*/*', limit: '1mb' }), asyncHandler(handlePaddleWebhook));

// PayHere posts application/x-www-form-urlencoded server-to-server.
publicRouter.post('/webhooks/payhere', asyncHandler(handlePayhereNotify));
