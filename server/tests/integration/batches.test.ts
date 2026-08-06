import { it, expect, beforeAll, afterAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { describeDb, createShop, createProduct, saleBody, closeDb, type Shop } from './fixtures.js';

/**
 * Batches and expiry, end to end.
 *
 * FEFO allocation is unit-tested against its ordering rules; these prove the
 * consequence — that selling draws down the right lot automatically, that the
 * batch balance stays a faithful cache of the movements carrying its id, and
 * that a shop can be told what is about to go out of date.
 */

let prisma: PrismaClient;

beforeAll(async () => {
  ({ prisma } = await import('../../src/lib/prisma.js'));
});

afterAll(closeDb);

async function pharmacy(name: string): Promise<Shop> {
  const shop = await createShop(name);
  await prisma.organization.update({ where: { id: shop.orgId }, data: { planCode: 'PRO' } });
  await shop.api('patch', '/org/business-type').send({ businessType: 'PHARMACY' });
  return shop;
}

const iso = (daysFromNow: number) => new Date(Date.now() + daysFromNow * 86_400_000).toISOString().slice(0, 10);

async function batchesOf(orgId: string, productId: string) {
  return prisma.stockBatch.findMany({ where: { orgId, productId }, orderBy: { expiresAt: 'asc' } });
}

// ---------------------------------------------------------------------------

describeDb('receiving creates the lot', () => {
  it('turns a delivery with an expiry into a batch', async () => {
    const shop = await pharmacy('Batch Receiving');
    const product = await createProduct(shop, { price: 500 });

    await shop.api('post', '/stock/receive').send({
      rows: [{ productId: product.id, qty: 40, unitCost: 200, batchNo: 'LOT-A', expiresAt: iso(90) }],
    });

    const [batch] = await batchesOf(shop.orgId, product.id);
    expect(batch!.batchNo).toBe('LOT-A');
    expect(Number(batch!.qty)).toBe(40);
    expect(Number(batch!.unitCost)).toBe(200);
  });

  it('tops up the same lot instead of splitting the shelf in two', async () => {
    const shop = await pharmacy('Top Up Shop');
    const product = await createProduct(shop, { price: 500 });
    const row = { productId: product.id, qty: 10, unitCost: 200, batchNo: 'LOT-A', expiresAt: iso(60) };

    await shop.api('post', '/stock/receive').send({ rows: [row] });
    await shop.api('post', '/stock/receive').send({ rows: [row] });

    const batches = await batchesOf(shop.orgId, product.id);
    expect(batches).toHaveLength(1);
    expect(Number(batches[0]!.qty)).toBe(20);
  });

  it('leaves stock unbatched when the delivery has no lot or date', async () => {
    const shop = await pharmacy('No Lot Shop');
    const product = await createProduct(shop, { price: 500 });

    await shop.api('post', '/stock/receive').send({ rows: [{ productId: product.id, qty: 15, unitCost: 100 }] });

    expect(await batchesOf(shop.orgId, product.id)).toHaveLength(0);
    // The ordinary ledger still works — batches are additive, not a rewrite.
    const fresh = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(Number(fresh.stockQty)).toBe(15);
  });
});

// ---------------------------------------------------------------------------

describeDb('selling draws down the soonest expiry, without being asked', () => {
  it('takes from the lot that expires first', async () => {
    const shop = await pharmacy('FEFO Shop');
    const product = await createProduct(shop, { price: 500 });

    await shop.api('post', '/stock/receive').send({
      rows: [{ productId: product.id, qty: 10, unitCost: 100, batchNo: 'LATE', expiresAt: iso(180) }],
    });
    await shop.api('post', '/stock/receive').send({
      rows: [{ productId: product.id, qty: 10, unitCost: 100, batchNo: 'SOON', expiresAt: iso(20) }],
    });

    await shop.api('post', '/sales/sync').send({
      sales: [saleBody({ items: [{ productId: product.id, name: 'Item', unitPrice: 500, qty: 4 }] })],
    });

    const batches = await batchesOf(shop.orgId, product.id);
    const soon = batches.find((b) => b.batchNo === 'SOON')!;
    const late = batches.find((b) => b.batchNo === 'LATE')!;

    // The cashier chose nothing. The shelf that would have gone in the bin
    // is the one that emptied.
    expect(Number(soon.qty)).toBe(6);
    expect(Number(late.qty)).toBe(10);
  });

  it('spills into the next lot when one cannot cover the sale', async () => {
    const shop = await pharmacy('Spill Shop');
    const product = await createProduct(shop, { price: 500 });

    await shop.api('post', '/stock/receive').send({
      rows: [{ productId: product.id, qty: 5, unitCost: 100, batchNo: 'SOON', expiresAt: iso(10) }],
    });
    await shop.api('post', '/stock/receive').send({
      rows: [{ productId: product.id, qty: 20, unitCost: 100, batchNo: 'LATE', expiresAt: iso(200) }],
    });

    await shop.api('post', '/sales/sync').send({
      sales: [saleBody({ items: [{ productId: product.id, name: 'Item', unitPrice: 500, qty: 12 }] })],
    });

    const batches = await batchesOf(shop.orgId, product.id);
    expect(Number(batches.find((b) => b.batchNo === 'SOON')!.qty)).toBe(0);
    expect(Number(batches.find((b) => b.batchNo === 'LATE')!.qty)).toBe(13);

    // One line off the shelf, two ledger rows — one per lot it drew on.
    const saleMoves = await prisma.stockMovement.findMany({
      where: { orgId: shop.orgId, productId: product.id, type: 'SALE' },
    });
    expect(saleMoves).toHaveLength(2);
    expect(saleMoves.every((m) => m.batchId)).toBe(true);
  });

  it('still completes the sale when the shelf runs out, and says it was unbatched', async () => {
    const shop = await pharmacy('Oversell Shop');
    const product = await createProduct(shop, { price: 500 });

    await shop.api('post', '/stock/receive').send({
      rows: [{ productId: product.id, qty: 3, unitCost: 100, batchNo: 'ONLY', expiresAt: iso(30) }],
    });

    const res = await shop.api('post', '/sales/sync').send({
      sales: [saleBody({ items: [{ productId: product.id, name: 'Item', unitPrice: 500, qty: 8 }] })],
    });

    // Refusing to serve a customer because the paperwork is behind is not a
    // decision software should make.
    expect(res.body.data.results[0].status).toBe('created');

    const moves = await prisma.stockMovement.findMany({
      where: { orgId: shop.orgId, productId: product.id, type: 'SALE' },
    });
    expect(moves).toHaveLength(2);
    expect(Number(moves.find((m) => m.batchId)!.qty)).toBe(-3);
    expect(Number(moves.find((m) => !m.batchId)!.qty)).toBe(-5);
    // The lot is empty, not negative — the expiry report stays truthful.
    expect(Number((await batchesOf(shop.orgId, product.id))[0]!.qty)).toBe(0);
  });

  it('does not allocate for a shop that has batches switched off', async () => {
    const shop = await createShop('Plain Shop');
    await prisma.organization.update({ where: { id: shop.orgId }, data: { planCode: 'PRO' } });
    const product = await createProduct(shop, { price: 500 });

    await shop.api('post', '/stock/receive').send({
      rows: [{ productId: product.id, qty: 10, unitCost: 100, batchNo: 'IGNORED', expiresAt: iso(30) }],
    });
    await shop.api('post', '/sales/sync').send({
      sales: [saleBody({ items: [{ productId: product.id, name: 'Item', unitPrice: 500, qty: 2 }] })],
    });

    expect(await batchesOf(shop.orgId, product.id)).toHaveLength(0);
    const fresh = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(Number(fresh.stockQty)).toBe(8);
  });
});

// ---------------------------------------------------------------------------

describeDb('the batch balance is a cache of its movements', () => {
  it('reconciles after a mixed day of receiving and selling', async () => {
    const shop = await pharmacy('Reconcile Shop');
    const product = await createProduct(shop, { price: 500 });

    await shop.api('post', '/stock/receive').send({
      rows: [{ productId: product.id, qty: 30, unitCost: 90, batchNo: 'A', expiresAt: iso(15) }],
    });
    await shop.api('post', '/stock/receive').send({
      rows: [{ productId: product.id, qty: 30, unitCost: 110, batchNo: 'B', expiresAt: iso(120) }],
    });
    for (const qty of [4, 9, 21]) {
      await shop.api('post', '/sales/sync').send({
        sales: [saleBody({ items: [{ productId: product.id, name: 'Item', unitPrice: 500, qty }] })],
      });
    }

    for (const batch of await batchesOf(shop.orgId, product.id)) {
      const agg = await prisma.stockMovement.aggregate({
        where: { batchId: batch.id },
        _sum: { qty: true },
      });
      expect(Number(batch.qty)).toBe(Number(agg._sum.qty ?? 0));
    }
  });
});

// ---------------------------------------------------------------------------

describeDb('the shop is told what is about to go off', () => {
  it('lists lots inside the horizon, soonest first, with what they cost', async () => {
    const shop = await pharmacy('Expiry Report Shop');
    const soon = await createProduct(shop, { price: 500 });
    const later = await createProduct(shop, { price: 500 });

    await shop.api('post', '/stock/receive').send({
      rows: [
        { productId: soon.id, qty: 10, unitCost: 120, batchNo: 'SOON', expiresAt: iso(7) },
        { productId: later.id, qty: 10, unitCost: 100, batchNo: 'FAR', expiresAt: iso(300) },
      ],
    });

    const res = await shop.api('get', '/stock/expiring?days=30');
    expect(res.status).toBe(200);

    const lots = res.body.data.batches as Array<{ batchNo: string; daysLeft: number; valueAtRisk: number }>;
    expect(lots.map((l) => l.batchNo)).toEqual(['SOON']);
    expect(lots[0]!.daysLeft).toBeLessThanOrEqual(7);
    // The number that gets an owner to act rather than close the screen.
    expect(lots[0]!.valueAtRisk).toBe(1200);
  });

  it('flags stock that is already out of date', async () => {
    const shop = await pharmacy('Already Expired Shop');
    const product = await createProduct(shop, { price: 500 });

    await shop.api('post', '/stock/receive').send({
      rows: [{ productId: product.id, qty: 6, unitCost: 50, batchNo: 'OLD', expiresAt: iso(-5) }],
    });

    const res = await shop.api('get', '/stock/expiring?days=30');
    const lots = res.body.data.batches as Array<{ batchNo: string; expired: boolean }>;
    expect(lots.find((l) => l.batchNo === 'OLD')?.expired).toBe(true);
  });

  it('drops a lot off the report once it is sold out', async () => {
    const shop = await pharmacy('Sold Out Shop');
    const product = await createProduct(shop, { price: 500 });

    await shop.api('post', '/stock/receive').send({
      rows: [{ productId: product.id, qty: 5, unitCost: 50, batchNo: 'GONE', expiresAt: iso(10) }],
    });
    await shop.api('post', '/sales/sync').send({
      sales: [saleBody({ items: [{ productId: product.id, name: 'Item', unitPrice: 500, qty: 5 }] })],
    });

    const res = await shop.api('get', '/stock/expiring?days=30');
    expect((res.body.data.batches as Array<{ batchNo: string }>).map((l) => l.batchNo)).not.toContain('GONE');
  });

  it('is off for a shop without the capability', async () => {
    const shop = await createShop('No Batches Shop');
    const res = await shop.api('get', '/stock/expiring?days=30');
    expect([402, 403]).toContain(res.status);
  });
});
