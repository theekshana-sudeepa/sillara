import { Prisma, type CreditTxnType, type TenderType } from '@prisma/client';
import { D, money } from '../lib/money.js';

/**
 * ---------------------------------------------------------------------------
 * THE CUSTOMER TAB
 * ---------------------------------------------------------------------------
 * `TenderType.CREDIT` and `Customer.creditBalance` both shipped from the
 * beginning, and nothing in the codebase ever wrote to the balance. An
 * on-account sale therefore booked revenue, counted itself into the day's
 * takings, and left no receivable anywhere — the shop had no way to answer
 * "who owes me money?", which for a wholesaler is most of the question.
 *
 * Same shape as the stock and loyalty ledgers: the transactions are the truth,
 * `Customer.creditBalance` is a cache of their sum, and both move together in
 * one transaction or not at all.
 *
 * Sign convention: positive means the customer owes more.
 * ---------------------------------------------------------------------------
 */

export interface CreditPosting {
  customerId: string;
  type: CreditTxnType;
  /** Signed. CHARGE positive, SETTLE negative. */
  amount: Prisma.Decimal | number;
  saleId?: string | null;
  method?: TenderType | null;
  note?: string | null;
}

export async function postCredit(
  tx: Prisma.TransactionClient,
  ctx: { orgId: string; userId?: string | null },
  postings: readonly CreditPosting[],
): Promise<void> {
  for (const posting of postings) {
    const amount = money(posting.amount);
    if (amount.isZero()) continue;

    await tx.customer.update({
      where: { id: posting.customerId },
      data: { creditBalance: { increment: amount } },
    });

    await tx.customerCreditTransaction.create({
      data: {
        orgId: ctx.orgId,
        customerId: posting.customerId,
        saleId: posting.saleId ?? null,
        type: posting.type,
        amount,
        method: posting.method ?? null,
        note: posting.note ?? null,
        createdById: ctx.userId ?? null,
      },
    });
  }
}

/**
 * What a sale puts on the tab: the CREDIT portion of its settlement.
 *
 * A bill paid half in cash and half on account charges only the half that went
 * on account — which is exactly the case a single `tender` enum could not
 * express, and the reason this is computed from payments rather than from a
 * flag on the sale.
 */
export function creditPortion(payments: readonly { type: TenderType; amount: Prisma.Decimal }[]): Prisma.Decimal {
  return payments.filter((p) => p.type === 'CREDIT').reduce((s, p) => s.plus(p.amount), D(0));
}
