import type { Prisma } from '@prisma/client';
import { D, toNumber } from '../../lib/money.js';

/**
 * The loyalty maths, deliberately kept out of the route file.
 *
 * Points are money. A device that could name its own discount could empty a
 * till, so this runs server-side during sale sync and nowhere else. Living in
 * its own module — no express, no prisma client, no env — it is a pure
 * function of (balance, org economics, bill) and unit-tests in milliseconds
 * against a stub. See loyalty.test.ts.
 */

export interface LoyaltyOutcome {
  discount: number;
  pointsRedeemed: number;
  pointsEarned: number;
}

/** The org-level economics, read from Organization at sale time. */
export interface LoyaltyEconomics {
  loyaltyEnabled: boolean;
  loyaltyEarnRate: unknown;
  loyaltyRedeemValue: unknown;
  loyaltyMinRedeem: number;
}

/**
 * The only database access loyalty needs: the customer's cached balance.
 * Typed structurally so a Prisma transaction client satisfies it, and so a
 * five-line stub does too.
 */
export interface LoyaltyBalanceReader {
  customer: {
    findFirst: (args: {
      where: { id: string; orgId: string; deletedAt: null };
      select: { loyaltyPoints: true };
    }) => Promise<{ loyaltyPoints: Prisma.Decimal | number } | null>;
  };
}

export interface LoyaltyParams {
  orgId: string;
  customerId: string | null;
  requestedRedeemPoints: number;
  subtotalAfterDiscount: number;
  org: LoyaltyEconomics;
}

/**
 * Server-side loyalty application, called from the sale sync path.
 * Returns the discount to apply and the points delta — the caller writes both
 * inside its own transaction so a sale and its points can never diverge.
 */
export async function computeLoyalty(
  tx: LoyaltyBalanceReader,
  params: LoyaltyParams,
): Promise<LoyaltyOutcome> {
  const none: LoyaltyOutcome = { discount: 0, pointsRedeemed: 0, pointsEarned: 0 };
  if (!params.org.loyaltyEnabled || !params.customerId) return none;

  const customer = await tx.customer.findFirst({
    where: { id: params.customerId, orgId: params.orgId, deletedAt: null },
    select: { loyaltyPoints: true },
  });
  if (!customer) return none;

  const redeemValue = toNumber(params.org.loyaltyRedeemValue as never);
  const earnRate = toNumber(params.org.loyaltyEarnRate as never);
  const balance = toNumber(customer.loyaltyPoints as never);

  // Redeem: capped by balance, by the min-redeem floor, and by the bill
  // itself — points can never make a sale negative.
  //
  // The bill cap divides in DECIMAL, not float. `20 / 0.01` in IEEE 754 is
  // 1999.9999…, and flooring that shorts the customer a point on exactly the
  // redemption they care about most: paying off the whole bill.
  let pointsRedeemed = 0;
  let discount = 0;
  if (params.requestedRedeemPoints > 0 && balance >= params.org.loyaltyMinRedeem && redeemValue > 0) {
    const maxByBalance = Math.min(params.requestedRedeemPoints, balance);
    const maxByBill = Number(D(params.subtotalAfterDiscount).div(D(redeemValue)).floor().toString());
    pointsRedeemed = Math.max(0, Math.min(maxByBalance, maxByBill));
    discount = Number(D(pointsRedeemed).mul(D(redeemValue)).toDecimalPlaces(2).toString());
  }

  // Earn on what the customer actually paid, not on the pre-discount total.
  const payable = Math.max(0, Number(D(params.subtotalAfterDiscount).minus(D(discount)).toString()));
  const pointsEarned = Number(D(payable).mul(D(earnRate)).floor().toString());

  return { discount, pointsRedeemed, pointsEarned };
}
