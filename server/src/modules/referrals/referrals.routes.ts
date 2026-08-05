import { Router } from 'express';
import { prisma, isUniqueViolation } from '../../lib/prisma.js';
import { asyncHandler, ok } from '../../lib/http.js';
import { requireAuth } from '../../middleware/auth.js';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

/**
 * Referral engine — shop refers shop, both get a free month.
 *
 * Codes are minted lazily on first view (most shops never open this page, so
 * there's no reason to mint for everyone at signup). The credit is awarded at
 * *provisioning*, not signup, so an abandoned checkout earns nobody anything —
 * and UNIQUE(referredOrgId) means a shop can only ever be counted once,
 * however many links it clicked.
 */

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 — codes get read aloud

function mintCode(name: string): string {
  const prefix = name.replace(/[^a-zA-Z]/g, '').slice(0, 4).toUpperCase() || 'SHOP';
  const suffix = Array.from({ length: 4 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
  return `${prefix}${suffix}`;
}

export const referralsRouter = Router();
referralsRouter.use(requireAuth);

referralsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    let org = await prisma.organization.findUniqueOrThrow({
      where: { id: orgId },
      select: { id: true, name: true, referralCode: true, creditMonths: true },
    });

    // Mint on first view, retrying on the (unlikely) collision.
    if (!org.referralCode) {
      for (let attempt = 0; attempt < 5 && !org.referralCode; attempt += 1) {
        try {
          org = await prisma.organization.update({
            where: { id: orgId },
            data: { referralCode: mintCode(org.name) },
            select: { id: true, name: true, referralCode: true, creditMonths: true },
          });
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
        }
      }
    }

    const referrals = await prisma.referral.findMany({
      where: { referrerOrgId: orgId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    ok(res, {
      code: org.referralCode,
      shareUrl: `${env.SITE_URL}/?ref=${org.referralCode}`,
      creditMonths: org.creditMonths,
      referredCount: referrals.length,
      referrals: referrals.map((r) => ({ id: r.id, creditMonths: r.creditMonths, createdAt: r.createdAt })),
    });
  }),
);

/**
 * Award credit to both sides. Called once, from the provisioner — never from
 * a request path, so a refresh can't farm free months.
 */
export async function awardReferral(referredOrgId: string, code: string): Promise<void> {
  const referrer = await prisma.organization.findFirst({
    where: { referralCode: code.toUpperCase(), deletedAt: null },
    select: { id: true },
  });
  if (!referrer || referrer.id === referredOrgId) return;

  try {
    await prisma.$transaction([
      prisma.referral.create({
        data: { referrerOrgId: referrer.id, referredOrgId, code: code.toUpperCase(), creditMonths: 1 },
      }),
      prisma.organization.update({ where: { id: referrer.id }, data: { creditMonths: { increment: 1 } } }),
      prisma.organization.update({
        where: { id: referredOrgId },
        data: { creditMonths: { increment: 1 }, referredByOrgId: referrer.id },
      }),
    ]);
    logger.info({ referrerOrgId: referrer.id, referredOrgId, code }, '🎁 referral credited to both shops');
  } catch (err) {
    // UNIQUE(referredOrgId) — already credited. Nothing to do.
    if (!isUniqueViolation(err)) throw err;
  }
}
