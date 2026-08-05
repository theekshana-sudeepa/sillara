import { it, expect, beforeAll, afterAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { describeDb, createShop, createProduct, saleBody, closeDb, type Shop } from './fixtures.js';

/**
 * Cost and tax, frozen at the moment of sale.
 *
 * The profit report used to join `products.cost`, which every delivery
 * overwrites — so a shop's margin for last month changed when this month's
 * stock arrived. It also counted tax as revenue, ignored bill-level discounts,
 * and summed only its own top 100 rows into the headline totals. All four
 * errors pushed profit the same way: up.
 *
 * These tests pin the behaviour that stops that: a cost snapshot per line, a
 * tax rate resolved per line, and totals computed over everything.
 */

let prisma: PrismaClient;

beforeAll(async () => {
  ({ prisma } = await import('../../src/lib/prisma.js'));
});

afterAll(closeDb);

const setTax = (shop: Shop, taxRate: number, taxInclusive: boolean) =>
  shop.api('patch', '/org').send({ taxRate, taxInclusive });

async function sell(shop: Shop, over: Record<string, unknown>) {
  const res = await shop.api('post', '/sales/sync').send({ sales: [saleBody(over)] });
  expect(res.body.data.results[0].status).toBe('created');
  return res.body.data.results[0].id as string;
}

// ---------------------------------------------------------------------------

describeDb('invariant: a past sale keeps the cost it was sold at', () => {
  it('does not restate margin when a later delivery arrives at a new price', async () => {
    const shop = await createShop('Costing Shop');
    await setTax(shop, 0, true);
    const product = await createProduct(shop, { price: 100 });

    // Buy 10 at 40, sell one.
    await shop.api('post', '/stock/receive').send({ rows: [{ productId: product.id, qty: 10, unitCost: 40 }] });
    const saleId = await sell(shop, { items: [{ productId: product.id, name: 'Item', unitPrice: 100, qty: 1 }] });

    const before = await prisma.saleItem.findFirstOrThrow({ where: { saleId } });
    expect(Number(before.unitCost)).toBe(40);

    // The cost of goods doubles on the next delivery.
    await shop.api('post', '/stock/receive').send({ rows: [{ productId: product.id, qty: 90, unitCost: 85 }] });

    // The old sale is untouched. This is the bug: it used to read back as 85,
    // silently rewriting a margin the owner had already acted on.
    const after = await prisma.saleItem.findFirstOrThrow({ where: { saleId } });
    expect(Number(after.unitCost)).toBe(40);
  });

  it('blends receive costs into a weighted average rather than overwriting', async () => {
    const shop = await createShop('Average Cost Shop');
    const product = await createProduct(shop, { price: 100 });

    await shop.api('post', '/stock/receive').send({ rows: [{ productId: product.id, qty: 100, unitCost: 10 }] });
    await shop.api('post', '/stock/receive').send({ rows: [{ productId: product.id, qty: 100, unitCost: 20 }] });

    // Last-cost-wins would say 20. The shelf actually holds 200 units that
    // cost 3000 in total.
    const fresh = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(Number(fresh.cost)).toBe(15);
  });
});

// ---------------------------------------------------------------------------

describeDb('invariant: tax is added or extracted according to the shop, not assumed', () => {
  it('extracts tax from the shelf price when the shop prices inclusive', async () => {
    const shop = await createShop('Inclusive Shop');
    await setTax(shop, 15, true);

    const saleId = await sell(shop, { items: [{ name: 'Item', unitPrice: 115, qty: 1 }] });
    const sale = await prisma.sale.findUniqueOrThrow({ where: { id: saleId }, include: { items: true } });

    expect(Number(sale.total)).toBe(115);
    expect(Number(sale.tax)).toBe(15);
    expect(Number(sale.items[0]!.netExTax)).toBe(100);
  });

  it('adds tax on top when the shop prices exclusive', async () => {
    const shop = await createShop('Exclusive Shop');
    await setTax(shop, 8, false);

    const saleId = await sell(shop, { items: [{ name: 'Item', unitPrice: 100, qty: 1 }] });
    const sale = await prisma.sale.findUniqueOrThrow({ where: { id: saleId }, include: { items: true } });

    // The bug: this used to total 100 and book 7.41 as tax the shop then
    // owed — it absorbed the tax on every sale it ever made.
    expect(Number(sale.total)).toBe(108);
    expect(Number(sale.tax)).toBe(8);
    expect(Number(sale.items[0]!.netExTax)).toBe(100);
  });

  it('taxes a mixed basket line by line', async () => {
    const shop = await createShop('Mixed Basket Shop');
    await setTax(shop, 15, true);

    // Zero-rated staple beside a standard-rated product.
    const rice = await createProduct(shop, { price: 500, taxRate: 0 });
    const soap = await createProduct(shop, { price: 230 });

    const saleId = await sell(shop, {
      items: [
        { productId: rice.id, name: 'Rice', unitPrice: 500, qty: 1 },
        { productId: soap.id, name: 'Soap', unitPrice: 230, qty: 1 },
      ],
    });
    const sale = await prisma.sale.findUniqueOrThrow({ where: { id: saleId }, include: { items: true } });

    // Only the soap carries tax. The old whole-bill formula charged tax on
    // the rice too.
    expect(Number(sale.tax)).toBe(30);
    expect(Number(sale.total)).toBe(730);
  });

  it('keeps Σ(netExTax) + Σ(taxAmount) equal to the sale total', async () => {
    const shop = await createShop('Reconciling Shop');
    await setTax(shop, 15, true);

    const saleId = await sell(shop, {
      items: [
        { name: 'A', unitPrice: 33.33, qty: 3 },
        { name: 'B', unitPrice: 19.99, qty: 1 },
        { name: 'C', unitPrice: 0.01, qty: 7 },
      ],
      discount: 13.37,
    });

    const sale = await prisma.sale.findUniqueOrThrow({ where: { id: saleId }, include: { items: true } });
    const sum = sale.items.reduce((s, i) => s + Number(i.netExTax) + Number(i.taxAmount), 0);
    expect(Math.round(sum * 100) / 100).toBe(Number(sale.total));
  });
});

// ---------------------------------------------------------------------------

describeDb('invariant: the profit report tells the truth about the whole business', () => {
  let shop: Shop;

  beforeAll(async () => {
    shop = await createShop('Profit Shop');
    await setTax(shop, 15, true);
  });

  it('reports margin on revenue net of tax, not on the tax-inclusive total', async () => {
    const product = await createProduct(shop, { price: 230 });
    await shop.api('post', '/stock/receive').send({ rows: [{ productId: product.id, qty: 10, unitCost: 100 }] });
    await sell(shop, { items: [{ productId: product.id, name: 'Item', unitPrice: 230, qty: 1 }] });

    const res = await shop.api('get', '/reports/profit?days=1');
    expect(res.status).toBe(200);

    // Revenue is 200 (230 less 30 tax), cost 100 → 50% margin.
    // Counting the tax as revenue would have shown 230/100 → 56.5%.
    expect(res.body.data.revenue).toBe(200);
    expect(res.body.data.cost).toBe(100);
    expect(res.body.data.profit).toBe(100);
    expect(res.body.data.marginPct).toBe(50);
    expect(res.body.data.tax).toBe(30);
  });

  it('subtracts whole-bill discounts from revenue', async () => {
    const shop2 = await createShop('Discount Shop');
    await setTax(shop2, 0, true);
    const product = await createProduct(shop2, { price: 100 });
    await shop2.api('post', '/stock/receive').send({ rows: [{ productId: product.id, qty: 10, unitCost: 60 }] });

    await sell(shop2, {
      items: [{ productId: product.id, name: 'Item', unitPrice: 100, qty: 1 }],
      discount: 25,
    });

    const res = await shop2.api('get', '/reports/profit?days=1');
    // The customer paid 75. Revenue used to read 100 — the discount was
    // simply never subtracted.
    expect(res.body.data.revenue).toBe(75);
    expect(res.body.data.profit).toBe(15);
  });

  it('totals every line, not just the hundred it displays', async () => {
    const shop3 = await createShop('Long Tail Shop');
    await setTax(shop3, 0, true);

    // One good seller and a long tail of loss-makers. Ordering by profit
    // descending and summing only the top rows hid every loss.
    const winner = await createProduct(shop3, { price: 1000 });
    await shop3.api('post', '/stock/receive').send({ rows: [{ productId: winner.id, qty: 5, unitCost: 100 }] });
    await sell(shop3, { items: [{ productId: winner.id, name: 'Winner', unitPrice: 1000, qty: 1 }] });

    const losers = [];
    for (let i = 0; i < 4; i += 1) {
      const p = await createProduct(shop3, { price: 10 });
      await shop3.api('post', '/stock/receive').send({ rows: [{ productId: p.id, qty: 5, unitCost: 50 }] });
      losers.push(p);
    }
    for (const p of losers) {
      await sell(shop3, { items: [{ productId: p.id, name: 'Loser', unitPrice: 10, qty: 1 }] });
    }

    const res = await shop3.api('get', '/reports/profit?days=1');
    // Winner: 1000 − 100 = +900. Four losers: 10 − 50 = −40 each = −160.
    expect(res.body.data.revenue).toBe(1040);
    expect(res.body.data.cost).toBe(300);
    expect(res.body.data.profit).toBe(740);
  });

  it('counts lines it cannot cost instead of scoring them as pure profit', async () => {
    const shop4 = await createShop('Uncosted Shop');
    await setTax(shop4, 0, true);

    // A free-text line — sold at the till with no product behind it.
    await sell(shop4, { items: [{ name: 'Loose item', unitPrice: 50, qty: 1 }] });

    const res = await shop4.api('get', '/reports/profit?days=1');
    expect(res.body.data.uncostedLines).toBe(1);
    expect(res.body.data.totalLines).toBe(1);
    // Revenue is real; the "profit" is flagged as unknowable rather than 50.
    expect(res.body.data.revenue).toBe(50);
  });

  it('keeps a product’s history together when it is renamed', async () => {
    const shop5 = await createShop('Rename Shop');
    await setTax(shop5, 0, true);
    const product = await createProduct(shop5, { name: 'Original Name', price: 100 });
    await shop5.api('post', '/stock/receive').send({ rows: [{ productId: product.id, qty: 10, unitCost: 50 }] });

    await sell(shop5, { items: [{ productId: product.id, name: 'Original Name', unitPrice: 100, qty: 1 }] });
    await shop5.api('patch', `/products/${product.id}`).send({ name: 'Renamed' });
    await sell(shop5, { items: [{ productId: product.id, name: 'Renamed', unitPrice: 100, qty: 1 }] });

    const res = await shop5.api('get', '/reports/profit?days=1');
    // Grouping by the frozen name string used to split this into two rows.
    const forProduct = (res.body.data.items as Array<{ productId: string; qty: number }>).filter(
      (i) => i.productId === product.id,
    );
    expect(forProduct).toHaveLength(1);
    expect(forProduct[0]!.qty).toBe(2);
  });
});
