import { prisma } from '../lib/prisma.js';
import { toNumber } from '../lib/money.js';
import { localDay, formatDayLabel } from '../lib/time.js';
import { enqueue } from '../services/email/outbox.js';
import { dailyDigestEmail, type DigestData } from '../services/email/templates.js';

/**
 * The end-of-day email.
 *
 * This is the highest-retention feature in the product and it costs almost
 * nothing: every morning the owner opens their phone to yesterday's takings
 * and a list of what is running low. It is the reason they remember Sillara
 * exists on the days they didn't open the app.
 *
 * Computed in the org's own timezone (a Colombo shop's day ends at Colombo
 * midnight, not UTC), and skipped entirely for a day with no sales — nobody
 * needs an email saying they earned nothing.
 */

export interface DigestSummary {
  considered: number;
  queued: number;
  skippedNoSales: number;
}

export async function runDailyDigest(now = new Date()): Promise<DigestSummary> {
  const summary: DigestSummary = { considered: 0, queued: 0, skippedNoSales: 0 };

  const orgs = await prisma.organization.findMany({
    where: {
      deletedAt: null,
      dailyDigestEnabled: true,
      status: { in: ['TRIAL', 'ACTIVE', 'PAST_DUE'] },
    },
    select: {
      id: true,
      name: true,
      currency: true,
      timezone: true,
      users: {
        where: { role: 'OWNER', deletedAt: null, isActive: true },
        select: { name: true, email: true },
        take: 1,
      },
    },
  });

  for (const org of orgs) {
    const owner = org.users[0];
    if (!owner) continue;

    // Only send once the org's own day is actually over.
    const day = localDay(org.timezone, now, -1);
    summary.considered += 1;

    const [agg, byTender, topItems, lowStock] = await Promise.all([
      prisma.sale.aggregate({
        where: { orgId: org.id, status: 'COMPLETED', soldAt: { gte: day.start, lt: day.end } },
        _sum: { total: true },
        _count: true,
      }),
      prisma.sale.groupBy({
        by: ['tender'],
        where: { orgId: org.id, status: 'COMPLETED', soldAt: { gte: day.start, lt: day.end } },
        orderBy: { tender: 'asc' },
        _sum: { total: true },
      }),
      prisma.saleItem.groupBy({
        by: ['nameSnapshot'],
        where: { sale: { orgId: org.id, status: 'COMPLETED', soldAt: { gte: day.start, lt: day.end } } },
        _sum: { qty: true, lineTotal: true },
        orderBy: { _sum: { lineTotal: 'desc' } },
        take: 5,
      }),
      prisma.product.findMany({
        where: { orgId: org.id, deletedAt: null, isActive: true, trackStock: true, NOT: { lowStockAt: null } },
        select: { name: true, stockQty: true, lowStockAt: true },
        orderBy: { stockQty: 'asc' },
        take: 40,
      }),
    ]);

    if (agg._count === 0) {
      summary.skippedNoSales += 1;
      continue;
    }

    const tender = (t: string) => toNumber(byTender.find((r) => r.tender === t)?._sum?.total);
    const data: DigestData = {
      shopName: org.name,
      dateLabel: formatDayLabel(day.date),
      currency: org.currency,
      salesCount: agg._count,
      gross: toNumber(agg._sum.total).toFixed(2),
      cash: tender('CASH').toFixed(2),
      card: (tender('CARD') + tender('QR')).toFixed(2),
      topItems: topItems.map((i) => ({
        name: i.nameSnapshot,
        qty: toNumber(i._sum?.qty),
        total: toNumber(i._sum?.lineTotal).toFixed(2),
      })),
      lowStock: lowStock
        .filter((p) => p.lowStockAt !== null && p.stockQty.lte(p.lowStockAt))
        .slice(0, 8)
        .map((p) => ({ name: p.name, qty: toNumber(p.stockQty) })),
    };

    const queued = await enqueue({
      orgId: org.id,
      template: 'daily-digest',
      to: owner.email,
      dedupeKey: `daily-digest:${org.id}:${day.date}`,
      ...dailyDigestEmail(owner.name, data),
    });
    if (queued) summary.queued += 1;
  }

  return summary;
}
