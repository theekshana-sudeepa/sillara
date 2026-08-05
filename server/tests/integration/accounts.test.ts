import { it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { describeDb, createShop, getApp, closeDb, type Shop } from './fixtures.js';

/**
 * One person, several shops — and a drawer that knows what it does not know.
 *
 * `OrgUser` is unique on (orgId, email), so the same address can hold accounts
 * at more than one shop. Login used to take the oldest and every other shop
 * that address belonged to was simply unreachable.
 */

let prisma: PrismaClient;

beforeAll(async () => {
  ({ prisma } = await import('../../src/lib/prisma.js'));
});

afterAll(closeDb);

const PASSWORD = 'test-password-123';

async function login(body: Record<string, unknown>) {
  const app = await getApp();
  return request(app).post('/api/v1/auth/login').send(body);
}

/** Give an existing shop a second owner account under `email`. */
async function addAccount(shop: Shop, email: string): Promise<void> {
  const owner = await prisma.orgUser.findFirstOrThrow({ where: { orgId: shop.orgId, role: 'OWNER' } });
  await prisma.orgUser.create({
    data: {
      orgId: shop.orgId,
      email,
      name: 'Multi Shop Owner',
      role: 'OWNER',
      passwordHash: owner.passwordHash,
      isActive: true,
    },
  });
}

// ---------------------------------------------------------------------------

describeDb('one email, several shops', () => {
  it('signs straight in when the address belongs to exactly one shop', async () => {
    const shop = await createShop('Single Shop');
    const owner = await prisma.orgUser.findFirstOrThrow({ where: { orgId: shop.orgId } });

    const res = await login({ email: owner.email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.mode).toBe('ready');
    expect(res.body.data.token).toBeTruthy();
    expect(res.body.data.org.id).toBe(shop.orgId);
  });

  it('offers a choice when the address belongs to two, instead of silently picking one', async () => {
    const first = await createShop('Corner Store');
    const second = await createShop('High Street Branch');
    const shared = `owner-${crypto.randomUUID()}@sillara.test`;

    await addAccount(first, shared);
    await addAccount(second, shared);

    const res = await login({ email: shared, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.mode).toBe('choose');
    expect(res.body.data.token).toBeUndefined();

    const ids = (res.body.data.shops as Array<{ orgId: string; name: string }>).map((s) => s.orgId);
    expect(ids).toContain(first.orgId);
    expect(ids).toContain(second.orgId);
  });

  it('signs into the shop that was picked — including the one that is not the oldest', async () => {
    const first = await createShop('Older Shop');
    const second = await createShop('Newer Shop');
    const shared = `owner-${crypto.randomUUID()}@sillara.test`;

    await addAccount(first, shared);
    await addAccount(second, shared);

    // The newer shop was permanently unreachable before: `orderBy createdAt
    // asc` meant the older account always won and nothing let you say otherwise.
    const res = await login({ email: shared, password: PASSWORD, orgId: second.orgId });
    expect(res.status).toBe(200);
    expect(res.body.data.mode).toBe('ready');
    expect(res.body.data.org.id).toBe(second.orgId);

    const older = await login({ email: shared, password: PASSWORD, orgId: first.orgId });
    expect(older.body.data.org.id).toBe(first.orgId);
  });

  it('never reveals the shop list to a wrong password', async () => {
    const a = await createShop('Private A');
    const b = await createShop('Private B');
    const shared = `owner-${crypto.randomUUID()}@sillara.test`;
    await addAccount(a, shared);
    await addAccount(b, shared);

    const res = await login({ email: shared, password: 'not-the-password' });
    expect(res.status).toBe(401);
    expect(res.body.data).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('Private A');
  });

  it('ignores accounts at shops the address does not actually hold', async () => {
    const mine = await createShop('Mine');
    const other = await createShop('Not Mine');
    const shared = `owner-${crypto.randomUUID()}@sillara.test`;
    await addAccount(mine, shared);

    // Asking for a shop this email has no account at is just a failed login.
    const res = await login({ email: shared, password: PASSWORD, orgId: other.orgId });
    expect(res.status).toBe(401);
  });

  it('skips a deactivated account when choosing', async () => {
    const active = await createShop('Still Working');
    const fired = await createShop('Left This One');
    const shared = `owner-${crypto.randomUUID()}@sillara.test`;
    await addAccount(active, shared);
    await addAccount(fired, shared);

    await prisma.orgUser.updateMany({ where: { email: shared, orgId: fired.orgId }, data: { isActive: false } });

    const res = await login({ email: shared, password: PASSWORD });
    // Only one account remains, so there is nothing to choose between.
    expect(res.body.data.mode).toBe('ready');
    expect(res.body.data.org.id).toBe(active.orgId);
  });
});

// ---------------------------------------------------------------------------

describeDb('a drawer will not pretend to balance', () => {
  it('refuses to close while the device is holding unsynced sales', async () => {
    const shop = await createShop('Offline Till');
    const opened = await shop.api('post', '/shifts/open').send({ openingFloat: 1000 });
    const shiftId = opened.body.data.id as string;

    const res = await shop
      .api('post', `/shifts/${shiftId}/close`)
      .send({ countedCash: 4000, pendingCount: 3 });

    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/haven't synced/);

    const stillOpen = await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } });
    expect(stillOpen.status).toBe('OPEN');
  });

  it('closes anyway when told to, and says so on the shift', async () => {
    const shop = await createShop('Forced Close Till');
    const opened = await shop.api('post', '/shifts/open').send({ openingFloat: 1000 });
    const shiftId = opened.body.data.id as string;

    const res = await shop
      .api('post', `/shifts/${shiftId}/close`)
      .send({ countedCash: 4000, pendingCount: 3, force: true });

    expect(res.status).toBe(200);

    // Whoever reads this variance later needs to know it was never reliable.
    const closed = await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } });
    expect(closed.status).toBe('CLOSED');
    expect(closed.note).toMatch(/unsynced/);
  });

  it('closes normally when nothing is queued', async () => {
    const shop = await createShop('Clean Close Till');
    const opened = await shop.api('post', '/shifts/open').send({ openingFloat: 1000 });
    const shiftId = opened.body.data.id as string;

    const res = await shop.api('post', `/shifts/${shiftId}/close`).send({ countedCash: 1000 });
    expect(res.status).toBe(200);
    expect(res.body.data.summary.variance).toBe(0);

    const closed = await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } });
    expect(closed.note ?? '').not.toMatch(/unsynced/);
  });
});
