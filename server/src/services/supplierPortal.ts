import { prisma } from '../lib/prisma.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { env } from '../config/env.js';
import { enqueue, flushEmails } from './email/outbox.js';
import { logger } from '../lib/logger.js';

/**
 * Supplier portal access.
 *
 * Suppliers authenticate by signed magic link, not a password. They are
 * low-frequency users — check orders, update prices, look at demand — and
 * forcing a second full auth product on them would kill adoption before the
 * network could form. The token is long-lived (30 days), rotated on every
 * issue, and stored only as a sha256 hash.
 *
 * The trade-off is explicit: a leaked link exposes that supplier's own order
 * book and price list, and nothing else. No shop data, no cross-tenant reach,
 * no ability to change another party's records.
 */

export async function issuePortalLink(supplierAccountId: string): Promise<string> {
  const raw = randomToken(24);
  await prisma.supplierAccount.update({
    where: { id: supplierAccountId },
    data: {
      portalToken: sha256(raw),
      portalExpiresAt: new Date(Date.now() + 30 * 86_400_000),
    },
  });
  return `${env.APP_URL}/supplier?t=${raw}`;
}

export async function resolvePortalToken(raw: string) {
  const supplier = await prisma.supplierAccount.findUnique({
    where: { portalToken: sha256(raw) },
  });
  if (!supplier || !supplier.portalExpiresAt || supplier.portalExpiresAt < new Date()) return null;
  if (supplier.deletedAt || supplier.status === 'SUSPENDED') return null;

  // Touch last-seen without rotating the token — the link stays valid so a
  // supplier can bookmark it.
  void prisma.supplierAccount
    .update({ where: { id: supplier.id }, data: { lastSeenAt: new Date() } })
    .catch(() => {});

  return supplier;
}

/**
 * Supplier mail goes through the same outbox as everything else. A purchase
 * order that silently failed to reach the supplier is worse than one that was
 * never placed — the shop believes stock is coming.
 */
async function send(
  to: string,
  subject: string,
  html: string,
  text: string,
  dedupeKey: string,
  template: string,
): Promise<void> {
  await enqueue({ to, subject, html, text, dedupeKey, template });
  void flushEmails(5).catch(() => undefined);
}

const shell = (heading: string, body: string, cta: { label: string; url: string }) => `<!doctype html>
<html><body style="margin:0;background:#F1F5F9;padding:32px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
<table role="presentation" width="560" align="center" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:14px;overflow:hidden;">
  <tr><td style="background:#4F46E5;padding:22px 30px;color:#fff;font-size:20px;font-weight:700;">Sillara</td></tr>
  <tr><td style="padding:32px 30px;">
    <h1 style="margin:0 0 14px;font-size:21px;color:#0F172A;">${heading}</h1>
    ${body}
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:22px;"><tr><td style="border-radius:10px;background:#4F46E5;">
      <a href="${cta.url}" style="display:inline-block;padding:14px 30px;color:#fff;font-size:15px;font-weight:600;text-decoration:none;">${cta.label}</a>
    </td></tr></table>
    <p style="margin:22px 0 0;font-size:12px;color:#94A3B8;">This link is private to your business — treat it like a password.</p>
  </td></tr>
  <tr><td style="padding:18px 30px;border-top:1px solid #E2E8F0;font-size:12px;color:#94A3B8;">Sillara · the shop network · sillara.com</td></tr>
</table></body></html>`;

export async function notifySupplierOfOrder(
  supplierAccountId: string,
  orderNumber: number,
  shopName: string,
  total: number,
): Promise<void> {
  const supplier = await prisma.supplierAccount.findUnique({ where: { id: supplierAccountId } });
  if (!supplier) return;

  const url = await issuePortalLink(supplierAccountId);
  const amount = `${supplier.currency} ${total.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

  await send(
    supplier.email,
    `New order from ${shopName} — ${amount}`,
    shell(
      `New order #${orderNumber}`,
      `<p style="margin:0 0 12px;font-size:15px;line-height:23px;color:#334155;">
         <strong>${shopName}</strong> has placed an order with you for <strong>${amount}</strong>.</p>
       <p style="margin:0;font-size:15px;line-height:23px;color:#334155;">
         Open your portal to see the items, confirm the order, and check what shops in your area are running low on.</p>`,
      { label: 'View the order', url },
    ),
    `New order #${orderNumber} from ${shopName} — ${amount}\n\nView it: ${url}\n\n— Sillara`,
    `supplier-order:${supplierAccountId}:${orderNumber}`,
    'supplier-order',
  );
}

export async function sendPortalLink(supplierAccountId: string): Promise<void> {
  const supplier = await prisma.supplierAccount.findUnique({ where: { id: supplierAccountId } });
  if (!supplier) return;
  const url = await issuePortalLink(supplierAccountId);
  await send(
    supplier.email,
    'Your Sillara supplier portal',
    shell(
      'Your portal link',
      `<p style="margin:0;font-size:15px;line-height:23px;color:#334155;">
         Manage your price list, see incoming orders, and view what the shops near you are ordering.</p>`,
      { label: 'Open my portal', url },
    ),
    `Your Sillara supplier portal: ${url}`,
    // A fresh link is a fresh email; the same link twice is not.
    `supplier-portal:${supplierAccountId}:${url.slice(-16)}`,
    'supplier-portal',
  );
}
