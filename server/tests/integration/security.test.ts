import { it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { describeDb, createShop, createCustomer, saleBody, getApp, closeDb, type Shop } from './fixtures.js';

/**
 * The four holes from the security audit.
 *
 * Each of these was reachable by someone who already had an ordinary account —
 * a cashier, or a shop on a neighbouring tenant. That is the population these
 * tests care about: not a stranger on the internet, but the person you already
 * gave a login to.
 */

let prisma: PrismaClient;

beforeAll(async () => {
  ({ prisma } = await import('../../src/lib/prisma.js'));
});

afterAll(closeDb);

async function addStaff(shop: Shop, over: Record<string, unknown> = {}) {
  const res = await shop.api('post', '/auth/staff').send({
    name: 'Cashier Sam',
    email: `staff-${crypto.randomUUID()}@sillara.test`,
    role: 'CASHIER',
    pin: '1234',
    ...over,
  });
  if (res.status !== 201) throw new Error(`staff create failed (${res.status}): ${JSON.stringify(res.body)}`);
  return res.body.data as { id: string; name: string; role: string; isActive: boolean };
}

// ---------------------------------------------------------------------------

describeDb('a sale cannot carry references belonging to another shop', () => {
  it('drops a foreign customerId instead of linking or crediting it', async () => {
    const mine = await createShop('Ref Shop A');
    const theirs = await createShop('Ref Shop B');
    const victim = await createCustomer(theirs, 'Their Regular');

    await theirs.api('patch', '/org').send({ loyaltyEnabled: true, loyaltyEarnRate: 1, loyaltyMinRedeem: 0 });
    const before = await prisma.customer.findUniqueOrThrow({ where: { id: victim.id } });

    const res = await mine.api('post', '/sales/sync').send({
      sales: [saleBody({ customerId: victim.id, items: [{ name: 'Item', unitPrice: 500, qty: 1 }] })],
    });

    // The sale still lands — an outbox must never be stranded by a bad id.
    expect(res.body.data.results[0].status).toBe('created');

    const sale = await prisma.sale.findUniqueOrThrow({ where: { id: res.body.data.results[0].id } });
    expect(sale.customerId).toBeNull();

    // And the other shop's customer is untouched. The loyalty update used to
    // run with no org scope at all.
    const after = await prisma.customer.findUniqueOrThrow({ where: { id: victim.id } });
    expect(Number(after.loyaltyPoints)).toBe(Number(before.loyaltyPoints));
    expect(
      await prisma.loyaltyTransaction.count({ where: { customerId: victim.id, orgId: mine.orgId } }),
    ).toBe(0);
  });

  it('drops a foreign shiftId rather than corrupting the other shop’s drawer count', async () => {
    const mine = await createShop('Shift Shop A');
    const theirs = await createShop('Shift Shop B');

    const shift = await theirs.api('post', '/shifts/open').send({ openingFloat: 5000 });
    const foreignShiftId = shift.body.data.id as string;

    const res = await mine.api('post', '/sales/sync').send({
      sales: [saleBody({ shiftId: foreignShiftId, items: [{ name: 'Item', unitPrice: 250, qty: 1 }] })],
    });
    expect(res.body.data.results[0].status).toBe('created');

    const sale = await prisma.sale.findUniqueOrThrow({ where: { id: res.body.data.results[0].id } });
    expect(sale.shiftId).toBeNull();

    // Their expected cash is still just their float.
    const summary = await theirs.api('get', `/shifts/${foreignShiftId}/summary`);
    expect(summary.body.data.expectedCash).toBe(5000);
  });
});

// ---------------------------------------------------------------------------

describeDb('login does not reveal which emails exist', () => {
  it('takes comparable time for an unknown email and a known one', async () => {
    const shop = await createShop('Timing Shop');
    const owner = await prisma.orgUser.findFirstOrThrow({ where: { orgId: shop.orgId } });
    const app = await getApp();

    const attempt = async (email: string): Promise<number> => {
      const started = process.hrtime.bigint();
      await request(app).post('/api/v1/auth/login').send({ email, password: 'definitely-not-the-password' });
      return Number(process.hrtime.bigint() - started) / 1e6;
    };

    // Warm both paths so the first bcrypt call does not skew the sample.
    await attempt(owner.email);
    await attempt('nobody@sillara.test');

    const known = Math.min(await attempt(owner.email), await attempt(owner.email));
    const unknown = Math.min(await attempt('nobody@sillara.test'), await attempt('nobody@sillara.test'));

    // Before the fix the dummy hash was malformed, so bcrypt bailed out early:
    // ~4ms for an unknown email against ~257ms for a known one, a 62× tell.
    // Real work on both paths puts them within the same order of magnitude.
    const ratio = Math.max(known, unknown) / Math.max(1, Math.min(known, unknown));
    expect(ratio).toBeLessThan(3);
  });
});

// ---------------------------------------------------------------------------

describeDb('a PIN cannot be walked to a better role', () => {
  it('locks the target account after repeated wrong PINs', async () => {
    const shop = await createShop('PIN Shop');
    const staff = await addStaff(shop, { pin: '4321' });

    for (let i = 0; i < 5; i += 1) {
      const res = await shop.api('post', '/auth/switch').send({ userId: staff.id, pin: '0000' });
      expect(res.status).toBe(401);
      expect(res.body.error.message).toBe('Wrong PIN');
    }

    // Sixth attempt is refused even though it is the correct PIN — 10,000
    // combinations at 5 per 15 minutes is ~500 hours, not ~2.
    const locked = await shop.api('post', '/auth/switch').send({ userId: staff.id, pin: '4321' });
    expect(locked.status).toBe(401);
    expect(locked.body.error.message).toMatch(/Too many wrong PINs/);

    const row = await prisma.orgUser.findUniqueOrThrow({ where: { id: staff.id } });
    expect(row.pinLockedUntil).not.toBeNull();
  });

  it('writes down every attempt, so an escalation leaves a trail', async () => {
    const shop = await createShop('PIN Audit Shop');
    const staff = await addStaff(shop, { pin: '1111' });

    await shop.api('post', '/auth/switch').send({ userId: staff.id, pin: '9999' });
    await shop.api('post', '/auth/switch').send({ userId: staff.id, pin: '1111' });

    const actions = await prisma.auditLog.findMany({
      where: { orgId: shop.orgId, entityId: staff.id },
      select: { action: true },
    });
    expect(actions.map((a) => a.action)).toEqual(
      expect.arrayContaining(['auth.pin_switch.failed', 'auth.pin_switch.ok']),
    );
  });

  it('clears the lock when a manager resets the PIN', async () => {
    const shop = await createShop('PIN Reset Shop');
    const staff = await addStaff(shop, { pin: '2222' });

    for (let i = 0; i < 5; i += 1) {
      await shop.api('post', '/auth/switch').send({ userId: staff.id, pin: '0000' });
    }
    await shop.api('patch', `/auth/staff/${staff.id}`).send({ pin: '3333' });

    const res = await shop.api('post', '/auth/switch').send({ userId: staff.id, pin: '3333' });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------

describeDb('a shop can actually fire a cashier', () => {
  it('stops a live token the moment the account is deactivated', async () => {
    const shop = await createShop('Firing Shop');
    const staff = await addStaff(shop, { pin: '5555' });

    // The cashier is at the till with a valid session.
    const switched = await shop.api('post', '/auth/switch').send({ userId: staff.id, pin: '5555' });
    expect(switched.status).toBe(200);
    const cashierToken = switched.body.data.token as string;
    const app = await getApp();

    const asCashier = () =>
      request(app).get('/api/v1/products').set('Authorization', `Bearer ${cashierToken}`);

    expect((await asCashier()).status).toBe(200);

    // Fired. Their JWT is still cryptographically valid for hours.
    const patched = await shop.api('patch', `/auth/staff/${staff.id}`).send({ isActive: false });
    expect(patched.status).toBe(200);
    expect(patched.body.data.isActive).toBe(false);

    // Before this endpoint existed there was no way to reach this state
    // through the API at all — it needed a MySQL prompt.
    expect((await asCashier()).status).toBe(401);
  });

  it('refuses to strand a shop without an owner', async () => {
    const shop = await createShop('Last Owner Shop');
    const owner = await prisma.orgUser.findFirstOrThrow({ where: { orgId: shop.orgId, role: 'OWNER' } });

    const demote = await shop.api('patch', `/auth/staff/${owner.id}`).send({ role: 'CASHIER' });
    expect(demote.status).toBe(409);

    const stillOwner = await prisma.orgUser.findUniqueOrThrow({ where: { id: owner.id } });
    expect(stillOwner.role).toBe('OWNER');
  });

  it('refuses to let someone deactivate themselves', async () => {
    const shop = await createShop('Self Lockout Shop');
    const owner = await prisma.orgUser.findFirstOrThrow({ where: { orgId: shop.orgId, role: 'OWNER' } });

    const res = await shop.api('patch', `/auth/staff/${owner.id}`).send({ isActive: false });
    expect(res.status).toBe(400);
  });

  it('does not let a manager touch an owner or mint a new one', async () => {
    const shop = await createShop('Escalation Shop');
    const manager = await addStaff(shop, { role: 'MANAGER', pin: '6666' });
    const owner = await prisma.orgUser.findFirstOrThrow({ where: { orgId: shop.orgId, role: 'OWNER' } });

    const switched = await shop.api('post', '/auth/switch').send({ userId: manager.id, pin: '6666' });
    const app = await getApp();
    const asManager = (id: string) =>
      request(app)
        .patch(`/api/v1/auth/staff/${id}`)
        .set('Authorization', `Bearer ${switched.body.data.token}`);

    // Cannot deactivate the owner...
    expect((await asManager(owner.id).send({ isActive: false })).status).toBe(403);
    // ...nor promote themselves into the role.
    expect((await asManager(manager.id).send({ role: 'OWNER' })).status).toBe(403);

    const stillManager = await prisma.orgUser.findUniqueOrThrow({ where: { id: manager.id } });
    expect(stillManager.role).toBe('MANAGER');
  });

  it('cannot reach a staff member in another shop', async () => {
    const mine = await createShop('Reacher Shop');
    const theirs = await createShop('Target Shop');
    const victim = await prisma.orgUser.findFirstOrThrow({ where: { orgId: theirs.orgId } });

    const res = await mine.api('patch', `/auth/staff/${victim.id}`).send({ isActive: false });
    expect(res.status).toBe(404);

    const untouched = await prisma.orgUser.findUniqueOrThrow({ where: { id: victim.id } });
    expect(untouched.isActive).toBe(true);
  });
});
