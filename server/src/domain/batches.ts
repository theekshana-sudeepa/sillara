import { Prisma } from '@prisma/client';
import { D } from '../lib/money.js';

/**
 * ---------------------------------------------------------------------------
 * FIRST EXPIRED, FIRST OUT
 * ---------------------------------------------------------------------------
 * A pharmacy holding three deliveries of the same drug must sell the one that
 * expires soonest, and the cashier must not have to think about it. Asking at
 * the till would be slower, and would be answered wrongly under pressure.
 *
 * So allocation is automatic and invisible: a sale of 12 consumes 5 from the
 * batch expiring in March and 7 from the one expiring in June, and the ledger
 * records both. What the shop gets from that is a truthful expiry report and
 * an honest cost of goods.
 *
 * Pure — no Prisma client, no clock. The ordering rules are the part worth
 * testing, and they test in microseconds.
 * ---------------------------------------------------------------------------
 */

export interface AllocatableBatch {
  id: string;
  /** String tolerated because MySQL returns DECIMAL that way over raw SQL. */
  qty: Prisma.Decimal | number | string;
  expiresAt: Date | null;
  receivedAt: Date;
  unitCost?: Prisma.Decimal | number | string | null;
}

export interface Allocation {
  batchId: string | null;
  qty: Prisma.Decimal;
  unitCost: Prisma.Decimal | null;
}

/**
 * Soonest expiry first.
 *
 * Undated stock sorts last, not first. A batch with no expiry never goes off,
 * so anything dated is more urgent — shipping the undated one first would
 * guarantee the dated stock expires on the shelf. Ties break on what arrived
 * earliest, which is FIFO within a date and matches how a shelf is stacked.
 */
export function fefoOrder(batches: readonly AllocatableBatch[]): AllocatableBatch[] {
  return [...batches].sort((a, b) => {
    if (a.expiresAt && b.expiresAt) {
      const diff = a.expiresAt.getTime() - b.expiresAt.getTime();
      if (diff !== 0) return diff;
    } else if (a.expiresAt !== b.expiresAt) {
      return a.expiresAt ? -1 : 1;
    }
    return a.receivedAt.getTime() - b.receivedAt.getTime();
  });
}

/**
 * Split `qty` (a positive amount leaving the shelf) across batches, oldest
 * expiry first.
 *
 * When the batches cannot cover it the remainder comes back as a single
 * allocation with `batchId: null`. That is an oversell — the shop sold stock
 * it never recorded receiving — and the honest record is a movement that says
 * so, rather than pushing a batch negative and quietly corrupting the expiry
 * report. The till still completes the sale: refusing to serve a customer
 * because the paperwork is behind is not a decision software should make.
 */
export function allocateFefo(qty: Prisma.Decimal | number, batches: readonly AllocatableBatch[]): Allocation[] {
  let remaining = D(qty);
  if (remaining.lte(0)) return [];

  const out: Allocation[] = [];

  for (const batch of fefoOrder(batches)) {
    if (remaining.lte(0)) break;
    const available = D(batch.qty);
    if (available.lte(0)) continue;

    const take = Prisma.Decimal.min(available, remaining);
    out.push({
      batchId: batch.id,
      qty: take,
      unitCost: batch.unitCost != null ? D(batch.unitCost) : null,
    });
    remaining = remaining.minus(take);
  }

  if (remaining.gt(0)) {
    out.push({ batchId: null, qty: remaining, unitCost: null });
  }

  return out;
}

/**
 * The cost of goods for a sale that drew on several batches.
 *
 * Two deliveries at different prices make one sale line, so the cost is the
 * weighted average of what was actually consumed — not the product's current
 * cost, which is the mistake the profit report used to make.
 */
export function allocatedUnitCost(allocations: readonly Allocation[]): Prisma.Decimal | null {
  const costed = allocations.filter((a) => a.unitCost != null && a.qty.gt(0));
  if (costed.length === 0) return null;

  const qty = costed.reduce((s, a) => s.plus(a.qty), D(0));
  if (qty.lte(0)) return null;

  const value = costed.reduce((s, a) => s.plus(a.qty.mul(a.unitCost!)), D(0));
  return value.div(qty).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}
