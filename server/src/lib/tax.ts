import { Prisma } from '@prisma/client';
import { D, money } from './money.js';

/**
 * ---------------------------------------------------------------------------
 * WHAT THE CUSTOMER OWES, AND WHOSE MONEY IT IS
 * ---------------------------------------------------------------------------
 * Two things were wrong before this module existed.
 *
 * `Organization.taxInclusive` was stored, editable, and never read: the sale
 * path always ran the inclusive formula. Correct for Sri Lanka and most of
 * retail Europe, wrong for every jurisdiction that adds tax at the till — the
 * US, Canada, Australia. A shop there charging 8% on a $100 basket collected
 * $100 and booked $7.41 of it as tax it then owed. It absorbed the tax on
 * every sale it ever made.
 *
 * And tax was computed on the whole bill at the org rate, while `SaleItem`
 * carefully carried a per-line rate nobody used. A supermarket selling
 * zero-rated rice next to standard-rated soap got one blended wrong answer.
 *
 * So: rates resolve per line (line → product → org), tax is computed per line,
 * and inclusive/exclusive is a branch rather than an assumption.
 *
 * Pure — no Prisma, no Express, no clock. Same shape as `decideLifecycle` and
 * `computeLoyalty`, and unit-tested the same way.
 * ---------------------------------------------------------------------------
 */

export interface TaxableLine {
  /** Gross for the line: unitPrice × qty, less any line-level discount. */
  lineTotal: Prisma.Decimal;
  /** Already resolved by the caller: line rate, else product, else org. */
  taxRate: Prisma.Decimal;
}

export interface TotalsInput {
  lines: readonly TaxableLine[];
  /** Whole-bill discount typed by the cashier. */
  billDiscount: Prisma.Decimal;
  /** Currency value bought with loyalty points. */
  loyaltyDiscount: Prisma.Decimal;
  /** True: shelf prices already contain tax. False: tax is added at the till. */
  taxInclusive: boolean;
}

export interface LineTotals {
  /** Revenue for this line: after every discount, never including tax. */
  netExTax: Prisma.Decimal;
  /** Tax on this line. */
  taxAmount: Prisma.Decimal;
}

export interface Totals {
  /** Σ lineTotal — what the basket came to before bill-level reductions. */
  subtotal: Prisma.Decimal;
  discount: Prisma.Decimal;
  loyaltyDiscount: Prisma.Decimal;
  tax: Prisma.Decimal;
  /** What the customer actually pays. */
  total: Prisma.Decimal;
  lines: LineTotals[];
  /** One entry per distinct rate — what a filed return needs. */
  breakdown: Array<{ rate: number; netExTax: number; tax: number }>;
}

/**
 * Split `amount` across `weights` proportionally, in whole cents, so the parts
 * sum to exactly `amount`.
 *
 * Naive per-line rounding loses or invents a cent on split bills, and a cent
 * that appears from nowhere is the kind of thing an auditor pulls a whole
 * ledger apart over. Largest-remainder: floor everything, then hand the
 * leftover cents to the lines with the biggest fractional parts.
 */
export function allocate(amount: Prisma.Decimal, weights: readonly Prisma.Decimal[]): Prisma.Decimal[] {
  const zeros = weights.map(() => D(0));
  if (amount.isZero() || weights.length === 0) return zeros;

  const totalWeight = weights.reduce((s, w) => s.plus(w), D(0));
  if (totalWeight.lte(0)) return zeros;

  const exact = weights.map((w) => amount.mul(w).div(totalWeight));
  const floored = exact.map((v) => v.toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN));

  const distributed = floored.reduce((s, v) => s.plus(v), D(0));
  let remainder = amount.minus(distributed).mul(100).round().toNumber();

  const order = exact
    .map((v, i) => ({ i, frac: v.minus(floored[i]!) }))
    .sort((a, b) => b.frac.comparedTo(a.frac));

  const out = [...floored];
  for (let k = 0; remainder > 0 && k < order.length; k += 1, remainder -= 1) {
    const idx = order[k]!.i;
    out[idx] = out[idx]!.plus(D('0.01'));
  }
  return out;
}

/**
 * The whole money calculation for one sale.
 *
 * Bill-level reductions (the cashier's discount, the loyalty discount) are
 * spread across lines in proportion to what each line contributed, because tax
 * is a per-line question and a discount has to land somewhere before the rate
 * can be applied to it.
 */
export function computeTotals(input: TotalsInput): Totals {
  const { lines, taxInclusive } = input;

  const subtotal = lines.reduce((s, l) => s.plus(l.lineTotal), D(0));
  const billDiscount = money(input.billDiscount);
  const loyaltyDiscount = money(input.loyaltyDiscount);

  // Never let reductions exceed the basket — a negative bill is not a refund,
  // it is a bug that hands out cash.
  const reduction = Prisma.Decimal.min(money(billDiscount.plus(loyaltyDiscount)), subtotal);
  const weights = lines.map((l) => l.lineTotal);
  const shares = allocate(reduction, weights);

  const out: LineTotals[] = [];
  const byRate = new Map<string, { rate: number; netExTax: Prisma.Decimal; tax: Prisma.Decimal }>();

  lines.forEach((line, i) => {
    const net = line.lineTotal.minus(shares[i]!);
    const rate = D(line.taxRate);

    let netExTax: Prisma.Decimal;
    let taxAmount: Prisma.Decimal;

    if (rate.lte(0)) {
      netExTax = money(net);
      taxAmount = D(0);
    } else if (taxInclusive) {
      // The price already contains the tax; pull it back out.
      taxAmount = money(net.mul(rate).div(D(100).plus(rate)));
      netExTax = money(net.minus(taxAmount));
    } else {
      // The price is before tax; the till adds it on.
      netExTax = money(net);
      taxAmount = money(netExTax.mul(rate).div(100));
    }

    out.push({ netExTax, taxAmount });

    const key = rate.toString();
    const bucket = byRate.get(key) ?? { rate: rate.toNumber(), netExTax: D(0), tax: D(0) };
    bucket.netExTax = bucket.netExTax.plus(netExTax);
    bucket.tax = bucket.tax.plus(taxAmount);
    byRate.set(key, bucket);
  });

  const tax = out.reduce((s, l) => s.plus(l.taxAmount), D(0));
  const netExTax = out.reduce((s, l) => s.plus(l.netExTax), D(0));

  return {
    subtotal: money(subtotal),
    discount: billDiscount,
    loyaltyDiscount,
    tax: money(tax),
    // Both modes agree here: the customer pays revenue plus tax. Inclusive
    // just means that sum equals the shelf price they already saw.
    total: money(netExTax.plus(tax)),
    lines: out,
    breakdown: [...byRate.values()]
      .sort((a, b) => a.rate - b.rate)
      .map((b) => ({ rate: b.rate, netExTax: b.netExTax.toNumber(), tax: b.tax.toNumber() })),
  };
}

/**
 * line → product → org.
 *
 * `null`/`undefined` means "inherit"; an explicit 0 means zero-rated and must
 * survive the chain — that is the difference between untaxed bread and a line
 * nobody set a rate on.
 */
export function resolveTaxRate(
  lineRate: number | null | undefined,
  productRate: Prisma.Decimal | null | undefined,
  orgRate: Prisma.Decimal | number,
): Prisma.Decimal {
  if (lineRate !== null && lineRate !== undefined) return D(lineRate);
  if (productRate !== null && productRate !== undefined) return D(productRate);
  return D(orgRate);
}
