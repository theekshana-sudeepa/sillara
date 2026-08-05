import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { computeTotals, allocate, resolveTaxRate } from './tax.js';
import { D, money } from './money.js';

const line = (lineTotal: number, taxRate: number) => ({ lineTotal: D(lineTotal), taxRate: D(taxRate) });
const n = (v: Prisma.Decimal) => Number(v.toString());

describe('allocate — splitting a discount across lines', () => {
  it('sums to exactly the amount even when it does not divide evenly', () => {
    const parts = allocate(D(10), [D(1), D(1), D(1)]);
    expect(parts.map(n)).toEqual([3.34, 3.33, 3.33]);
    expect(n(parts.reduce((s, p) => s.plus(p), D(0)))).toBe(10);
  });

  it('weights by line size', () => {
    const parts = allocate(D(100), [D(750), D(250)]);
    expect(parts.map(n)).toEqual([75, 25]);
  });

  it('never invents a cent from nothing', () => {
    for (const amount of [0.01, 0.05, 33.33, 99.99, 1234.56]) {
      const parts = allocate(D(amount), [D(3), D(5), D(7), D(11)]);
      expect(n(parts.reduce((s, p) => s.plus(p), D(0)))).toBe(amount);
    }
  });

  it('allocates nothing when there is nothing to allocate', () => {
    expect(allocate(D(0), [D(5), D(5)]).map(n)).toEqual([0, 0]);
    expect(allocate(D(50), []).map(n)).toEqual([]);
    expect(allocate(D(50), [D(0), D(0)]).map(n)).toEqual([0, 0]);
  });
});

describe('computeTotals — tax-inclusive (Sri Lanka, UK, most of retail EU)', () => {
  it('pulls tax out of the shelf price and leaves the total alone', () => {
    const t = computeTotals({
      lines: [line(115, 15)],
      billDiscount: D(0),
      loyaltyDiscount: D(0),
      taxInclusive: true,
    });
    expect(n(t.total)).toBe(115); // the customer pays what the shelf said
    expect(n(t.tax)).toBe(15);
    expect(n(t.lines[0]!.netExTax)).toBe(100);
  });

  it('reproduces the old whole-bill formula exactly, so no shop sees a change', () => {
    // What the previous implementation did: tax = taxable × rate / (100 + rate)
    // on the post-discount total, and total = taxable.
    for (const [subtotal, discount, rate] of [
      [1000, 0, 15],
      [1000, 150, 15],
      [2499.99, 99.99, 8],
      [777.77, 0, 12.5],
    ] as const) {
      const legacyTaxable = money(D(subtotal).minus(D(discount)));
      const legacyTax = money(legacyTaxable.mul(D(rate)).div(D(100).plus(D(rate))));

      const t = computeTotals({
        lines: [line(subtotal, rate)],
        billDiscount: D(discount),
        loyaltyDiscount: D(0),
        taxInclusive: true,
      });

      expect(n(t.total)).toBe(n(legacyTaxable));
      expect(n(t.tax)).toBe(n(legacyTax));
    }
  });
});

describe('computeTotals — tax-exclusive (US, Canada, Australia)', () => {
  it('adds tax on top instead of digging it out', () => {
    const t = computeTotals({
      lines: [line(100, 8)],
      billDiscount: D(0),
      loyaltyDiscount: D(0),
      taxInclusive: false,
    });
    // The bug this replaces: the shop charged 100 and owed 7.41 of it in tax.
    expect(n(t.total)).toBe(108);
    expect(n(t.tax)).toBe(8);
    expect(n(t.lines[0]!.netExTax)).toBe(100);
  });

  it('taxes the discounted price, not the ticket price', () => {
    const t = computeTotals({
      lines: [line(100, 10)],
      billDiscount: D(20),
      loyaltyDiscount: D(0),
      taxInclusive: false,
    });
    expect(n(t.lines[0]!.netExTax)).toBe(80);
    expect(n(t.tax)).toBe(8);
    expect(n(t.total)).toBe(88);
  });
});

describe('computeTotals — mixed baskets', () => {
  it('taxes each line at its own rate (zero-rated food beside standard-rated soap)', () => {
    const t = computeTotals({
      lines: [line(500, 0), line(230, 15)],
      billDiscount: D(0),
      loyaltyDiscount: D(0),
      taxInclusive: true,
    });
    expect(n(t.tax)).toBe(30); // only the soap is taxed
    expect(n(t.total)).toBe(730);
    expect(t.breakdown).toEqual([
      { rate: 0, netExTax: 500, tax: 0 },
      { rate: 15, netExTax: 200, tax: 30 },
    ]);
  });

  it('spreads a bill discount across rates in proportion', () => {
    const t = computeTotals({
      lines: [line(600, 0), line(400, 10)],
      billDiscount: D(100),
      loyaltyDiscount: D(0),
      taxInclusive: false,
    });
    // 60/40 split of the 100 discount → 540 zero-rated, 360 at 10%.
    expect(n(t.lines[0]!.netExTax)).toBe(540);
    expect(n(t.lines[1]!.netExTax)).toBe(360);
    expect(n(t.tax)).toBe(36);
    expect(n(t.total)).toBe(936);
  });

  it('treats loyalty as a discount, not as revenue', () => {
    const t = computeTotals({
      lines: [line(1000, 15)],
      billDiscount: D(0),
      loyaltyDiscount: D(200),
      taxInclusive: true,
    });
    expect(n(t.total)).toBe(800);
    expect(n(t.tax)).toBe(104.35);
    expect(n(t.lines[0]!.netExTax)).toBe(695.65);
  });
});

describe('computeTotals — the arithmetic must always close', () => {
  it('keeps Σ(netExTax) + Σ(tax) === total, across shapes and modes', () => {
    const shapes = [
      [line(33.33, 15), line(66.67, 0), line(0.01, 8)],
      [line(19.99, 12.5), line(4.95, 12.5)],
      [line(1, 15), line(1, 15), line(1, 15)],
      [line(999999.99, 20)],
    ];
    for (const lines of shapes) {
      for (const taxInclusive of [true, false]) {
        for (const discount of [0, 0.01, 5, 13.37]) {
          const t = computeTotals({
            lines,
            billDiscount: D(discount),
            loyaltyDiscount: D(0),
            taxInclusive,
          });
          const sum = t.lines.reduce((s, l) => s.plus(l.netExTax).plus(l.taxAmount), D(0));
          expect(n(money(sum))).toBe(n(t.total));
        }
      }
    }
  });

  it('refuses to let discounts drive a bill negative', () => {
    const t = computeTotals({
      lines: [line(50, 15)],
      billDiscount: D(80),
      loyaltyDiscount: D(40),
      taxInclusive: true,
    });
    expect(n(t.total)).toBe(0);
    expect(n(t.tax)).toBe(0);
  });
});

describe('resolveTaxRate — line beats product beats org', () => {
  it('inherits through the chain when nothing is set', () => {
    expect(n(resolveTaxRate(undefined, null, D(15)))).toBe(15);
    expect(n(resolveTaxRate(null, D(8), D(15)))).toBe(8);
    expect(n(resolveTaxRate(5, D(8), D(15)))).toBe(5);
  });

  it('keeps an explicit zero — untaxed bread is not an unset rate', () => {
    expect(n(resolveTaxRate(0, D(15), D(15)))).toBe(0);
    expect(n(resolveTaxRate(null, D(0), D(15)))).toBe(0);
  });
});
