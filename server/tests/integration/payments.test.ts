import { it, expect, beforeAll, afterAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { describeDb, createShop, createProduct, createCustomer, saleBody, closeDb, type Shop } from './fixtures.js';

/**
 * Split payment, refunds, and the customer tab.
 *
 * All three were blocked on the same thing: a sale carried one `tender` enum,
 * so "half cash, half card" could not be written down, a partial refund had
 * nowhere to live, and an account sale had no receivable behind it.
 *
 * The shared rule underneath is that Σ(payments) == total, on every sale and
 * every refund. If that ever drifts the drawer stops reconciling and nobody
 * can tell which of the day's sales was the wrong one.
 */

let prisma: PrismaClient;

beforeAll(async () => {
  ({ prisma } = await import('../../src/lib/prisma.js'));
});

afterAll(closeDb);

async function sell(shop: Shop, over: Record<string, unknown>) {
  const res = await shop.api('post', '/sales/sync').send({ sales: [saleBody(over)] });
  const result = res.body.data.results[0];
  if (result.status !== 'created') throw new Error(`sale failed: ${JSON.stringify(result)}`);
  return result.id as string;
}

const paymentsFor = (saleId: string) =>
  prisma.salePayment.findMany({ where: { saleId }, orderBy: { type: 'asc' } });

// ---------------------------------------------------------------------------

describeDb('a bill can be settled with more than one tender', () => {
  let shop: Shop;
  beforeAll(async () => {
    shop = await createShop('Split Payment Shop');
    await shop.api('patch', '/org').send({ taxRate: 0, taxInclusive: true });
  });

  it('records each tender separately and sums them to the total', async () => {
    const saleId = await sell(shop, {
      items: [{ name: 'Item', unitPrice: 1000, qty: 1 }],
      payments: [
        { type: 'CASH', amount: 600 },
        { type: 'CARD', amount: 400, reference: '4242' },
      ],
    });

    const payments = await paymentsFor(saleId);
    expect(payments).toHaveLength(2);
    // Ordered by the TenderType enum's declaration order, not alphabetically —
    // MySQL sorts enums by position, and CASH is declared before CARD.
    expect(payments.map((p) => [p.type, Number(p.amount)])).toEqual([
      ['CASH', 600],
      ['CARD', 400],
    ]);

    const sale = await prisma.sale.findUniqueOrThrow({ where: { id: saleId } });
    const paid = payments.reduce((s, p) => s + Number(p.amount), 0);
    expect(paid).toBe(Number(sale.total));
    // The headline tender is the larger half, for the receipt and for every
    // report written before this table existed.
    expect(sale.tender).toBe('CASH');
  });

  it('gives change out of the cash half when a note overpays', async () => {
    const saleId = await sell(shop, {
      items: [{ name: 'Item', unitPrice: 1000, qty: 1 }],
      payments: [
        { type: 'CARD', amount: 400 },
        { type: 'CASH', amount: 1000 }, // a 1000 note for the remaining 600
      ],
    });

    const payments = await paymentsFor(saleId);
    const cash = payments.find((p) => p.type === 'CASH')!;
    expect(Number(cash.amount)).toBe(600); // what stayed in the drawer
    expect(Number(cash.tendered)).toBe(1000);
    expect(Number(cash.change)).toBe(400);

    const paid = payments.reduce((s, p) => s + Number(p.amount), 0);
    expect(paid).toBe(1000);
  });

  it('refuses a bill that is left short', async () => {
    const res = await shop.api('post', '/sales/sync').send({
      sales: [
        saleBody({
          items: [{ name: 'Item', unitPrice: 1000, qty: 1 }],
          payments: [{ type: 'CARD', amount: 700 }],
        }),
      ],
    });
    // An underpaid bill is an unrecorded debt dressed as a completed sale.
    expect(res.body.data.results[0].status).toBe('failed');
  });

  it('still accepts the pre-split shape an older device sends', async () => {
    const saleId = await sell(shop, {
      items: [{ name: 'Item', unitPrice: 250, qty: 1 }],
      tender: 'CASH',
      tendered: 500,
    });
    const payments = await paymentsFor(saleId);
    expect(payments).toHaveLength(1);
    expect(Number(payments[0]!.amount)).toBe(250);
    expect(Number(payments[0]!.change)).toBe(250);
  });

  it('writes no payment row for a bill that came to nothing', async () => {
    const shop2 = await createShop('Free Bill Shop');
    await shop2.api('patch', '/org').send({
      taxRate: 0,
      loyaltyEnabled: true,
      loyaltyEarnRate: 1,
      loyaltyRedeemValue: 0.01,
      loyaltyMinRedeem: 0,
    });
    const customer = await createCustomer(shop2, 'Points Payer');
    await shop2.api('post', '/loyalty/adjust').send({ customerId: customer.id, points: 5000, note: 'seed' });

    const saleId = await sell(shop2, {
      customerId: customer.id,
      redeemPoints: 1_000_000,
      items: [{ name: 'Item', unitPrice: 20, qty: 1 }],
      tendered: 0,
    });

    const sale = await prisma.sale.findUniqueOrThrow({ where: { id: saleId } });
    expect(Number(sale.total)).toBe(0);
    // No money changed hands, so there is nothing to record as a payment.
    expect(await paymentsFor(saleId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describeDb('a sale can be given back in part', () => {
  let shop: Shop;
  beforeAll(async () => {
    shop = await createShop('Refund Shop');
    await shop.api('patch', '/org').send({ taxRate: 0, taxInclusive: true });
  });

  it('returns some of the goods, some of the money, and leaves the rest sold', async () => {
    const product = await createProduct(shop, { price: 100 });
    await shop.api('post', '/stock/receive').send({ rows: [{ productId: product.id, qty: 10, unitCost: 40 }] });

    const saleId = await sell(shop, {
      items: [{ productId: product.id, name: 'Item', unitPrice: 100, qty: 3 }],
    });
    const item = await prisma.saleItem.findFirstOrThrow({ where: { saleId } });

    const res = await shop
      .api('post', `/sales/${saleId}/refund`)
      .send({ reason: 'One was damaged', lines: [{ saleItemId: item.id, qty: 1 }] });
    expect(res.status).toBe(201);

    // A separate, numbered document — the original receipt still reads as printed.
    const refund = await prisma.sale.findUniqueOrThrow({
      where: { id: res.body.data.id },
      include: { items: true, payments: true },
    });
    expect(refund.kind).toBe('REFUND');
    expect(refund.originalSaleId).toBe(saleId);
    expect(Number(refund.total)).toBe(-100);
    expect(Number(refund.items[0]!.qty)).toBe(-1);
    expect(Number(refund.payments[0]!.amount)).toBe(-100);

    // The original is untouched except for what has now been returned.
    const original = await prisma.sale.findUniqueOrThrow({ where: { id: saleId } });
    expect(Number(original.total)).toBe(300);
    const refreshed = await prisma.saleItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(Number(refreshed.refundedQty)).toBe(1);

    // One unit is back on the shelf: 10 − 3 + 1.
    const fresh = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(Number(fresh.stockQty)).toBe(8);
  });

  it('refuses to give back more than was bought', async () => {
    const product = await createProduct(shop, { price: 50 });
    await shop.api('post', '/stock/receive').send({ rows: [{ productId: product.id, qty: 10, unitCost: 20 }] });
    const saleId = await sell(shop, {
      items: [{ productId: product.id, name: 'Item', unitPrice: 50, qty: 2 }],
    });
    const item = await prisma.saleItem.findFirstOrThrow({ where: { saleId } });

    await shop.api('post', `/sales/${saleId}/refund`).send({
      reason: 'First one back',
      lines: [{ saleItemId: item.id, qty: 2 }],
    });

    const second = await shop.api('post', `/sales/${saleId}/refund`).send({
      reason: 'Trying it again',
      lines: [{ saleItemId: item.id, qty: 1 }],
    });
    expect(second.status).toBe(409);
  });

  it('nets out of the day’s takings rather than being counted as a sale', async () => {
    const shop2 = await createShop('Netting Shop');
    await shop2.api('patch', '/org').send({ taxRate: 0, taxInclusive: true });

    const saleId = await sell(shop2, { items: [{ name: 'Item', unitPrice: 1000, qty: 1 }] });
    const item = await prisma.saleItem.findFirstOrThrow({ where: { saleId } });
    await shop2
      .api('post', `/sales/${saleId}/refund`)
      .send({ reason: 'Returned', lines: [{ saleItemId: item.id, qty: 1 }] });

    const z = await shop2.api('get', '/sales/z-report');
    const cash = (z.body.data.byTender as Array<{ tender: string; total: number }>).find((t) => t.tender === 'CASH');
    // 1000 in, 1000 back out.
    expect(cash?.total).toBe(0);
    // And it is not counted as a second sale.
    expect(z.body.data.salesCount).toBe(1);
  });

  it('takes the money out of the drawer that is open now', async () => {
    const shop3 = await createShop('Refund Shift Shop');
    await shop3.api('patch', '/org').send({ taxRate: 0, taxInclusive: true });

    const shift = await shop3.api('post', '/shifts/open').send({ openingFloat: 1000 });
    const shiftId = shift.body.data.id as string;

    const saleId = await sell(shop3, { items: [{ name: 'Item', unitPrice: 500, qty: 1 }], shiftId });
    const item = await prisma.saleItem.findFirstOrThrow({ where: { saleId } });
    await shop3
      .api('post', `/sales/${saleId}/refund`)
      .send({ reason: 'Changed their mind', lines: [{ saleItemId: item.id, qty: 1 }] });

    const summary = await shop3.api('get', `/shifts/${shiftId}/summary`);
    // Float 1000, took 500, gave 500 back — the drawer holds the float again.
    expect(summary.body.data.expectedCash).toBe(1000);
  });

  it('will not refund a sale that was voided', async () => {
    const saleId = await sell(shop, { items: [{ name: 'Item', unitPrice: 75, qty: 1 }] });
    await shop.api('post', `/sales/${saleId}/void`).send({ reason: 'Rung up in error' });

    const res = await shop.api('post', `/sales/${saleId}/refund`).send({ reason: 'And again' });
    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------

describeDb('an account sale creates a debt somebody can collect', () => {
  let shop: Shop;
  beforeAll(async () => {
    shop = await createShop('Account Shop');
    await shop.api('patch', '/org').send({ taxRate: 0, taxInclusive: true });
  });

  it('puts the credit portion on the customer’s tab', async () => {
    const customer = await createCustomer(shop, 'Trade Buyer');

    const saleId = await sell(shop, {
      customerId: customer.id,
      items: [{ name: 'Bulk order', unitPrice: 5000, qty: 1 }],
      payments: [
        { type: 'CASH', amount: 2000 },
        { type: 'CREDIT', amount: 3000 },
      ],
    });

    // Only the account half becomes a receivable — the case a single tender
    // enum could not express at all.
    const fresh = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
    expect(Number(fresh.creditBalance)).toBe(3000);

    const ledger = await prisma.customerCreditTransaction.findMany({ where: { customerId: customer.id } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.type).toBe('CHARGE');
    expect(ledger[0]!.saleId).toBe(saleId);
  });

  it('lets the shop take payment against the tab', async () => {
    const customer = await createCustomer(shop, 'Paying Buyer');
    await sell(shop, {
      customerId: customer.id,
      items: [{ name: 'Goods', unitPrice: 4000, qty: 1 }],
      payments: [{ type: 'CREDIT', amount: 4000 }],
    });

    const settle = await shop
      .api('post', `/customers/${customer.id}/credit/settle`)
      .send({ amount: 2500, method: 'CASH', note: 'Part payment' });
    expect(settle.status).toBe(201);
    expect(settle.body.data.balance).toBe(1500);

    const view = await shop.api('get', `/customers/${customer.id}/credit`);
    expect(view.body.data.balance).toBe(1500);
    expect(view.body.data.transactions).toHaveLength(2);

    // The balance is exactly the ledger — same rule as stock and loyalty.
    const agg = await prisma.customerCreditTransaction.aggregate({
      where: { customerId: customer.id },
      _sum: { amount: true },
    });
    expect(Number(agg._sum.amount)).toBe(1500);
  });

  it('refuses to overpay a tab into a balance the shop would owe back', async () => {
    const customer = await createCustomer(shop, 'Overpayer');
    await sell(shop, {
      customerId: customer.id,
      items: [{ name: 'Goods', unitPrice: 1000, qty: 1 }],
      payments: [{ type: 'CREDIT', amount: 1000 }],
    });

    const res = await shop
      .api('post', `/customers/${customer.id}/credit/settle`)
      .send({ amount: 1500, method: 'CASH' });
    expect(res.status).toBe(400);
  });

  it('refuses an account sale with nobody to charge it to', async () => {
    const res = await shop.api('post', '/sales/sync').send({
      sales: [
        saleBody({
          items: [{ name: 'Goods', unitPrice: 800, qty: 1 }],
          payments: [{ type: 'CREDIT', amount: 800 }],
        }),
      ],
    });
    expect(res.body.data.results[0].status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------

describeDb('a refund goes back the way the cashier says', () => {
  it('settles the whole refund on a chosen tender, working the amount out itself', async () => {
    const shop = await createShop('Refund Tender Shop');
    const sale = await shop.api('post', '/sales/sync').send({
      sales: [saleBody({ items: [{ name: 'Item', unitPrice: 333.33, qty: 3 }], tender: 'CARD', tendered: 999.99 })],
    });
    const saleId = sale.body.data.results[0].id as string;
    const line = await prisma.saleItem.findFirstOrThrow({ where: { saleId } });

    // The till never sends an amount. A device computing the proportional
    // refund itself can land a cent off the server's figure, and the
    // settlement would be rejected for not adding up — on a number the
    // cashier has already handed over.
    const res = await shop
      .api('post', `/sales/${saleId}/refund`)
      .send({ reason: 'Customer returned one', lines: [{ saleItemId: line.id, qty: 1 }], refundTender: 'CASH' });

    expect(res.status).toBe(201);

    const payments = await prisma.salePayment.findMany({ where: { saleId: res.body.data.id } });
    expect(payments).toHaveLength(1);
    expect(payments[0]!.type).toBe('CASH'); // not the CARD it was sold on
    expect(Number(payments[0]!.amount)).toBe(Number(res.body.data.total));
    expect(Number(payments[0]!.amount)).toBeLessThan(0);
  });

  it('falls back to the original tender when no choice is made', async () => {
    const shop = await createShop('Default Tender Shop');
    const sale = await shop.api('post', '/sales/sync').send({
      sales: [saleBody({ items: [{ name: 'Item', unitPrice: 200, qty: 1 }], tender: 'QR', tendered: 200 })],
    });
    const saleId = sale.body.data.results[0].id as string;

    const res = await shop.api('post', `/sales/${saleId}/refund`).send({ reason: 'Not needed' });

    const payments = await prisma.salePayment.findMany({ where: { saleId: res.body.data.id } });
    expect(payments[0]!.type).toBe('QR');
  });
});
