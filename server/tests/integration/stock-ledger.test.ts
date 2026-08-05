import { it, expect, beforeAll, afterAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { describeDb, createShop, createProduct, createCustomer, saleBody, closeDb, type Shop } from './fixtures.js';

/**
 * The ledger is the truth; the balances are caches of it.
 *
 * `products.stockQty` and `branch_stock.qty` are both derived from
 * `stock_movements`, and every route that moves stock has to keep all three in
 * step. The org rollup was always right, which is exactly why the per-branch
 * balance could be wrong for months without anyone noticing: sales debited the
 * branch, and receiving, stocktakes and voids never credited it back.
 *
 * So these tests assert the reconciliation directly — Σ movements == the cached
 * balance, per branch — after each kind of movement and after all of them
 * together. A test that only checked the org rollup would have passed
 * throughout the entire period the bug existed.
 */

let prisma: PrismaClient;

beforeAll(async () => {
  ({ prisma } = await import('../../src/lib/prisma.js'));
});

afterAll(closeDb);

async function defaultBranchId(orgId: string): Promise<string> {
  const branch = await prisma.branch.findFirstOrThrow({ where: { orgId, isDefault: true, deletedAt: null } });
  return branch.id;
}

async function branchQty(branchId: string, productId: string): Promise<number> {
  const row = await prisma.branchStock.findUnique({ where: { branchId_productId: { branchId, productId } } });
  return row ? Number(row.qty) : 0;
}

async function orgQty(productId: string): Promise<number> {
  const p = await prisma.product.findUniqueOrThrow({ where: { id: productId }, select: { stockQty: true } });
  return Number(p.stockQty);
}

/** Σ of the ledger for one product at one branch. */
async function ledgerAtBranch(orgId: string, branchId: string, productId: string): Promise<number> {
  const agg = await prisma.stockMovement.aggregate({
    where: { orgId, branchId, productId },
    _sum: { qty: true },
  });
  return Number(agg._sum.qty ?? 0);
}

// ---------------------------------------------------------------------------

describeDb('invariant: branch_stock always equals the sum of its movements', () => {
  let shop: Shop;
  let branchId: string;

  beforeAll(async () => {
    shop = await createShop('Ledger Shop');
    branchId = await defaultBranchId(shop.orgId);
  });

  it('credits the branch when goods are received directly (Shelfie v2 path)', async () => {
    const product = await createProduct(shop);

    const res = await shop.api('post', '/stock/receive').send({
      supplier: 'Acme Distributors',
      rows: [{ productId: product.id, qty: 40, unitCost: 60 }],
    });
    expect(res.status).toBe(201);

    // The bug: this path credited only the org rollup, so the branch shelf
    // stayed at zero while the sell screen said 40.
    expect(await branchQty(branchId, product.id)).toBe(40);
    expect(await orgQty(product.id)).toBe(40);
    expect(await ledgerAtBranch(shop.orgId, branchId, product.id)).toBe(40);
  });

  it('debits the branch when something sells', async () => {
    const product = await createProduct(shop);
    await shop.api('post', '/stock/receive').send({ rows: [{ productId: product.id, qty: 10, unitCost: 5 }] });

    const res = await shop.api('post', '/sales/sync').send({
      sales: [saleBody({ items: [{ productId: product.id, name: 'Item', unitPrice: 100, qty: 3 }] })],
    });
    expect(res.body.data.results[0].status).toBe('created');

    expect(await branchQty(branchId, product.id)).toBe(7);
    expect(await ledgerAtBranch(shop.orgId, branchId, product.id)).toBe(7);
  });

  it('returns stock to the branch it left when a sale is voided', async () => {
    const product = await createProduct(shop);
    await shop.api('post', '/stock/receive').send({ rows: [{ productId: product.id, qty: 10, unitCost: 5 }] });

    const sale = await shop.api('post', '/sales/sync').send({
      sales: [saleBody({ items: [{ productId: product.id, name: 'Item', unitPrice: 100, qty: 4 }] })],
    });
    const saleId = sale.body.data.results[0].id as string;
    expect(await branchQty(branchId, product.id)).toBe(6);

    const voided = await shop.api('post', `/sales/${saleId}/void`).send({ reason: 'Customer changed their mind' });
    expect(voided.status).toBe(200);

    // The bug: the void credited the org rollup and wrote a movement with no
    // branch at all, so the branch stayed at 6 forever and drifted further
    // down with every subsequent void.
    expect(await branchQty(branchId, product.id)).toBe(10);
    expect(await orgQty(product.id)).toBe(10);
    expect(await ledgerAtBranch(shop.orgId, branchId, product.id)).toBe(10);
  });

  it('sets the branch shelf to the counted figure on a stocktake', async () => {
    const product = await createProduct(shop);
    await shop.api('post', '/stock/receive').send({ rows: [{ productId: product.id, qty: 20, unitCost: 5 }] });

    const res = await shop.api('post', '/stock/count').send({ productId: product.id, counted: 17, note: 'Monday count' });
    expect(res.status).toBe(200);
    expect(res.body.data.delta).toBe(-3); // three unaccounted for

    expect(await branchQty(branchId, product.id)).toBe(17);
    expect(await ledgerAtBranch(shop.orgId, branchId, product.id)).toBe(17);
  });

  it('moves the branch shelf on a manual adjustment', async () => {
    const product = await createProduct(shop);
    await shop.api('post', '/stock/receive').send({ rows: [{ productId: product.id, qty: 12, unitCost: 5 }] });

    await shop.api('post', '/stock/adjust').send({ productId: product.id, qty: -2, note: 'Breakage' });

    expect(await branchQty(branchId, product.id)).toBe(10);
    expect(await ledgerAtBranch(shop.orgId, branchId, product.id)).toBe(10);
  });

  it('reconciles after a full mixed day: receive, sell, adjust, count, void', async () => {
    const product = await createProduct(shop);

    await shop.api('post', '/stock/receive').send({ rows: [{ productId: product.id, qty: 100, unitCost: 8 }] });
    const sale = await shop.api('post', '/sales/sync').send({
      sales: [saleBody({ items: [{ productId: product.id, name: 'Item', unitPrice: 20, qty: 9 }] })],
    });
    await shop.api('post', '/sales/sync').send({
      sales: [saleBody({ items: [{ productId: product.id, name: 'Item', unitPrice: 20, qty: 4 }] })],
    });
    await shop.api('post', '/stock/adjust').send({ productId: product.id, qty: -1, note: 'Damaged in transit' });
    await shop.api('post', `/sales/${sale.body.data.results[0].id}/void`).send({ reason: 'Wrong item scanned' });
    await shop.api('post', '/stock/count').send({ productId: product.id, counted: 90, note: 'End of day' });

    const cached = await branchQty(branchId, product.id);
    const ledger = await ledgerAtBranch(shop.orgId, branchId, product.id);

    expect(cached).toBe(90);
    expect(ledger).toBe(90);
    expect(cached).toBe(ledger);
  });
});

// ---------------------------------------------------------------------------

describeDb('invariant: voiding a sale gives back the points it took', () => {
  let shop: Shop;

  beforeAll(async () => {
    shop = await createShop('Loyalty Void Shop');
    await shop.api('patch', '/org').send({
      loyaltyEnabled: true,
      loyaltyEarnRate: 1,
      loyaltyRedeemValue: 0.01,
      loyaltyMinRedeem: 0,
    });
  });

  it('takes back the points a voided sale granted', async () => {
    const customer = await createCustomer(shop, 'Points Earner');

    const sale = await shop.api('post', '/sales/sync').send({
      sales: [saleBody({ customerId: customer.id, items: [{ name: 'Item', unitPrice: 500, qty: 1 }] })],
    });
    const saleId = sale.body.data.results[0].id as string;

    const earned = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
    expect(Number(earned.loyaltyPoints)).toBe(500);

    await shop.api('post', `/sales/${saleId}/void`).send({ reason: 'Cashier error' });

    // The bug: the customer kept 500 points for a sale that no longer exists.
    const after = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
    expect(Number(after.loyaltyPoints)).toBe(0);
  });

  it('returns the points a voided sale spent', async () => {
    const customer = await createCustomer(shop, 'Points Spender');

    // Earn a balance on one sale, spend it on the next.
    await shop.api('post', '/sales/sync').send({
      sales: [saleBody({ customerId: customer.id, items: [{ name: 'Item', unitPrice: 1000, qty: 1 }] })],
    });
    const before = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
    expect(Number(before.loyaltyPoints)).toBe(1000);

    const redeeming = await shop.api('post', '/sales/sync').send({
      sales: [
        saleBody({
          customerId: customer.id,
          redeemPoints: 400,
          items: [{ name: 'Item', unitPrice: 100, qty: 1 }],
        }),
      ],
    });
    const saleId = redeeming.body.data.results[0].id as string;

    const spent = await prisma.sale.findUniqueOrThrow({ where: { id: saleId } });
    expect(Number(spent.pointsRedeemed)).toBeGreaterThan(0);

    const midBalance = Number(
      (await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })).loyaltyPoints,
    );

    await shop.api('post', `/sales/${saleId}/void`).send({ reason: 'Refunded at the counter' });

    // Points spent come back; points earned on that same sale go away.
    const after = Number((await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })).loyaltyPoints);
    const expected = midBalance + Number(spent.pointsRedeemed) - Number(spent.pointsEarned);
    expect(after).toBe(expected);
  });

  it('never pushes a balance negative, and the ledger still explains it', async () => {
    const customer = await createCustomer(shop, 'Spent It All');

    const sale = await shop.api('post', '/sales/sync').send({
      sales: [saleBody({ customerId: customer.id, items: [{ name: 'Item', unitPrice: 300, qty: 1 }] })],
    });
    const saleId = sale.body.data.results[0].id as string;

    // Spend the lot before the void lands.
    await prisma.customer.update({ where: { id: customer.id }, data: { loyaltyPoints: 0 } });
    await prisma.loyaltyTransaction.create({
      data: { orgId: shop.orgId, customerId: customer.id, type: 'REDEEM', points: -300, note: 'spent elsewhere' },
    });

    await shop.api('post', `/sales/${saleId}/void`).send({ reason: 'Void after the points were spent' });

    const after = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
    expect(Number(after.loyaltyPoints)).toBe(0);
    expect(Number(after.loyaltyPoints)).toBeGreaterThanOrEqual(0);

    // Balance still equals the ledger — we clamped the write AND the row.
    const agg = await prisma.loyaltyTransaction.aggregate({
      where: { orgId: shop.orgId, customerId: customer.id },
      _sum: { points: true },
    });
    expect(Number(agg._sum.points ?? 0)).toBe(Number(after.loyaltyPoints));
  });
});

// ---------------------------------------------------------------------------

describeDb('invariant: a device cannot post stock to another shop', () => {
  it('refuses a sale carrying a branchId that belongs to someone else', async () => {
    const mine = await createShop('My Shop');
    const theirs = await createShop('Their Shop');
    const theirBranch = await defaultBranchId(theirs.orgId);

    const product = await createProduct(mine);
    await mine.api('post', '/stock/receive').send({ rows: [{ productId: product.id, qty: 5, unitCost: 1 }] });

    const res = await mine.api('post', '/sales/sync').send({
      sales: [
        saleBody({
          branchId: theirBranch,
          items: [{ productId: product.id, name: 'Item', unitPrice: 10, qty: 1 }],
        }),
      ],
    });

    // Rejected as one bad line, not a 400 that would strand the whole outbox.
    expect(res.status).toBe(200);
    expect(res.body.data.results[0].status).toBe('failed');

    // Nothing of mine touched their shelf.
    const polluted = await prisma.branchStock.findUnique({
      where: { branchId_productId: { branchId: theirBranch, productId: product.id } },
    });
    expect(polluted).toBeNull();

    const strayMovements = await prisma.stockMovement.count({
      where: { branchId: theirBranch, orgId: mine.orgId },
    });
    expect(strayMovements).toBe(0);
  });

  it('refuses a stocktake aimed at another shop’s branch', async () => {
    const mine = await createShop('Counter Shop');
    const theirs = await createShop('Victim Shop');
    const theirBranch = await defaultBranchId(theirs.orgId);
    const product = await createProduct(mine);

    const res = await mine
      .api('post', '/stock/count')
      .send({ productId: product.id, branchId: theirBranch, counted: 999, note: 'not mine to count' });

    expect(res.status).toBe(404);
    expect(await branchQty(theirBranch, product.id)).toBe(0);
  });
});
