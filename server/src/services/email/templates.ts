/**
 * Email templates.
 *
 * One layout, six messages, zero dependencies. Table-based HTML with inline
 * styles because that is still the only thing Outlook, Gmail and Apple Mail
 * all render the same way — a CSS framework here would cost deliverability
 * and buy nothing.
 *
 * Every template returns { subject, html, text }. The text part is not
 * optional: an HTML-only email is a spam-filter magnet.
 */

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const BRAND = '#4F46E5';

function layout(body: string, preheader: string): string {
  return `<!doctype html><html><body style="margin:0;background:#F1F5F9;padding:32px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
  <span style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</span>
  <table role="presentation" width="560" align="center" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:14px;overflow:hidden;">
    <tr><td style="background:${BRAND};padding:22px 30px;color:#fff;font-size:20px;font-weight:700;letter-spacing:-0.3px;">Sillara</td></tr>
    <tr><td style="padding:32px 30px;">${body}</td></tr>
    <tr><td style="padding:18px 30px;border-top:1px solid #E2E8F0;font-size:12px;color:#94A3B8;">Sillara · sell anywhere · sillara.com</td></tr>
  </table></body></html>`;
}

const h1 = (t: string) => `<h1 style="margin:0 0 14px;font-size:22px;color:#0F172A;">${t}</h1>`;
const p = (t: string) => `<p style="margin:0 0 16px;font-size:15px;line-height:23px;color:#334155;">${t}</p>`;
const small = (t: string) => `<p style="margin:22px 0 0;font-size:12px;color:#94A3B8;">${t}</p>`;
const button = (label: string, url: string) =>
  `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:10px;background:${BRAND};">
     <a href="${url}" style="display:inline-block;padding:14px 32px;color:#fff;font-size:15px;font-weight:600;text-decoration:none;">${label}</a>
   </td></tr></table>`;

/** Anything interpolated into HTML gets escaped. Shop names contain apostrophes. */
export function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const firstName = (name: string) => esc(name.split(' ')[0] ?? name);

// ---------------------------------------------------------------------------

export function activationEmail(name: string, shopName: string, url: string): RenderedEmail {
  const shop = esc(shopName);
  return {
    subject: `Your shop "${shopName}" is ready — set your password`,
    html: layout(
      h1('Your shop is live 🎉') +
        p(`Hi ${firstName(name)},`) +
        p(`<strong>${shop}</strong> is provisioned and waiting. Set your password and you can ring up your first sale in the next two minutes.`) +
        button('Open my shop', url) +
        small('This link works once and expires in 7 days. If you didn&#39;t sign up, ignore this email.'),
      `${shopName} is provisioned and waiting.`,
    ),
    text: `Hi ${name},\n\n${shopName} is ready. Set your password: ${url}\n\n— Sillara`,
  };
}

export function trialEndingEmail(name: string, shopName: string, daysLeft: number, url: string): RenderedEmail {
  const when = daysLeft <= 1 ? 'tomorrow' : `in ${daysLeft} days`;
  return {
    subject: `${shopName}: your trial ends ${when}`,
    html: layout(
      h1(`Your trial ends ${when}`) +
        p(`Hi ${firstName(name)},`) +
        p(`Everything in <strong>${esc(shopName)}</strong> — your products, sales history, customers and loyalty points — stays exactly where it is. Add a payment method and nothing changes.`) +
        p('If you do nothing, the till keeps working through a 7-day grace period. We will not cut you off mid-trade.') +
        button('Keep my shop running', url),
      `Your Sillara trial ends ${when}.`,
    ),
    text: `Hi ${name},\n\nYour Sillara trial for ${shopName} ends ${when}. Your data stays put.\nAdd a payment method: ${url}\n\n— Sillara`,
  };
}

export function pastDueEmail(name: string, shopName: string, graceEndsAt: Date, url: string): RenderedEmail {
  const date = graceEndsAt.toISOString().slice(0, 10);
  return {
    subject: `${shopName}: we couldn't take payment`,
    html: layout(
      h1('That payment did not go through') +
        p(`Hi ${firstName(name)},`) +
        p(`We could not charge the card on file for <strong>${esc(shopName)}</strong>. It happens — an expiry date, a bank block, a daily limit.`) +
        p(`<strong>Your till keeps working until ${date}.</strong> Update the card before then and you will not notice a thing.`) +
        button('Update payment', url),
      'We could not take payment — your till still works.',
    ),
    text: `Hi ${name},\n\nWe couldn't charge the card for ${shopName}. The till keeps working until ${date}.\nUpdate payment: ${url}\n\n— Sillara`,
  };
}

export function suspendedEmail(name: string, shopName: string, url: string): RenderedEmail {
  return {
    subject: `${shopName} is paused — your data is safe`,
    html: layout(
      h1('Your shop is paused') +
        p(`Hi ${firstName(name)},`) +
        p(`The grace period on <strong>${esc(shopName)}</strong> has ended, so selling is paused. <strong>Nothing has been deleted.</strong> Every product, sale, customer and loyalty balance is exactly where you left it.`) +
        p('Reading your reports still works. One payment and the till comes straight back.') +
        button('Reactivate my shop', url),
      'Selling is paused. Nothing has been deleted.',
    ),
    text: `Hi ${name},\n\n${shopName} is paused. Nothing was deleted — reports still work.\nReactivate: ${url}\n\n— Sillara`,
  };
}

export function creditAppliedEmail(name: string, shopName: string, monthsLeft: number): RenderedEmail {
  return {
    subject: `A free month was applied to ${shopName}`,
    html: layout(
      h1('A referral just paid your bill 🎁') +
        p(`Hi ${firstName(name)},`) +
        p(`We applied one of your referral credits to <strong>${esc(shopName)}</strong>, so this month is on us.`) +
        p(monthsLeft > 0 ? `You have <strong>${monthsLeft}</strong> free ${monthsLeft === 1 ? 'month' : 'months'} left.` : 'That was your last credit — refer another shop to earn more.'),
      'A referral credit covered this month.',
    ),
    text: `Hi ${name},\n\nA referral credit covered this month for ${shopName}. Credits left: ${monthsLeft}.\n\n— Sillara`,
  };
}

export interface DigestData {
  shopName: string;
  dateLabel: string;
  currency: string;
  salesCount: number;
  gross: string;
  cash: string;
  card: string;
  topItems: Array<{ name: string; qty: number; total: string }>;
  lowStock: Array<{ name: string; qty: number }>;
}

export function dailyDigestEmail(name: string, d: DigestData): RenderedEmail {
  const row = (label: string, value: string) =>
    `<tr><td style="padding:7px 0;font-size:14px;color:#64748B;">${label}</td>
         <td style="padding:7px 0;font-size:14px;color:#0F172A;text-align:right;font-weight:600;">${value}</td></tr>`;

  const top = d.topItems.length
    ? `<h2 style="margin:26px 0 8px;font-size:14px;color:#0F172A;">Best sellers</h2>
       <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
       ${d.topItems.map((i) => row(`${esc(i.name)} × ${i.qty}`, `${d.currency} ${i.total}`)).join('')}
       </table>`
    : '';

  const low = d.lowStock.length
    ? `<h2 style="margin:26px 0 8px;font-size:14px;color:#B91C1C;">Running low</h2>
       <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
       ${d.lowStock.map((i) => row(esc(i.name), `${i.qty} left`)).join('')}
       </table>`
    : '';

  return {
    subject: `${d.shopName}: ${d.currency} ${d.gross} on ${d.dateLabel}`,
    html: layout(
      h1(`${d.dateLabel} at ${esc(d.shopName)}`) +
        p(`Hi ${firstName(name)}, here is your day.`) +
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #E2E8F0;">
           ${row('Sales', String(d.salesCount))}
           ${row('Gross', `${d.currency} ${d.gross}`)}
           ${row('Cash', `${d.currency} ${d.cash}`)}
           ${row('Card &amp; digital', `${d.currency} ${d.card}`)}
         </table>` +
        top +
        low +
        small('You can turn this email off in Settings → Business.'),
      `${d.salesCount} sales, ${d.currency} ${d.gross}.`,
    ),
    text:
      `${d.dateLabel} at ${d.shopName}\n\n` +
      `Sales: ${d.salesCount}\nGross: ${d.currency} ${d.gross}\nCash: ${d.currency} ${d.cash}\nCard & digital: ${d.currency} ${d.card}\n` +
      (d.topItems.length ? `\nBest sellers:\n${d.topItems.map((i) => `  ${i.name} x${i.qty} — ${d.currency} ${i.total}`).join('\n')}\n` : '') +
      (d.lowStock.length ? `\nRunning low:\n${d.lowStock.map((i) => `  ${i.name} — ${i.qty} left`).join('\n')}\n` : '') +
      `\n— Sillara`,
  };
}
