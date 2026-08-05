import { it, expect, beforeAll, afterAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { describeDb, createShop, createProduct, createCustomer, saleBody, closeDb, type Shop } from './fixtures.js';

/**
 * The five invariants a POS is not allowed to violate. Each one is enforced by
 * the database, not by application code being careful — these tests prove the
 * enforcement is really there.
 */

let prisma: PrismaClient;

beforeAll(async () => {
  ({ prisma } = await import('../../src/lib/prisma.js'));
});

afterAll(closeDb);

// ---------------------------------------------------------------------------

describeDb('invariant: a sale syncs exactly once, however many times it is sent', () => {
  let shop: Shop;
  beforeAll(async () => {
    shop = await createShop('Idempotency Shop');
  });

  it('replays a duplicate clientUuid as "duplicate", not as a second sale', async () => {
    const sale = saleBody();

    const first = await shop.api('post', '/sales/sync').send({ sales: [sale] });
    expect(first.status).toBe(200);
    expect(first.body.data.results[0].status).toBe('created');

    // Same payload again — a phone that lost the response and retried.
    const second = await shop.api('post', '/sales/sync').send({ sales: [sale] });
    expect(second.body.data.results[0].status).toBe('duplicate');

    // Same sale, same receipt number. The customer is not charged twice and
    // the shop does not see a phantom sale in its Z-report.
    expect(second.body.data.results[0].id).toBe(first.body.data.results[0].id);
    expect(second.body.data.results[0].number).toBe(first.body.data.results[0].number);

    const count = await prisma.sale.count({ where: { orgId: shop.orgId, clientUuid: sale.clientUuid } });
    expect(count).toBe(1);

    // Both are purgeable — the device is told it may drop them from the outbox.
    expect(second.body.data.purgeable).toContain(sale.clientUuid);
  });

  it('keeps the good sales in a batch when one of them is bad', async () => {
    const good = saleBody();
    // A branch this org does not own. Stock attribution decides which shelf
    // decrements, so an unknown branchId refuses outright rather than falling
    // back — unlike customerId/shiftId/registerId, which are dropped so a
    // stale id can never strand an outbox. See domain/tenancy.ts.
    const bad = saleBody({ branchId: 'clnotarealbranchid000000' });

    const res = await shop.api('post', '/sales/sync').send({ sales: [good, bad] });
    expect(res.status).toBe(200);

    const byUuid = Object.fromEntries(
      (res.body.data.results as Array<{ clientUuid: string; status: string }>).map((r) => [r.clientUuid, r.status]),
    );
    expect(byUuid[good.clientUuid]).toBe('created');
    expect(byUuid[bad.clientUuid]).not.toBe('created');
    // The failed one is NOT purgeable — the device keeps it and can retry.
    expect(res.body.data.purgeable).not.toContain(bad.clientUuid);
  });
});

// ---------------------------------------------------------------------------

describeDb('invariant: receipt numbers are gap-free under concurrency', () => {
  let shop: Shop;
  beforeAll(async () => {
    shop = await createShop('Concurrency Shop');
  });

  it('gives twelve simultaneous terminals the numbers 1..12, no gaps, no repeats', async () => {
    const N = 12;
    const results = await Promise.all(
      Array.from({ length: N }, () => shop.api('post', '/sales/sync').send({ sales: [saleBody()] })),
    );

    for (const res of results) {
      expect(res.status).toBe(200);
      expect(res.body.data.results[0].status).toBe('created');
    }

    const sales = await prisma.sale.findMany({ where: { orgId: shop.orgId }, select: { number: true } });
    const numbers = sales.map((s) => s.number).sort((a, b) => a - b);

    expect(numbers).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    expect(new Set(numbers).size).toBe(N); // no duplicates
  });
});

// ---------------------------------------------------------------------------

describeDb('invariant: the stock ledger reconciles to the cached balance', () => {
  let shop: Shop;
  let productId: string;

  beforeAll(async () => {
    shop = await createShop('Stock Shop');
    productId = (await createProduct(shop, { stockQty: 0 })).id;
  });

  it('agrees with the sum of its movements after receive, adjust, count and sale', async () => {
    const receive = await shop
      .api('post', '/stock/receive')
      .send({ supplier: 'Test Supplier', rows: [{ productId, qty: 100, unitCost: 60 }] });
    expect(receive.status).toBe(201);

    const adjust = await shop.api('post', '/stock/adjust').send({ productId, qty: -7, note: 'Breakage' });
    expect(adjust.status).toBe(200);

    const count = await shop.api('post', '/stock/count').send({ productId, counted: 50, note: 'Stocktake' });
    expect(count.status).toBe(200);

    const sale = await shop.api('post', '/sales/sync').send({
      sales: [saleBody({ items: [{ productId, name: 'Widget', unitPrice: 100, qty: 3 }], tendered: 300 })],
    });
    expect(sale.body.data.results[0].status).toBe('created');

    const [product, movements] = await Promise.all([
      prisma.product.findUniqueOrThrow({ where: { id: productId }, select: { stockQty: true } }),
      prisma.stockMovement.findMany({ where: { orgId: shop.orgId, productId }, select: { qty: true, type: true } }),
    ]);

    // +100 receive, −7 adjust, −43 count correction, −3 sale.
    const ledger = movements.reduce((sum, m) => sum + Number(m.qty), 0);
    expect(Number(product.stockQty)).toBe(47);
    expect(ledger).toBe(47);
    expect(movements.map((m) => m.type).sort()).toEqual(['ADJUST', 'COUNT', 'RECEIVE', 'SALE']);
  });
});

// ---------------------------------------------------------------------------

describeDb('invariant: a loyalty balance never goes negative', () => {
  let shop: Shop;
  let customerId: string;

  beforeAll(async () => {
    shop = await createShop('Loyalty Shop');
    customerId = (await createCustomer(shop)).id;
    // Pin the economics so the arithmetic below is exact: 1 point per unit
    // spent, 100 points = 1.00 of discount, 100 points minimum to redeem.
    await prisma.organization.update({
      where: { id: shop.orgId },
      data: { loyaltyEnabled: true, loyaltyEarnRate: 1, loyaltyRedeemValue: 0.01, loyaltyMinRedeem: 100 },
    });
    const seed = await shop.api('post', '/loyalty/adjust').send({ customerId, points: 5000, note: 'Test seed' });
    expect(seed.status).toBe(200);
  });

  const balance = async () =>
    Number((await prisma.customer.findUniqueOrThrow({ where: { id: customerId }, select: { loyaltyPoints: true } })).loyaltyPoints);

  it('cannot be drained past zero by a device asking for everything', async () => {
    // Bill of 20. The device requests a million points; 2000 is all 20.00 buys.
    const res = await shop.api('post', '/sales/sync').send({
      sales: [saleBody({ customerId, redeemPoints: 1_000_000, items: [{ name: 'Item', unitPrice: 20, qty: 1 }], tendered: 0 })],
    });
    expect(res.body.data.results[0].status).toBe('created');

    const sale = await prisma.sale.findUniqueOrThrow({ where: { id: res.body.data.results[0].id } });
    expect(Number(sale.pointsRedeemed)).toBe(2000);
    expect(Number(sale.loyaltyDiscount)).toBe(20);
    expect(Number(sale.total)).toBe(0); // paid entirely in points
    expect(Number(sale.total)).toBeGreaterThanOrEqual(0); // and never below it

    expect(await balance()).toBe(3000);
  });

  it('spends the rest, earns on what was actually paid, and lands exactly at zero', async () => {
    const res = await shop.api('post', '/sales/sync').send({
      sales: [saleBody({ customerId, redeemPoints: 1_000_000, items: [{ name: 'Item', unitPrice: 100, qty: 1 }], tendered: 100 })],
    });
    const sale = await prisma.sale.findUniqueOrThrow({ where: { id: res.body.data.results[0].id } });

    expect(Number(sale.pointsRedeemed)).toBe(3000); // the whole balance
    expect(Number(sale.total)).toBe(70); // 100 − 30.00 of points
    expect(Number(sale.pointsEarned)).toBe(70); // earned on 70, not on 100

    expect(await balance()).toBe(70);
  });

  it('refuses to redeem a balance below the minimum-redeem floor', async () => {
    const res = await shop.api('post', '/sales/sync').send({
      sales: [saleBody({ customerId, redeemPoints: 1_000_000, items: [{ name: 'Item', unitPrice: 100, qty: 1 }], tendered: 100 })],
    });
    const sale = await prisma.sale.findUniqueOrThrow({ where: { id: res.body.data.results[0].id } });

    expect(Number(sale.pointsRedeemed)).toBe(0); // 70 points < the 100 floor
    expect(Number(sale.total)).toBe(100);
    expect(await balance()).toBe(170);
  });

  it('reconciles: the append-only ledger sums to the cached balance', async () => {
    const txns = await prisma.loyaltyTransaction.findMany({
      where: { orgId: shop.orgId, customerId },
      select: { points: true },
    });
    const ledger = txns.reduce((sum, t) => sum + Number(t.points), 0);
    expect(ledger).toBe(await balance());
    expect(ledger).toBe(170);
  });
});
