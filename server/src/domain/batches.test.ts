import { describe, it, expect } from 'vitest';
import { allocateFefo, fefoOrder, allocatedUnitCost } from './batches.js';
import { D } from '../lib/money.js';

const batch = (id: string, qty: number, expires: string | null, received = '2026-01-01', unitCost?: number) => ({
  id,
  qty,
  expiresAt: expires ? new Date(expires) : null,
  receivedAt: new Date(received),
  unitCost: unitCost ?? null,
});

const n = (v: { toString(): string }) => Number(v.toString());

describe('fefoOrder', () => {
  it('puts the soonest expiry first', () => {
    const order = fefoOrder([batch('c', 5, '2026-12-01'), batch('a', 5, '2026-03-01'), batch('b', 5, '2026-06-01')]);
    expect(order.map((b) => b.id)).toEqual(['a', 'b', 'c']);
  });

  it('sorts undated stock LAST, not first', () => {
    // Undated stock never goes off. Shipping it first would guarantee the
    // dated stock expires on the shelf — the exact loss this exists to stop.
    const order = fefoOrder([batch('none', 5, null), batch('dated', 5, '2027-01-01')]);
    expect(order.map((b) => b.id)).toEqual(['dated', 'none']);
  });

  it('breaks ties on what arrived first, which is how a shelf is stacked', () => {
    const order = fefoOrder([
      batch('late', 5, '2026-06-01', '2026-02-01'),
      batch('early', 5, '2026-06-01', '2026-01-01'),
    ]);
    expect(order.map((b) => b.id)).toEqual(['early', 'late']);
  });
});

describe('allocateFefo', () => {
  it('takes everything from one batch when it can', () => {
    const out = allocateFefo(3, [batch('a', 10, '2026-03-01')]);
    expect(out).toHaveLength(1);
    expect(out[0]!.batchId).toBe('a');
    expect(n(out[0]!.qty)).toBe(3);
  });

  it('spills across batches, oldest expiry first', () => {
    const out = allocateFefo(12, [batch('june', 20, '2026-06-01'), batch('march', 5, '2026-03-01')]);
    expect(out.map((a) => [a.batchId, n(a.qty)])).toEqual([
      ['march', 5],
      ['june', 7],
    ]);
  });

  it('skips a batch that is already empty', () => {
    const out = allocateFefo(4, [batch('empty', 0, '2026-01-01'), batch('stocked', 10, '2026-09-01')]);
    expect(out).toHaveLength(1);
    expect(out[0]!.batchId).toBe('stocked');
  });

  it('records an oversell as unbatched rather than pushing a batch negative', () => {
    // Selling stock nobody recorded receiving is a real event. Saying so
    // keeps the expiry report truthful; hiding it inside a batch does not.
    const out = allocateFefo(10, [batch('a', 4, '2026-03-01')]);
    expect(out.map((a) => [a.batchId, n(a.qty)])).toEqual([
      ['a', 4],
      [null, 6],
    ]);
  });

  it('is entirely unbatched when there are no batches at all', () => {
    const out = allocateFefo(5, []);
    expect(out).toEqual([expect.objectContaining({ batchId: null })]);
    expect(n(out[0]!.qty)).toBe(5);
  });

  it('always allocates exactly what was asked for', () => {
    for (const want of [1, 7, 13.5, 0.001, 999]) {
      const out = allocateFefo(want, [batch('a', 5, '2026-03-01'), batch('b', 5, '2026-06-01')]);
      const total = out.reduce((s, a) => s.plus(a.qty), D(0));
      expect(n(total)).toBe(want);
    }
  });

  it('allocates nothing for a zero or negative request', () => {
    expect(allocateFefo(0, [batch('a', 5, '2026-03-01')])).toEqual([]);
    expect(allocateFefo(-3, [batch('a', 5, '2026-03-01')])).toEqual([]);
  });

  it('handles fractional quantities without losing a gram', () => {
    const out = allocateFefo(2.75, [batch('a', 1.5, '2026-03-01', '2026-01-01', 10), batch('b', 5, '2026-06-01')]);
    expect(n(out.reduce((s, a) => s.plus(a.qty), D(0)))).toBe(2.75);
    expect(n(out[0]!.qty)).toBe(1.5);
    expect(n(out[1]!.qty)).toBe(1.25);
  });
});

describe('allocatedUnitCost', () => {
  it('weights the cost by what was actually taken from each batch', () => {
    // 5 at 10 and 5 at 20 is 15, not "the latest price".
    const out = allocateFefo(10, [
      batch('cheap', 5, '2026-03-01', '2026-01-01', 10),
      batch('dear', 5, '2026-06-01', '2026-01-01', 20),
    ]);
    expect(n(allocatedUnitCost(out)!)).toBe(15);
  });

  it('ignores the unbatched remainder, which has no known cost', () => {
    const out = allocateFefo(10, [batch('a', 4, '2026-03-01', '2026-01-01', 12)]);
    expect(n(allocatedUnitCost(out)!)).toBe(12);
  });

  it('is null when nothing consumed had a cost', () => {
    expect(allocatedUnitCost(allocateFefo(5, [batch('a', 10, '2026-03-01')]))).toBeNull();
    expect(allocatedUnitCost([])).toBeNull();
  });
});
