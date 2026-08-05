import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, ok } from '../../lib/http.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { toNumber } from '../../lib/money.js';

/**
 * Reports & exports.
 *
 * CSV is deliberately the export format: every accountant on Earth can open
 * it, and it needs no library. Values are escaped by one small helper rather
 * than a dependency — the whole surface is four endpoints.
 *
 * Streaming is not used: exports are capped at 50k rows, which serialises in
 * well under a second and keeps the code a single readable function.
 */

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const toCsv = (headers: string[], rows: unknown[][]): string =>
  [headers.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n');

function sendCsv(res: import('express').Response, filename: string, csv: string): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // BOM so Excel opens Sinhala/Tamil product names correctly.
  res.send(`﻿${csv}`);
}

const rangeQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  branchId: z.string().cuid().optional(),
});

export const reportsRouter = Router();
reportsRouter.use(requireAuth);

/** Sales export — one row per sale. The accountant's file. */
reportsRouter.get(
  '/export/sales',
  requireRole('MANAGER'),
  validate({ query: rangeQuery }),
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    const q = req.query as unknown as { from?: Date; to?: Date; branchId?: string };

    const sales = await prisma.sale.findMany({
      where: {
        orgId,
        ...(q.branchId ? { branchId: q.branchId } : {}),
        ...(q.from || q.to ? { soldAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
      },
      orderBy: { soldAt: 'asc' },
      take: 50_000,
      include: {
        cashier: { select: { name: true } },
        customer: { select: { name: true } },
        branch: { select: { name: true } },
      },
    });

    const csv = toCsv(
      ['Receipt', 'Date', 'Time', 'Branch', 'Cashier', 'Customer', 'Status', 'Subtotal', 'Discount', 'Loyalty', 'Tax', 'Total', 'Tender'],
      sales.map((s) => [
        s.number,
        s.soldAt.toISOString().slice(0, 10),
        s.soldAt.toISOString().slice(11, 19),
        s.branch?.name ?? '',
        s.cashier?.name ?? '',
        s.customer?.name ?? '',
        s.status,
        toNumber(s.subtotal),
        toNumber(s.discount),
        toNumber(s.loyaltyDiscount),
        toNumber(s.tax),
        toNumber(s.total),
        s.tender,
      ]),
    );
    sendCsv(res, `sillara-sales-${new Date().toISOString().slice(0, 10)}.csv`, csv);
  }),
);

/** Line-item export — what actually sold, for supplier negotiations. */
reportsRouter.get(
  '/export/items',
  requireRole('MANAGER'),
  validate({ query: rangeQuery }),
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    const q = req.query as unknown as { from?: Date; to?: Date; branchId?: string };

    const items = await prisma.saleItem.findMany({
      where: {
        sale: {
          orgId,
          status: 'COMPLETED',
          ...(q.branchId ? { branchId: q.branchId } : {}),
          ...(q.from || q.to ? { soldAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
        },
      },
      take: 50_000,
      include: { sale: { select: { number: true, soldAt: true } } },
    });

    const csv = toCsv(
      ['Receipt', 'Date', 'Product', 'Qty', 'Unit price', 'Line total'],
      items.map((i) => [
        i.sale.number,
        i.sale.soldAt.toISOString().slice(0, 10),
        i.nameSnapshot,
        toNumber(i.qty),
        toNumber(i.unitPrice),
        toNumber(i.lineTotal),
      ]),
    );
    sendCsv(res, `sillara-items-${new Date().toISOString().slice(0, 10)}.csv`, csv);
  }),
);

/** Stock valuation — what's on the shelves and what it cost. */
reportsRouter.get(
  '/export/stock',
  requireRole('MANAGER'),
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    const products = await prisma.product.findMany({
      where: { orgId, deletedAt: null },
      orderBy: { name: 'asc' },
      take: 50_000,
      include: { category: { select: { name: true } } },
    });

    const csv = toCsv(
      ['Product', 'Category', 'Barcode', 'Sell price', 'Cost', 'Stock', 'Stock value', 'Tracked'],
      products.map((p) => [
        p.name,
        p.category?.name ?? '',
        p.barcode ?? '',
        toNumber(p.price),
        toNumber(p.cost),
        toNumber(p.stockQty),
        Math.round(toNumber(p.stockQty) * toNumber(p.cost) * 100) / 100,
        p.trackStock ? 'yes' : 'no',
      ]),
    );
    sendCsv(res, `sillara-stock-${new Date().toISOString().slice(0, 10)}.csv`, csv);
  }),
);

/**
 * Profit report.
 *
 * The number owners price and restock on, so it is worth being exact about
 * what it means. Four things were wrong here, and every one of them pushed
 * profit the same way — up:
 *
 *   • Cost came from `products.cost` via a join, which every delivery
 *     overwrites. Last month's margin moved when today's stock arrived.
 *     It now reads `sale_items.unitCost`, frozen at the moment of sale.
 *   • Revenue was `SUM(lineTotal)`, which for a tax-inclusive shop includes
 *     the tax. A 15% VAT shop saw margins inflated by roughly 13 points of
 *     revenue — the government's money booked as gross profit. Revenue is now
 *     `netExTax`.
 *   • Whole-bill discounts and loyalty redemptions were never subtracted.
 *     `netExTax` is net of both.
 *   • The headline totals summed only the LIMIT 100 rows, ordered by profit
 *     descending — so the cut fell on the worst performers and the total
 *     excluded exactly the lines dragging the business down. Totals are now
 *     computed over everything; the 100 is only the detail list.
 *
 * Lines sold before per-line costing existed (and free-text lines that never
 * had a product) have no cost to report. They are counted and surfaced as
 * `uncostedLines` rather than being folded in at zero cost, which would read
 * as pure profit.
 */
reportsRouter.get(
  '/profit',
  requireRole('MANAGER'),
  validate({
    query: z.object({
      days: z.coerce.number().int().min(1).max(365).default(30),
      branchId: z.string().cuid().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    const q = req.query as unknown as { days: number; branchId?: string };
    const since = new Date(Date.now() - q.days * 86_400_000);
    const branchFilter = q.branchId ? Prisma.sql`AND s.branchId = ${q.branchId}` : Prisma.empty;

    // Totals over every line in the window — not just the ones we display.
    const [totals] = await prisma.$queryRaw<
      Array<{ revenue: string; cost: string; tax: string; uncosted: string; lineCount: string }>
    >`
      SELECT COALESCE(SUM(si.netExTax), 0)                                    AS revenue,
             COALESCE(SUM(si.qty * si.unitCost), 0)                           AS cost,
             COALESCE(SUM(si.taxAmount), 0)                                   AS tax,
             SUM(CASE WHEN si.unitCost IS NULL THEN 1 ELSE 0 END)             AS uncosted,
             COUNT(*)                                                         AS lineCount
      FROM sale_items si
      JOIN sales s ON s.id = si.saleId
      WHERE s.orgId = ${orgId} AND s.status = 'COMPLETED' AND s.soldAt >= ${since}
        ${branchFilter}
    `;

    // Grouped by product, not by name: renaming a product used to split its
    // history in two, and two products sharing a name used to merge into one.
    const rows = await prisma.$queryRaw<
      Array<{ productId: string | null; name: string; qty: string; revenue: string; cost: string; uncosted: string }>
    >`
      SELECT si.productId                                         AS productId,
             COALESCE(MAX(p.name), MAX(si.nameSnapshot))          AS name,
             SUM(si.qty)                                          AS qty,
             COALESCE(SUM(si.netExTax), 0)                        AS revenue,
             COALESCE(SUM(si.qty * si.unitCost), 0)               AS cost,
             SUM(CASE WHEN si.unitCost IS NULL THEN 1 ELSE 0 END) AS uncosted
      FROM sale_items si
      JOIN sales s ON s.id = si.saleId
      LEFT JOIN products p ON p.id = si.productId
      WHERE s.orgId = ${orgId} AND s.status = 'COMPLETED' AND s.soldAt >= ${since}
        ${branchFilter}
      GROUP BY si.productId
      ORDER BY (COALESCE(SUM(si.netExTax), 0) - COALESCE(SUM(si.qty * si.unitCost), 0)) DESC
      LIMIT 100
    `;

    const round = (n: number): number => Math.round(n * 100) / 100;
    const margin = (revenue: number, cost: number): number =>
      revenue > 0 ? Math.round(((revenue - cost) / revenue) * 1000) / 10 : 0;

    const revenue = round(Number(totals?.revenue ?? 0));
    const cost = round(Number(totals?.cost ?? 0));
    const uncostedLines = Number(totals?.uncosted ?? 0);

    ok(res, {
      days: q.days,
      revenue,
      cost,
      profit: round(revenue - cost),
      marginPct: margin(revenue, cost),
      /// Tax collected in the window. Not revenue — it is owed onward, and
      /// showing it separately is what stops it being mistaken for takings.
      tax: round(Number(totals?.tax ?? 0)),
      /// How much of this answer is actually knowable. Non-zero means some
      /// lines had no recorded cost, so `profit` is an overstatement by
      /// whatever those goods cost.
      uncostedLines,
      totalLines: Number(totals?.lineCount ?? 0),
      items: rows.map((r) => {
        const itemRevenue = round(Number(r.revenue));
        const itemCost = round(Number(r.cost));
        return {
          productId: r.productId,
          name: r.name,
          qty: Number(r.qty),
          revenue: itemRevenue,
          cost: itemCost,
          profit: round(itemRevenue - itemCost),
          marginPct: margin(itemRevenue, itemCost),
          uncostedLines: Number(r.uncosted),
        };
      }),
    });
  }),
);
