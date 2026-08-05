import { it, expect, beforeAll, afterAll } from 'vitest';
import { describeDb, createShop, createProduct, createCustomer, saleBody, closeDb, type Shop } from './fixtures.js';

/**
 * Tenant isolation — the invariant that, if it ever breaks, ends the company.
 *
 * The rule the code follows is: orgId comes from the JWT and from nowhere
 * else. Never a header, never a query param, never the body. These tests hold
 * a valid session for shop B and try, through the ordinary API, to touch shop
 * A's data.
 */

describeDb('tenant isolation', () => {
  let a: Shop;
  let b: Shop;
  let aProductId: string;
  let aCustomerId: string;

  beforeAll(async () => {
    a = await createShop('Shop A');
    b = await createShop('Shop B');
    aProductId = (await createProduct(a, { name: 'A-only Product', stockQty: 25 })).id;
    aCustomerId = (await createCustomer(a, 'A-only Customer')).id;
    await a.api('post', '/sales/sync').send({ sales: [saleBody()] });
  });

  afterAll(closeDb);

  it('gives each shop its own bootstrap payload', async () => {
    const [bootA, bootB] = await Promise.all([
      a.api('get', '/products/bootstrap'),
      b.api('get', '/products/bootstrap'),
    ]);
    expect(bootA.status).toBe(200);
    expect(bootB.status).toBe(200);

    expect(bootA.body.data.org.id).toBe(a.orgId);
    expect(bootB.body.data.org.id).toBe(b.orgId);

    const namesB = (bootB.body.data.products as Array<{ id: string }>).map((p) => p.id);
    expect(namesB).not.toContain(aProductId);

    const customersB = (bootB.body.data.customers as Array<{ id: string }>).map((c) => c.id);
    expect(customersB).not.toContain(aCustomerId);
  });

  it("hides A's customer from B's loyalty lookup", async () => {
    const res = await b.api('get', `/loyalty/balance/${aCustomerId}`);
    expect(res.status).toBe(404); // not 403 — B is not told the id exists
  });

  it("refuses to let B adjust A's stock", async () => {
    const res = await b.api('post', '/stock/adjust').send({ productId: aProductId, qty: -5, note: 'Not mine' });
    expect(res.status).toBe(404);

    // And A's stock is untouched.
    const { prisma } = await import('../../src/lib/prisma.js');
    const product = await prisma.product.findUniqueOrThrow({ where: { id: aProductId }, select: { stockQty: true } });
    expect(Number(product.stockQty)).toBe(25);
  });

  it("shows B an empty movement history for A's product", async () => {
    const res = await b.api('get', `/stock/movements/${aProductId}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]); // scoped by orgId, so nothing leaks
  });

  it("keeps A's sales out of B's sales list and Z-report", async () => {
    const list = await b.api('get', '/sales');
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(0);
    expect(list.body.meta.total).toBe(0);

    const z = await b.api('get', '/sales/z-report');
    expect(z.status).toBe(200);
    expect(z.body.data.salesCount).toBe(0);
    expect(z.body.data.gross).toBe(0);
  });

  it('ignores a forged orgId in the body — tenancy comes from the token only', async () => {
    const res = await b
      .api('post', '/products')
      .send({ name: 'Trojan', price: 10, orgId: a.orgId } as Record<string, unknown>);
    expect(res.status).toBe(201);

    const { prisma } = await import('../../src/lib/prisma.js');
    const created = await prisma.product.findUniqueOrThrow({
      where: { id: (res.body.data as { id: string }).id },
      select: { orgId: true },
    });
    expect(created.orgId).toBe(b.orgId); // landed in B, where the token says
  });

  it('rejects a request with no token at all', async () => {
    const server = await (await import('./fixtures.js')).getApp();
    const request = (await import('supertest')).default;
    const res = await request(server).get('/api/v1/products/bootstrap');
    expect(res.status).toBe(401);
  });
});
