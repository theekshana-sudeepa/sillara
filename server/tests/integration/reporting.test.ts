import { it, expect, beforeAll, afterAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { describeDb, createShop, createProduct, saleBody, closeDb, type Shop } from './fixtures.js';

/**
 * A shop's day is its own day, and a register has one drawer.
 *
 * Both of these were wrong in ways that only show up at the edges — the Z-report
 * cut the day on UTC midnight, which is 05:30 in the launch market, and opening
 * a shift was a check-then-create that two tills could both win.
 */

let prisma: PrismaClient;

beforeAll(async () => {
  ({ prisma } = await import('../../src/lib/prisma.js'));
});

afterAll(closeDb);

// ---------------------------------------------------------------------------

describeDb('the trading day belongs to the shop, not to UTC', () => {
  let shop: Shop;

  beforeAll(async () => {
    shop = await createShop('Colombo Shop');
    await shop.api('patch', '/org').send({ timezone: 'Asia/Colombo', taxRate: 0, taxInclusive: true });
  });

  it('counts an evening sale on the day it happened locally', async () => {
    // 19:00 UTC on 1 August is 00:30 on 2 August in Colombo. The old report
    // cut on UTC midnight and filed this under the 1st — half an evening's
    // takings landing on the wrong day, every day.
    const res = await shop.api('post', '/sales/sync').send({
      sales: [
        saleBody({
          items: [{ name: 'Late night item', unitPrice: 700, qty: 1 }],
          soldAt: '2026-08-01T19:00:00.000Z',
        }),
      ],
    });
    expect(res.body.data.results[0].status).toBe('created');

    const second = await shop.api('get', '/sales/z-report?date=2026-08-02');
    expect(second.body.data.timezone).toBe('Asia/Colombo');
    expect(second.body.data.date).toBe('2026-08-02');
    expect(second.body.data.gross).toBe(700);

    const first = await shop.api('get', '/sales/z-report?date=2026-08-01');
    expect(first.body.data.gross).toBe(0);
  });

  it('puts an afternoon sale on the same local and UTC day', async () => {
    const shop2 = await createShop('Afternoon Shop');
    await shop2.api('patch', '/org').send({ timezone: 'Asia/Colombo', taxRate: 0 });

    // 06:00 UTC is 11:30 local — the same calendar date either way.
    await shop2.api('post', '/sales/sync').send({
      sales: [saleBody({ items: [{ name: 'Lunch', unitPrice: 300, qty: 1 }], soldAt: '2026-08-05T06:00:00.000Z' })],
    });

    const z = await shop2.api('get', '/sales/z-report?date=2026-08-05');
    expect(z.body.data.gross).toBe(300);
  });

  it('shifts the boundary for a shop behind UTC too', async () => {
    const shop3 = await createShop('New York Shop');
    await shop3.api('patch', '/org').send({ timezone: 'America/New_York', taxRate: 0 });

    // 02:00 UTC on 6 August is 22:00 on the 5th in New York.
    await shop3.api('post', '/sales/sync').send({
      sales: [saleBody({ items: [{ name: 'Evening', unitPrice: 500, qty: 1 }], soldAt: '2026-08-06T02:00:00.000Z' })],
    });

    expect((await shop3.api('get', '/sales/z-report?date=2026-08-05')).body.data.gross).toBe(500);
    expect((await shop3.api('get', '/sales/z-report?date=2026-08-06')).body.data.gross).toBe(0);
  });

  it('stamps exported dates in the shop’s timezone', async () => {
    const csv = await shop.api('get', '/reports/export/sales');
    expect(csv.status).toBe(200);
    // The 19:00 UTC sale reads as 00:30 on the 2nd, which is when the cashier
    // rang it up.
    expect(csv.text).toContain('2026-08-02,00:30:00');
  });
});

// ---------------------------------------------------------------------------

describeDb('a register has exactly one drawer open at a time', () => {
  it('lets one of two simultaneous opens win, not both', async () => {
    const shop = await createShop('Race Shop');
    const register = await prisma.register.findFirstOrThrow({ where: { orgId: shop.orgId } });

    const attempts = await Promise.all(
      Array.from({ length: 6 }, () =>
        shop.api('post', '/shifts/open').send({ registerId: register.id, openingFloat: 5000 }),
      ),
    );

    const opened = attempts.filter((r) => r.status === 201);
    const refused = attempts.filter((r) => r.status === 409);
    expect(opened).toHaveLength(1);
    expect(refused).toHaveLength(5);

    // The database is what said no — a check-then-create let all six through.
    const open = await prisma.shift.count({ where: { orgId: shop.orgId, status: 'OPEN' } });
    expect(open).toBe(1);
  });

  it('applies the same rule to a till with no register', async () => {
    const shop = await createShop('Phone Till Shop');
    const attempts = await Promise.all(
      Array.from({ length: 4 }, () => shop.api('post', '/shifts/open').send({ openingFloat: 1000 })),
    );
    expect(attempts.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await prisma.shift.count({ where: { orgId: shop.orgId, status: 'OPEN' } })).toBe(1);
  });

  it('frees the register when the shift closes', async () => {
    const shop = await createShop('Reopen Shop');
    const register = await prisma.register.findFirstOrThrow({ where: { orgId: shop.orgId } });

    const first = await shop.api('post', '/shifts/open').send({ registerId: register.id, openingFloat: 2000 });
    expect(first.status).toBe(201);

    const blocked = await shop.api('post', '/shifts/open').send({ registerId: register.id, openingFloat: 2000 });
    expect(blocked.status).toBe(409);

    await shop.api('post', `/shifts/${first.body.data.id}/close`).send({ countedCash: 2000 });

    // A closed shift must release the key, or the till can never open again.
    const second = await shop.api('post', '/shifts/open').send({ registerId: register.id, openingFloat: 2000 });
    expect(second.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------

describeDb('low stock is answered by the database', () => {
  it('returns only what is at or below its threshold', async () => {
    const shop = await createShop('Reorder Shop');

    const low = await createProduct(shop, { price: 100, lowStockAt: 5 });
    const fine = await createProduct(shop, { price: 100, lowStockAt: 5 });
    const untracked = await createProduct(shop, { price: 100, trackStock: false });

    await shop.api('post', '/stock/receive').send({ rows: [{ productId: low.id, qty: 3, unitCost: 10 }] });
    await shop.api('post', '/stock/receive').send({ rows: [{ productId: fine.id, qty: 50, unitCost: 10 }] });

    const res = await shop.api('get', '/stock/low');
    expect(res.status).toBe(200);

    const ids = (res.body.data as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toContain(low.id);
    expect(ids).not.toContain(fine.id);
    expect(ids).not.toContain(untracked.id);

    const row = (res.body.data as Array<{ id: string; stockQty: number; lowStockAt: number }>).find(
      (p) => p.id === low.id,
    )!;
    expect(row.stockQty).toBe(3);
    expect(row.lowStockAt).toBe(5);
  });

  it('includes a product sitting exactly on its threshold', async () => {
    const shop = await createShop('Threshold Shop');
    const product = await createProduct(shop, { price: 100, lowStockAt: 4 });
    await shop.api('post', '/stock/receive').send({ rows: [{ productId: product.id, qty: 4, unitCost: 10 }] });

    const res = await shop.api('get', '/stock/low');
    expect((res.body.data as Array<{ id: string }>).map((p) => p.id)).toContain(product.id);
  });
});
