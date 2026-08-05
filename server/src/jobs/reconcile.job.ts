import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

/**
 * Does the cache still match the ledger?
 *
 * `stock_movements` is the truth; `products.stockQty` and `branch_stock.qty`
 * are caches of it. Caches drift — that is what caches do — and stock drift is
 * the kind nobody notices, because a wrong number still looks like a number.
 *
 * This job re-derives both balances from the ledger and reports the gap. It
 * does NOT correct anything on a schedule: a nightly job that quietly rewrites
 * balances turns a bug you could have found into one you never will. It tells
 * you, loudly, and a human decides:
 *
 *   npm run job -- reconcile            # report drift
 *   npm run job -- reconcile --apply    # write the ledger's answer back
 *
 * Transfers are excluded from the org rollup on purpose: moving stock between
 * two branches changes neither how much the business owns nor `stockQty`.
 */

export interface DriftRow {
  orgId: string;
  productId: string;
  branchId?: string | null;
  cached: number;
  ledger: number;
}

export interface ReconcileSummary {
  applied: boolean;
  branchDrift: number;
  productDrift: number;
  worst: DriftRow[];
}

const num = (v: unknown): number => Number(v ?? 0);

async function findBranchDrift(): Promise<DriftRow[]> {
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT m.orgId, m.branchId, m.productId, m.total AS ledger, COALESCE(bs.qty, 0) AS cached
    FROM (
      SELECT orgId, branchId, productId, SUM(qty) AS total
      FROM stock_movements
      WHERE branchId IS NOT NULL
      GROUP BY orgId, branchId, productId
    ) m
    LEFT JOIN branch_stock bs
      ON bs.branchId = m.branchId AND bs.productId = m.productId
    WHERE COALESCE(bs.qty, 0) <> m.total

    UNION ALL

    -- Rows the cache invented: a balance with no ledger behind it at all.
    SELECT bs.orgId, bs.branchId, bs.productId, 0 AS ledger, bs.qty AS cached
    FROM branch_stock bs
    LEFT JOIN (
      SELECT branchId, productId, SUM(qty) AS total
      FROM stock_movements
      WHERE branchId IS NOT NULL
      GROUP BY branchId, productId
    ) m ON m.branchId = bs.branchId AND m.productId = bs.productId
    WHERE m.total IS NULL AND bs.qty <> 0
  `;

  return rows.map((r) => ({
    orgId: String(r.orgId),
    branchId: String(r.branchId),
    productId: String(r.productId),
    cached: num(r.cached),
    ledger: num(r.ledger),
  }));
}

async function findProductDrift(): Promise<DriftRow[]> {
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT p.orgId, p.id AS productId, p.stockQty AS cached, COALESCE(m.total, 0) AS ledger
    FROM products p
    LEFT JOIN (
      SELECT productId, SUM(qty) AS total
      FROM stock_movements
      WHERE type NOT IN ('TRANSFER_IN', 'TRANSFER_OUT')
      GROUP BY productId
    ) m ON m.productId = p.id
    WHERE p.trackStock = 1
      AND p.deletedAt IS NULL
      AND p.stockQty <> COALESCE(m.total, 0)
  `;

  return rows.map((r) => ({
    orgId: String(r.orgId),
    productId: String(r.productId),
    branchId: null,
    cached: num(r.cached),
    ledger: num(r.ledger),
  }));
}

export async function runStockReconcile(
  _now = new Date(),
  opts: { apply?: boolean } = {},
): Promise<ReconcileSummary> {
  const apply = opts.apply ?? false;
  const [branchDrift, productDrift] = await Promise.all([findBranchDrift(), findProductDrift()]);

  for (const row of [...branchDrift, ...productDrift]) {
    logger.warn(
      { ...row, gap: Math.round((row.cached - row.ledger) * 1000) / 1000 },
      row.branchId ? 'branch stock drifted from ledger' : 'product stock drifted from ledger',
    );
  }

  if (apply) {
    for (const row of branchDrift) {
      await prisma.branchStock.upsert({
        where: { branchId_productId: { branchId: row.branchId!, productId: row.productId } },
        create: { orgId: row.orgId, branchId: row.branchId!, productId: row.productId, qty: row.ledger },
        update: { qty: row.ledger },
      });
    }
    for (const row of productDrift) {
      await prisma.product.update({ where: { id: row.productId }, data: { stockQty: row.ledger } });
    }
  }

  const worst = [...branchDrift, ...productDrift]
    .sort((a, b) => Math.abs(b.cached - b.ledger) - Math.abs(a.cached - a.ledger))
    .slice(0, 20);

  const summary: ReconcileSummary = {
    applied: apply,
    branchDrift: branchDrift.length,
    productDrift: productDrift.length,
    worst,
  };

  logger.info(
    summary,
    branchDrift.length + productDrift.length === 0
      ? '✅ stock caches match the ledger'
      : apply
        ? '🔧 stock drift corrected from ledger'
        : '⚠️  stock drift found — re-run with --apply to correct',
  );

  return summary;
}
