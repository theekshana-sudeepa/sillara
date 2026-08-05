import { describe, it, expect } from 'vitest';
import { D, money, toNumber } from './money.js';

/**
 * Money rounding is where quiet, expensive bugs live. These tests pin the two
 * decisions the whole platform rests on: DECIMAL not float, and ROUND_HALF_UP.
 */
describe('money()', () => {
  it('rounds half UP, not to-even — the accounting convention we bill on', () => {
    // Banker's rounding would give 2.34 here. Retail expects 2.35.
    expect(money(2.345).toFixed(2)).toBe('2.35');
    expect(money(2.355).toFixed(2)).toBe('2.36');
    expect(money(0.005).toFixed(2)).toBe('0.01');
  });

  it('does not drift the way floats do', () => {
    // The classic: 0.1 + 0.2 !== 0.3 in IEEE 754.
    expect(D(0.1).plus(0.2).equals(D(0.3))).toBe(true);
    expect(money(D(0.1).plus(0.2)).toFixed(2)).toBe('0.30');
  });

  it('survives a hundred additions without losing a cent', () => {
    let total = D(0);
    for (let i = 0; i < 100; i += 1) total = total.plus(D('0.07'));
    expect(money(total).toFixed(2)).toBe('7.00');
  });

  it('keeps large retail totals exact', () => {
    const line = money(D(1250.75).mul(37));
    expect(line.toFixed(2)).toBe('46277.75');
  });

  it('toNumber() is null-safe so a missing aggregate reads as zero', () => {
    expect(toNumber(null)).toBe(0);
    expect(toNumber(undefined)).toBe(0);
    expect(toNumber(D('12.34'))).toBe(12.34);
  });
});

/**
 * The sale-total pipeline, mirrored from sales.routes.ts. If these expectations
 * change, the route changed — and that is exactly when someone should look.
 */
describe('sale total pipeline', () => {
  const lineTotal = (unitPrice: number, qty: number, lineDiscount = 0) =>
    money(money(D(unitPrice).mul(qty)).minus(money(lineDiscount)));

  it('computes a line as (price × qty) − line discount', () => {
    expect(lineTotal(120.5, 3).toFixed(2)).toBe('361.50');
    expect(lineTotal(120.5, 3, 11.5).toFixed(2)).toBe('350.00');
  });

  it('derives tax OUT of a tax-inclusive total, never adds it on', () => {
    // Rs.1150 at 15% inclusive → tax is 150, not 172.50.
    const taxable = money(1150);
    const rate = D(15);
    const tax = money(taxable.mul(rate).div(D(100).plus(rate)));
    expect(tax.toFixed(2)).toBe('150.00');
    expect(taxable.toFixed(2)).toBe('1150.00'); // total is unchanged by tax
  });

  it('gives no change when tendered is short', () => {
    const total = money(500);
    const tendered = money(450);
    const change = tendered.gt(total) ? money(tendered.minus(total)) : D(0);
    expect(change.toFixed(2)).toBe('0.00');
  });
});
