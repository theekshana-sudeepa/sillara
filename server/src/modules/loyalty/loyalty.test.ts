import { describe, it, expect } from 'vitest';
import { computeLoyalty, type LoyaltyBalanceReader, type LoyaltyEconomics } from './loyalty.logic.js';

/**
 * Loyalty is the one place a device could mint money if the server trusted it.
 * computeLoyalty takes its `tx` as a parameter, so it unit-tests with a stub —
 * no database, no fixtures, runs in milliseconds.
 *
 * Every cap in here exists because without it a cashier could zero out a bill.
 */

/** Stands in for the transaction client: one balance lookup, nothing else. */
const txWith = (loyaltyPoints: number | null): LoyaltyBalanceReader => ({
  customer: {
    findFirst: async () => (loyaltyPoints === null ? null : { loyaltyPoints }),
  },
});

const org = (over: Partial<LoyaltyEconomics> = {}): LoyaltyEconomics => ({
  loyaltyEnabled: true,
  loyaltyEarnRate: 1, // 1 point per currency unit spent
  loyaltyRedeemValue: 0.01, // 100 points = 1 unit
  loyaltyMinRedeem: 100,
  ...over,
});

describe('computeLoyalty — earning', () => {
  it('earns on what the customer actually paid, not the pre-discount total', async () => {
    const out = await computeLoyalty(txWith(500), {
      orgId: 'org1',
      customerId: 'cus1',
      requestedRedeemPoints: 100, // worth 1.00
      subtotalAfterDiscount: 250,
      org: org(),
    });
    expect(out.discount).toBe(1);
    // 250 − 1 paid → 249 points, NOT 250.
    expect(out.pointsEarned).toBe(249);
  });

  it('floors fractional points rather than rounding up', async () => {
    const out = await computeLoyalty(txWith(0), {
      orgId: 'org1',
      customerId: 'cus1',
      requestedRedeemPoints: 0,
      subtotalAfterDiscount: 99.99,
      org: org({ loyaltyEarnRate: 0.5 }),
    });
    expect(out.pointsEarned).toBe(49); // 49.995 floored
  });
});

describe('computeLoyalty — the three redemption caps', () => {
  it('caps at the balance the customer actually holds', async () => {
    const out = await computeLoyalty(txWith(150), {
      orgId: 'org1',
      customerId: 'cus1',
      requestedRedeemPoints: 10_000, // device asks for far more
      subtotalAfterDiscount: 500,
      org: org(),
    });
    expect(out.pointsRedeemed).toBe(150);
    expect(out.discount).toBe(1.5);
  });

  it('caps at the bill — points can never make a sale negative', async () => {
    const out = await computeLoyalty(txWith(100_000), {
      orgId: 'org1',
      customerId: 'cus1',
      requestedRedeemPoints: 100_000, // worth 1000.00
      subtotalAfterDiscount: 20, // bill is only 20
      org: org(),
    });
    expect(out.discount).toBeLessThanOrEqual(20);
    expect(out.pointsRedeemed).toBe(2000); // exactly 20.00 worth
    expect(out.pointsEarned).toBe(0); // nothing left to pay, nothing earned
  });

  it('refuses to redeem below the minimum-redeem floor', async () => {
    const out = await computeLoyalty(txWith(99), {
      orgId: 'org1',
      customerId: 'cus1',
      requestedRedeemPoints: 99,
      subtotalAfterDiscount: 500,
      org: org({ loyaltyMinRedeem: 100 }),
    });
    expect(out.pointsRedeemed).toBe(0);
    expect(out.discount).toBe(0);
    expect(out.pointsEarned).toBe(500); // still earns normally
  });
});

describe('computeLoyalty — the off switches', () => {
  it('is inert when loyalty is disabled for the org', async () => {
    const out = await computeLoyalty(txWith(5000), {
      orgId: 'org1',
      customerId: 'cus1',
      requestedRedeemPoints: 5000,
      subtotalAfterDiscount: 500,
      org: org({ loyaltyEnabled: false }),
    });
    expect(out).toEqual({ discount: 0, pointsRedeemed: 0, pointsEarned: 0 });
  });

  it('is inert with no customer attached', async () => {
    const out = await computeLoyalty(txWith(5000), {
      orgId: 'org1',
      customerId: null,
      requestedRedeemPoints: 5000,
      subtotalAfterDiscount: 500,
      org: org(),
    });
    expect(out.pointsEarned).toBe(0);
  });

  it('is inert when the customer belongs to another org (findFirst returns null)', async () => {
    const out = await computeLoyalty(txWith(null), {
      orgId: 'org1',
      customerId: 'cus-from-another-shop',
      requestedRedeemPoints: 5000,
      subtotalAfterDiscount: 500,
      org: org(),
    });
    expect(out).toEqual({ discount: 0, pointsRedeemed: 0, pointsEarned: 0 });
  });

  it('never redeems when the point value is zero (avoids a divide-by-zero cap)', async () => {
    const out = await computeLoyalty(txWith(10_000), {
      orgId: 'org1',
      customerId: 'cus1',
      requestedRedeemPoints: 10_000,
      subtotalAfterDiscount: 500,
      org: org({ loyaltyRedeemValue: 0 }),
    });
    expect(out.pointsRedeemed).toBe(0);
    expect(out.discount).toBe(0);
  });
});
