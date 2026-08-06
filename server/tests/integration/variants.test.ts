import { it, expect, beforeAll, afterAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { describeDb, createShop, saleBody, closeDb, type Shop } from './fixtures.js';

/**
 * Variants, end to end.
 *
 * The combination maths is unit-tested; these prove the consequence of the
 * design decision — that a variant is an ordinary product, so the stock
 * ledger, the tax engine and the offline outbox handle it without knowing
 * variants exist. The parent is a folder, and the sale path has to say so.
 */

let prisma: PrismaClient;

beforeAll(async () => {
  ({ prisma } = await import('../../src/lib/prisma.js'));
});

afterAll(closeDb);

/** Variants need a plan that includes stock tracking. */
async function clothingShop(name: string): Promise<Shop> {
  const shop = await createShop(name);
  await prisma.organization.update({ where: { id: shop.orgId }, data: { planCode: 'PRO' } });
  await shop.api('patch', '/org/business-type').send({ businessType: 'CLOTHING' });
  return shop;
}

const TSHIRT = {
  name: 'T-Shirt',
  price: 1200,
  trackStock: true,
  options: [
    { name: 'Size', values: ['S', 'M', 'L'] },
    { name: 'Colour', values: ['Red', 'Blue'] },
  ],
};

// ---------------------------------------------------------------------------

describeDb('creating a style creates everything on the shelf', () => {
  it('turns one form into a parent and six sellable variants', async () => {
    const shop = await clothingShop('Variant Shop');
    const res = await shop.api('post', '/products/variants').send(TSHIRT);

    expect(res.status).toBe(201);
    expect(res.body.data.variants).toHaveLength(6);

    const children = await prisma.product.findMany({
      where: { orgId: shop.orgId, parentId: res.body.data.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(children).toHaveLength(6);
    // Each is a product in its own right — that is the whole point.
    expect(children.every((c) => Number(c.price) === 1200)).toBe(true);
    expect(children.every((c) => c.trackStock)).toBe(true);
  });

  it('leaves the parent holding no stock of its own', async () => {
    const shop = await clothingShop('Folder Shop');
    const res = await shop.api('post', '/products/variants').send(TSHIRT);

    const parent = await prisma.product.findUniqueOrThrow({ where: { id: res.body.data.id } });
    // A folder with a quantity would be double-counted in every valuation.
    expect(parent.trackStock).toBe(false);
    expect(Number(parent.stockQty)).toBe(0);
    expect(parent.variantOptions).toBeTruthy();
  });

  it('refuses when the plan has no room for the whole matrix', async () => {
    // A free shop caps at 100 products. Ten sizes by ten colours is 100
    // children plus a parent, on top of the starter catalogue — the whole
    // matrix has to be counted before any of it is written, or the shop ends
    // up half-created and over its limit.
    const shop = await createShop('Tiny Plan Shop');
    await shop.api('patch', '/org/business-type').send({ businessType: 'CLOTHING' });
    const tenValues = Array.from({ length: 10 }, (_, i) => `V${i + 1}`);

    const before = await prisma.product.count({ where: { orgId: shop.orgId, deletedAt: null } });
    const res = await shop.api('post', '/products/variants').send({
      ...TSHIRT,
      options: [
        { name: 'Size', values: tenValues },
        { name: 'Colour', values: tenValues },
      ],
    });

    expect(res.status).toBe(402);
    expect(await prisma.product.count({ where: { orgId: shop.orgId, deletedAt: null } })).toBe(before);
  });

  it('is off for a shop without the capability', async () => {
    const shop = await createShop('No Variants Shop');
    await prisma.organization.update({ where: { id: shop.orgId }, data: { planCode: 'PRO' } });

    const res = await shop.api('post', '/products/variants').send(TSHIRT);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------

describeDb('a parent is a folder, not a thing on the shelf', () => {
  it('refuses to ring one up', async () => {
    const shop = await clothingShop('Parent Sale Shop');
    const created = await shop.api('post', '/products/variants').send(TSHIRT);
    const parentId = created.body.data.id as string;

    const res = await shop.api('post', '/sales/sync').send({
      sales: [saleBody({ items: [{ productId: parentId, name: 'T-Shirt', unitPrice: 1200, qty: 1 }] })],
    });

    // Taking money for an unidentified item and moving no stock is worse than
    // refusing. The device keeps the sale so it can be corrected.
    expect(res.body.data.results[0].status).toBe('failed');
    expect(await prisma.sale.count({ where: { orgId: shop.orgId } })).toBe(0);
  });

  it('refuses to have stock set on it', async () => {
    const shop = await clothingShop('Parent Stock Shop');
    const created = await shop.api('post', '/products/variants').send(TSHIRT);

    const res = await shop.api('patch', `/products/${created.body.data.id}`).send({ stockQty: 50 });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/size or colour/i);
  });

  it('sells the variant itself, moving that variant’s stock', async () => {
    const shop = await clothingShop('Selling Shop');
    const created = await shop.api('post', '/products/variants').send(TSHIRT);
    const [child] = await prisma.product.findMany({ where: { parentId: created.body.data.id }, take: 1 });

    await shop.api('post', '/stock/receive').send({ rows: [{ productId: child!.id, qty: 10, unitCost: 600 }] });
    const sale = await shop.api('post', '/sales/sync').send({
      sales: [saleBody({ items: [{ productId: child!.id, name: child!.name, unitPrice: 1200, qty: 2 }] })],
    });
    expect(sale.body.data.results[0].status).toBe('created');

    // The ledger never learned what a variant is; it did not need to.
    const after = await prisma.product.findUniqueOrThrow({ where: { id: child!.id } });
    expect(Number(after.stockQty)).toBe(8);

    const movements = await prisma.stockMovement.findMany({ where: { productId: child!.id } });
    expect(movements.map((m) => m.type).sort()).toEqual(['RECEIVE', 'SALE']);

    // And margin works, because cost was snapshotted on the variant.
    const line = await prisma.saleItem.findFirstOrThrow({ where: { productId: child!.id } });
    expect(Number(line.unitCost)).toBe(600);
  });

  it('scans straight to the variant, skipping the picker entirely', async () => {
    const shop = await clothingShop('Barcode Shop');
    const created = await shop.api('post', '/products/variants').send(TSHIRT);
    const [child] = await prisma.product.findMany({ where: { parentId: created.body.data.id }, take: 1 });

    await shop.api('patch', `/products/${child!.id}`).send({ barcode: '5012345678900' });

    const found = await prisma.product.findFirst({ where: { orgId: shop.orgId, barcode: '5012345678900' } });
    expect(found?.id).toBe(child!.id);
    expect(found?.parentId).toBe(created.body.data.id);
  });
});

// ---------------------------------------------------------------------------

describeDb('a new colour arrives mid-season', () => {
  it('adds only the combinations that are missing', async () => {
    const shop = await clothingShop('Restock Shop');
    const created = await shop.api('post', '/products/variants').send(TSHIRT);
    const parentId = created.body.data.id as string;

    const res = await shop.api('post', `/products/${parentId}/variants`).send({
      options: [
        { name: 'Size', values: ['S', 'M', 'L'] },
        { name: 'Colour', values: ['Red', 'Blue', 'Green'] },
      ],
    });

    expect(res.status).toBe(201);
    expect(res.body.data.added).toBe(3); // three greens, nothing else
    expect(await prisma.product.count({ where: { parentId } })).toBe(9);
  });

  it('is a no-op when nothing is new, rather than a duplicate shelf', async () => {
    const shop = await clothingShop('Idempotent Shop');
    const created = await shop.api('post', '/products/variants').send(TSHIRT);
    const parentId = created.body.data.id as string;

    const res = await shop.api('post', `/products/${parentId}/variants`).send({ options: TSHIRT.options });
    expect(res.body.data.added).toBe(0);
    expect(await prisma.product.count({ where: { parentId } })).toBe(6);
  });

  it('refuses on a product that has no variants', async () => {
    const shop = await clothingShop('Plain Product Shop');
    const plain = await shop.api('post', '/products').send({ name: 'Belt', price: 900 });

    const res = await shop.api('post', `/products/${plain.body.data.id}/variants`).send({ options: TSHIRT.options });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------

describeDb('the till receives what it needs to group', () => {
  it('ships parents and children together, each tagged', async () => {
    const shop = await clothingShop('Bootstrap Shop');
    const created = await shop.api('post', '/products/variants').send(TSHIRT);

    const res = await shop.api('get', '/products/bootstrap');
    const products = res.body.data.products as Array<{
      id: string;
      parentId: string | null;
      variantOptions: unknown;
      variantAttributes: Record<string, string> | null;
    }>;

    const parent = products.find((p) => p.id === created.body.data.id)!;
    const children = products.filter((p) => p.parentId === created.body.data.id);

    // The grid hides children and shows the parent; the picker needs both.
    expect(parent.variantOptions).toBeTruthy();
    expect(children).toHaveLength(6);
    expect(children.every((c) => c.variantAttributes?.Size && c.variantAttributes?.Colour)).toBe(true);
  });
});
