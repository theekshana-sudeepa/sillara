/**
 * ---------------------------------------------------------------------------
 * P3 BACKFILL — bring pre-P3 shops onto the branch model
 * ---------------------------------------------------------------------------
 * New shops get a "Main" branch from the provisioner. Shops that existed
 * before P3 have none, so their sales, registers and stock movements carry a
 * null branchId and their per-branch stock table is empty.
 *
 * This script fixes that. Run it ONCE after `prisma migrate deploy`:
 *
 *     npm run backfill:p3            # apply
 *     npm run backfill:p3 -- --dry   # report only, change nothing
 *
 * IDEMPOTENT BY CONSTRUCTION. Every step either filters on `null` or upserts,
 * so running it twice is a no-op — which matters, because the one thing worse
 * than forgetting a backfill is being afraid to re-run it after a partial
 * failure. Each org is processed in its own transaction: a problem with one
 * tenant cannot corrupt or roll back another.
 */
// Standalone script: the app loads .env through src/config/env.ts, but this
// never imports that, so it must load the file itself. Without this line the
// documented `npm run seed` fails on a fresh clone.
import 'dotenv/config';
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();
const DRY = process.argv.includes('--dry');

interface OrgReport {
  slug: string;
  branchCreated: boolean;
  registers: number;
  sales: number;
  movements: number;
  stockRows: number;
}

async function backfillOrg(org: { id: string; slug: string; name: string }): Promise<OrgReport> {
  const report: OrgReport = {
    slug: org.slug,
    branchCreated: false,
    registers: 0,
    sales: 0,
    movements: 0,
    stockRows: 0,
  };

  // --- 1. Ensure a default branch exists ----------------------------------
  let branch = await prisma.branch.findFirst({
    where: { orgId: org.id, deletedAt: null },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  });

  if (!branch) {
    if (DRY) {
      report.branchCreated = true;
      // Nothing else can be reported accurately without the branch id, so
      // fall through with counts of what WOULD move.
      report.registers = await prisma.register.count({ where: { orgId: org.id, branchId: null } });
      report.sales = await prisma.sale.count({ where: { orgId: org.id, branchId: null } });
      report.movements = await prisma.stockMovement.count({ where: { orgId: org.id, branchId: null } });
      report.stockRows = await prisma.product.count({
        where: { orgId: org.id, deletedAt: null, trackStock: true },
      });
      return report;
    }
    branch = await prisma.branch.create({
      data: { orgId: org.id, name: 'Main', code: 'BR-01', isDefault: true },
    });
    report.branchCreated = true;
  } else if (!branch.isDefault && !DRY) {
    // A branch exists but none is flagged default (possible if someone
    // created one by hand). Promote the oldest.
    branch = await prisma.branch.update({ where: { id: branch.id }, data: { isDefault: true } });
  }

  const branchId = branch.id;

  if (DRY) {
    report.registers = await prisma.register.count({ where: { orgId: org.id, branchId: null } });
    report.sales = await prisma.sale.count({ where: { orgId: org.id, branchId: null } });
    report.movements = await prisma.stockMovement.count({ where: { orgId: org.id, branchId: null } });
    const tracked = await prisma.product.findMany({
      where: { orgId: org.id, deletedAt: null, trackStock: true },
      select: { id: true },
    });
    const existing = await prisma.branchStock.count({ where: { orgId: org.id, branchId } });
    report.stockRows = Math.max(0, tracked.length - existing);
    return report;
  }

  // --- 2. Attach orphaned rows to it --------------------------------------
  // Each updateMany filters on `branchId: null`, so a second run matches
  // nothing. Wrapped per-org so a failure here doesn't strand a half-linked
  // tenant.
  await prisma.$transaction(async (tx) => {
    report.registers = (
      await tx.register.updateMany({ where: { orgId: org.id, branchId: null }, data: { branchId } })
    ).count;

    report.sales = (
      await tx.sale.updateMany({ where: { orgId: org.id, branchId: null }, data: { branchId } })
    ).count;

    report.movements = (
      await tx.stockMovement.updateMany({ where: { orgId: org.id, branchId: null }, data: { branchId } })
    ).count;
  });

  // --- 3. Seed per-branch stock from the org-wide balance ------------------
  // Pre-P3, `Product.stockQty` WAS the only balance. With one branch, the
  // branch balance is identical — so we copy it across rather than
  // recomputing from the ledger (which would be wrong for shops that were
  // adjusting stock before the ledger existed).
  const tracked = await prisma.product.findMany({
    where: { orgId: org.id, deletedAt: null, trackStock: true },
    select: { id: true, stockQty: true, lowStockAt: true },
  });

  for (const product of tracked) {
    const existing = await prisma.branchStock.findUnique({
      where: { branchId_productId: { branchId, productId: product.id } },
    });
    if (existing) continue; // already seeded — leave live data alone

    await prisma.branchStock.create({
      data: {
        orgId: org.id,
        branchId,
        productId: product.id,
        qty: product.stockQty,
        lowStockAt: product.lowStockAt,
      },
    });
    report.stockRows += 1;
  }

  return report;
}

async function main(): Promise<void> {
  const started = Date.now();
  console.log(DRY ? '🔍 P3 backfill — DRY RUN (no changes)\n' : '🔧 P3 backfill — applying\n');

  const orgs = await prisma.organization.findMany({
    where: { deletedAt: null },
    select: { id: true, slug: true, name: true },
    orderBy: { createdAt: 'asc' },
  });

  if (orgs.length === 0) {
    console.log('No organizations found — nothing to do.');
    return;
  }

  const totals = { branches: 0, registers: 0, sales: 0, movements: 0, stockRows: 0, failed: 0 };

  for (const org of orgs) {
    try {
      const r = await backfillOrg(org);
      const touched = r.branchCreated || r.registers || r.sales || r.movements || r.stockRows;

      if (touched) {
        console.log(
          `  ${r.branchCreated ? '🏬' : '  '} ${org.slug.padEnd(28)} ` +
            `branch:${r.branchCreated ? 'created' : 'ok'.padEnd(7)} ` +
            `registers:${String(r.registers).padStart(3)} ` +
            `sales:${String(r.sales).padStart(6)} ` +
            `moves:${String(r.movements).padStart(6)} ` +
            `stock:${String(r.stockRows).padStart(4)}`,
        );
      }

      if (r.branchCreated) totals.branches += 1;
      totals.registers += r.registers;
      totals.sales += r.sales;
      totals.movements += r.movements;
      totals.stockRows += r.stockRows;
    } catch (err) {
      totals.failed += 1;
      const message = err instanceof Prisma.PrismaClientKnownRequestError ? `${err.code} ${err.message}` : String(err);
      console.error(`  ❌ ${org.slug}: ${message}`);
    }
  }

  console.log('\n─────────────────────────────────────────────');
  console.log(`Organizations scanned : ${orgs.length}`);
  console.log(`Branches created      : ${totals.branches}`);
  console.log(`Registers linked      : ${totals.registers}`);
  console.log(`Sales linked          : ${totals.sales}`);
  console.log(`Stock movements linked: ${totals.movements}`);
  console.log(`Branch stock seeded   : ${totals.stockRows}`);
  if (totals.failed > 0) console.log(`⚠️  Organizations failed : ${totals.failed}`);
  console.log(`Took ${((Date.now() - started) / 1000).toFixed(1)}s`);

  if (DRY) {
    console.log('\nDry run — nothing was written. Re-run without --dry to apply.');
  } else if (totals.failed === 0) {
    console.log('\n✅ Backfill complete. Safe to run again — it is idempotent.');
  } else {
    console.log('\n⚠️  Some organizations failed. Fix the cause and re-run — completed orgs are skipped.');
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
