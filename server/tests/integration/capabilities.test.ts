import { it, expect, beforeAll, afterAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { describeDb, createShop, saleBody, closeDb, type Shop } from './fixtures.js';

/**
 * Capabilities, end to end.
 *
 * The resolver is unit-tested against every rule it encodes; these prove the
 * wiring — that the answer reaches `/auth/me`, survives a change of preset,
 * and that the API stops answering when a shop switches something off. The
 * last part matters most: if enforcement lived only in the till, a capability
 * would be a suggestion.
 */

let prisma: PrismaClient;

beforeAll(async () => {
  ({ prisma } = await import('../../src/lib/prisma.js'));
});

afterAll(closeDb);

/** Test shops provision on FREE; most capabilities need a real plan. */
async function upgradeToPro(shop: Shop): Promise<void> {
  await prisma.organization.update({ where: { id: shop.orgId }, data: { planCode: 'PRO' } });
}

const me = (shop: Shop) => shop.api('get', '/auth/me');

// ---------------------------------------------------------------------------

describeDb('the till is told what it can do', () => {
  it('ships capabilities and a layout with the session', async () => {
    const shop = await createShop('Capability Shop');
    const res = await me(shop);

    expect(res.status).toBe(200);
    expect(res.body.data.capabilities).toEqual(expect.arrayContaining(['sell', 'products', 'daily_report']));
    expect(res.body.data.layout.shell).toBe('grid');
    expect(res.body.data.org.businessType).toBe('GENERAL_RETAIL');
  });

  it('gives a pharmacy batch tracking and a scan-first till', async () => {
    const shop = await createShop('Corner Pharmacy');
    await upgradeToPro(shop);
    await shop.api('patch', '/org/business-type').send({ businessType: 'PHARMACY' });

    const res = await me(shop);
    expect(res.body.data.capabilities).toContain('stock.batches');
    expect(res.body.data.layout.scanFirst).toBe(true);
  });

  it('opens an unshipped preset on the ordinary grid rather than an empty shell', async () => {
    const shop = await createShop('Corner Cafe');
    await upgradeToPro(shop);
    // RESTAURANT is not offered in the picker yet, but the enum accepts it.
    // Until the tables module ships it must not promise a table map and then
    // render nothing — the grid sells perfectly well in the meantime.
    await shop.api('patch', '/org/business-type').send({ businessType: 'RESTAURANT' });

    const res = await me(shop);
    expect(res.body.data.layout.shell).toBe('grid');
    expect(res.body.data.capabilities).not.toContain('restaurant.tables');
    expect(res.body.data.capabilities).not.toContain('stock.batches');
  });

  it('tells a free shop what it is missing rather than quietly showing less', async () => {
    const shop = await createShop('Free Pharmacy');
    await shop.api('patch', '/org/business-type').send({ businessType: 'PHARMACY' });

    const res = await me(shop);
    // The preset wants batches; the plan does not include stock tracking.
    expect(res.body.data.capabilities).not.toContain('stock.batches');
    expect(res.body.data.blockedByPlan).toContain('inventory');
  });
});

// ---------------------------------------------------------------------------

describeDb('an owner can change their mind', () => {
  it('switches a capability on without changing business type', async () => {
    const shop = await createShop('Hardware With Batches');
    await upgradeToPro(shop);

    // A hardware shop that stocks adhesives wants expiry dates. No vertical
    // name involved, no code path added.
    const res = await shop.api('patch', '/org/capabilities').send({ capability: 'stock.batches', enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.data.capabilities).toContain('stock.batches');
    expect((await me(shop)).body.data.capabilities).toContain('stock.batches');
  });

  it('switches one off without disturbing the rest of the preset', async () => {
    const shop = await createShop('Grocery Without Scale');
    await upgradeToPro(shop);
    await shop.api('patch', '/org/business-type').send({ businessType: 'GROCERY' });

    await shop.api('patch', '/org/capabilities').send({ capability: 'sell.scale', enabled: false });

    const after = (await me(shop)).body.data.capabilities as string[];
    expect(after).not.toContain('sell.scale');
    expect(after).toContain('stock.batches');
  });

  it('keeps the owner’s choices when the preset changes underneath them', async () => {
    const shop = await createShop('Changed Mind Shop');
    await upgradeToPro(shop);

    // Chosen deliberately, while the shop is still "general retail".
    await shop.api('patch', '/org/capabilities').send({ capability: 'stock.variants', enabled: true });

    // Later they reclassify. The preset has nothing to do with variants, and
    // their choice must not be swept away by applying it.
    const changed = await shop.api('patch', '/org/business-type').send({ businessType: 'PHARMACY' });
    expect(changed.status).toBe(200);
    expect(changed.body.data.capabilities).toContain('stock.variants');
    expect(changed.body.data.capabilities).toContain('stock.batches');
  });

  it('reports the diff so a change of type is never a silent rearrangement', async () => {
    const shop = await createShop('Diff Shop');
    await upgradeToPro(shop);

    const res = await shop.api('patch', '/org/business-type').send({ businessType: 'PHARMACY' });
    expect(res.body.data.added).toContain('stock.batches');
    expect(res.body.data.added).toContain('purchase_orders');
    expect(res.body.data.layout.scanFirst).toBe(true);
  });

  it('refuses to switch off the things that make it a till', async () => {
    const shop = await createShop('Core Shop');
    const res = await shop.api('patch', '/org/capabilities').send({ capability: 'sell', enabled: false });
    expect(res.status).toBe(400);
    expect((await me(shop)).body.data.capabilities).toContain('sell');
  });

  it('will not hand out a capability the plan does not cover', async () => {
    const shop = await createShop('Free Shop Wanting Loyalty');
    const res = await shop.api('patch', '/org/capabilities').send({ capability: 'loyalty', enabled: true });

    // The revenue-critical case: asking for it must not grant it.
    expect(res.status).toBe(402);
    expect((await me(shop)).body.data.capabilities).not.toContain('loyalty');
  });

  it('is a settings change, so a cashier cannot make it', async () => {
    const shop = await createShop('Locked Down Shop');
    await upgradeToPro(shop);

    const staff = await shop.api('post', '/auth/staff').send({
      name: 'Cashier', email: `c-${shop.orgId}@sillara.test`, role: 'CASHIER', pin: '1234',
    });
    const switched = await shop.api('post', '/auth/switch').send({ userId: staff.body.data.id, pin: '1234' });

    const app = await (await import('./fixtures.js')).getApp();
    const request = (await import('supertest')).default;
    const res = await request(app)
      .patch('/api/v1/org/capabilities')
      .set('Authorization', `Bearer ${switched.body.data.token}`)
      .send({ capability: 'stock.batches', enabled: true });

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------

describeDb('the settings screen has what it needs', () => {
  it('lists every capability, not only the active ones', async () => {
    const shop = await createShop('Settings Shop');
    const res = await shop.api('get', '/org/capabilities');

    expect(res.status).toBe(200);
    const ids = (res.body.data.capabilities as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toContain('stock.batches'); // off, but offerable
    expect(ids).toContain('sell');

    // Enough to render an upgrade prompt rather than an empty row.
    const batches = (res.body.data.capabilities as Array<Record<string, unknown>>).find(
      (c) => c.id === 'stock.batches',
    )!;
    expect(batches).toMatchObject({ active: false, requiresUpgrade: true });
    expect(batches.label).toBeTruthy();

    // And the list of presets for the picker.
    // Eleven shipped; restaurant and salon are held back until their modules exist.
    expect(res.body.data.businessTypes.length).toBe(11);
  });

  it('distinguishes what the preset chose from what the owner did', async () => {
    const shop = await createShop('Preset Shop');
    await upgradeToPro(shop);
    await shop.api('patch', '/org/business-type').send({ businessType: 'PHARMACY' });

    const res = await shop.api('get', '/org/capabilities');
    const rows = res.body.data.capabilities as Array<{ id: string; fromPreset: boolean }>;
    expect(rows.find((c) => c.id === 'stock.batches')!.fromPreset).toBe(true);
    expect(rows.find((c) => c.id === 'stock.variants')!.fromPreset).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describeDb('the starter catalogue matches the trade', () => {
  it('opens a general shop on the familiar categories', async () => {
    const shop = await createShop('Plain Shop');
    const cats = await prisma.category.findMany({ where: { orgId: shop.orgId }, select: { name: true } });
    expect(cats.map((c) => c.name)).toEqual(expect.arrayContaining(['Drinks', 'Snacks', 'General']));
  });

  it('swaps the catalogue when a preset is applied in the wizard', async () => {
    const shop = await createShop('Wizard Pharmacy');
    await upgradeToPro(shop);

    const res = await shop.api('patch', '/org/business-type').send({ businessType: 'PHARMACY', seedCatalog: true });
    expect(res.status).toBe(200);

    const cats = (await prisma.category.findMany({ where: { orgId: shop.orgId }, select: { name: true } })).map((c) => c.name);
    expect(cats).toEqual(expect.arrayContaining(['Prescription', 'Over the Counter']));
    // The general-retail samples are gone — a pharmacy opening next to
    // "Drinks" and "Snacks" reads as a broken import.
    expect(cats).not.toContain('Snacks');
    expect(res.body.data.seeded.removed).toBeGreaterThan(0);
  });

  it('never removes a product the shop has actually sold', async () => {
    const shop = await createShop('Sold It Shop');
    await upgradeToPro(shop);

    const biscuits = await prisma.product.findFirstOrThrow({ where: { orgId: shop.orgId, name: 'Biscuits' } });
    await shop.api('post', '/sales/sync').send({
      sales: [saleBody({ items: [{ productId: biscuits.id, name: 'Biscuits', unitPrice: 100, qty: 1 }] })],
    });

    await shop.api('patch', '/org/business-type').send({ businessType: 'PHARMACY', seedCatalog: true });

    // Deleting real trading history to tidy up a preset would be far worse
    // than a leftover row.
    const survivor = await prisma.product.findUnique({ where: { id: biscuits.id } });
    expect(survivor).not.toBeNull();
  });

  it('never removes a product the shop has edited or stocked', async () => {
    const shop = await createShop('Edited Shop');
    await upgradeToPro(shop);

    const chips = await prisma.product.findFirstOrThrow({ where: { orgId: shop.orgId, name: 'Chips' } });
    const water = await prisma.product.findFirstOrThrow({ where: { orgId: shop.orgId, name: 'Water Bottle 500ml' } });
    await shop.api('patch', `/products/${chips.id}`).send({ name: 'Our Own Chips' });
    await shop.api('post', '/stock/receive').send({ rows: [{ productId: water.id, qty: 12, unitCost: 40 }] });

    await shop.api('patch', '/org/business-type').send({ businessType: 'PHARMACY', seedCatalog: true });

    expect(await prisma.product.findUnique({ where: { id: chips.id } })).not.toBeNull();
    expect(await prisma.product.findUnique({ where: { id: water.id } })).not.toBeNull();
  });

  it('leaves a real catalogue alone when asked not to seed', async () => {
    const shop = await createShop('Keep My Catalogue');
    await upgradeToPro(shop);
    const before = await prisma.product.count({ where: { orgId: shop.orgId } });

    await shop.api('patch', '/org/business-type').send({ businessType: 'PHARMACY' });

    expect(await prisma.product.count({ where: { orgId: shop.orgId } })).toBe(before);
  });

  it('scales sample prices to the shop’s own currency', async () => {
    // A Colombo shop seeing "Water Bottle — 1.00" reads as broken software.
    const shop = await createShop('Colombo Corner');
    const water = await prisma.product.findFirstOrThrow({
      where: { orgId: shop.orgId, name: 'Water Bottle 500ml' },
    });
    expect(Number(water.price)).toBe(300);
  });

  it('does not offer a preset whose module has not shipped', async () => {
    const shop = await createShop('Picker Shop');
    const res = await shop.api('get', '/org/capabilities');
    const offered = (res.body.data.businessTypes as Array<{ value: string }>).map((t) => t.value);

    expect(offered).toContain('PHARMACY');
    expect(offered).not.toContain('RESTAURANT');
    expect(offered).not.toContain('SALON');
  });
});
