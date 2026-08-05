import { Prisma, type TenderType } from '@prisma/client';
import { D, money } from '../lib/money.js';
import { BadRequest } from '../lib/errors.js';

/**
 * ---------------------------------------------------------------------------
 * HOW A BILL WAS SETTLED
 * ---------------------------------------------------------------------------
 * A sale used to carry one `tender` enum, so "half in cash, half on the card"
 * was not unimplemented — it could not be written down. Every real shop takes
 * split payment; the ones that take it most are exactly the ones whose bills
 * are large enough to matter.
 *
 * One rule governs this table: the payments have to add up to the bill. If
 * they do not, the drawer will not reconcile at close, and nobody will know
 * which of the day's four hundred sales was the wrong one.
 * ---------------------------------------------------------------------------
 */

export interface PaymentInput {
  type: TenderType;
  amount: number;
  /** Cash only: what the customer handed over. */
  tendered?: number | null;
  reference?: string | null;
}

export interface ResolvedPayment {
  type: TenderType;
  amount: Prisma.Decimal;
  tendered: Prisma.Decimal | null;
  change: Prisma.Decimal | null;
  reference: string | null;
}

export interface SettlementResult {
  payments: ResolvedPayment[];
  /** The largest single tender — what the receipt and legacy reports show. */
  primaryTender: TenderType;
  /** Cash handed over across the whole bill, and what went back. */
  tendered: Prisma.Decimal;
  change: Prisma.Decimal;
}

/**
 * Validate a settlement against the bill it is paying, and work out the change.
 *
 * `total` is signed: positive for a sale, negative for a refund. Payments must
 * carry the same sign — a refund gives money back, and a positive payment on a
 * negative bill is a mistake worth refusing rather than averaging out.
 *
 * Change belongs to cash and only cash. Overpaying a card is not a thing that
 * happens; overpaying with a note is the normal case, and the difference has
 * to come back out of the drawer.
 */
export function settle(total: Prisma.Decimal, inputs: readonly PaymentInput[]): SettlementResult {
  if (inputs.length === 0) throw BadRequest('A sale needs at least one payment');

  const isRefund = total.lt(0);
  const fallbackTender = inputs[0]!.type;

  // A bill can legitimately come to nothing — settled entirely in loyalty
  // points, or discounted to zero. No money changes hands, so there are no
  // payment rows to write, and Σ(payments) == 0 == total still holds. A
  // zero-amount row would be a lie about a transaction that did not occur.
  const lines = inputs.filter((p) => !money(p.amount).isZero());
  if (total.isZero()) {
    if (lines.length > 0) throw BadRequest('This bill came to zero — there is nothing to pay');
    return { payments: [], primaryTender: fallbackTender, tendered: D(0), change: D(0) };
  }
  if (lines.length === 0) throw BadRequest('A sale needs at least one payment');

  const payments: ResolvedPayment[] = lines.map((p) => {
    const amount = money(p.amount);
    if (isRefund ? amount.gt(0) : amount.lt(0)) {
      throw BadRequest(
        isRefund
          ? 'Refund payments must be negative — money is going back to the customer'
          : 'Payment amounts must be positive',
      );
    }
    return {
      type: p.type,
      amount,
      tendered: p.tendered != null ? money(p.tendered) : null,
      change: null,
      reference: p.reference?.slice(0, 80) ?? null,
    };
  });

  const paid = payments.reduce((s, p) => s.plus(p.amount), D(0));
  const over = paid.minus(total); // positive: more came in than the bill

  if (!over.isZero()) {
    // A customer handing over a 5000 note for a 4300 bill is the ordinary
    // case, and the surplus is change out of the drawer. Everything else is
    // refused: an underpaid bill is an unrecorded debt wearing the costume of
    // a completed sale, and an overpaid card is not a thing that happens.
    const cash = payments.find((p) => p.type === 'CASH');
    if (isRefund || over.lt(0) || !cash) {
      throw BadRequest(
        `Payments come to ${paid.toFixed(2)} but the bill is ${total.toFixed(2)} — ` +
          `${over.abs().toFixed(2)} ${over.lt(0) ? 'is missing' : 'is unaccounted for'}`,
      );
    }
    // The drawer keeps the bill; the rest goes back across the counter.
    cash.tendered = cash.amount;
    cash.amount = money(cash.amount.minus(over));
    cash.change = money(over);
  }

  for (const p of payments) {
    // Tendered and change describe notes crossing a counter. On a refund the
    // money moves the other way and neither means anything.
    if (p.type === 'CASH' && !isRefund) {
      p.tendered = p.tendered ?? p.amount;
      p.change = p.change ?? money(p.tendered.minus(p.amount));
    } else {
      p.tendered = null;
      p.change = null;
    }
  }

  const primary = payments.reduce((a, b) => (b.amount.abs().gt(a.amount.abs()) ? b : a));

  return {
    payments,
    primaryTender: primary.type,
    tendered: payments.reduce((s, p) => s.plus(p.tendered ?? D(0)), D(0)),
    change: payments.reduce((s, p) => s.plus(p.change ?? D(0)), D(0)),
  };
}

/**
 * The legacy single-tender shape, expressed as a settlement.
 *
 * Devices that predate split payment send `tender` + `tendered`, and an outbox
 * can hold those for days. They keep working, and land as one payment row.
 */
export function settleLegacy(total: Prisma.Decimal, tender: TenderType, tendered: number): SettlementResult {
  const amount = Number(total.toString());
  return settle(total, [
    {
      type: tender,
      // The bill is settled in full by definition — the device already took
      // the money. `tendered` only records what was handed over, so change
      // comes out of the difference.
      amount,
      tendered: tender === 'CASH' ? Math.max(tendered, amount) : null,
    },
  ]);
}
