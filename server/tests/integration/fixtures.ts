import crypto from 'node:crypto';
import { describe } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

/**
 * Integration fixtures.
 *
 * These tests talk to the real Express app against a real MySQL database —
 * the only way to prove the invariants that live in the *database*: unique
 * constraints, LAST_INSERT_ID sequences, transaction boundaries. A mock would
 * happily agree with a bug.
 *
 * They skip themselves when TEST_DATABASE_URL is unset, so `npm test` is
 * always runnable. CI sets it and they run for real.
 *
 *   createdb:  mysql -uroot -e "CREATE DATABASE sillara_test"
 *   migrate:   DATABASE_URL=mysql://root@127.0.0.1:3306/sillara_test npx prisma migrate deploy
 *   seed:      DATABASE_URL=... npm run seed
 *   run:       TEST_DATABASE_URL=mysql://root@127.0.0.1:3306/sillara_test npm test
 */

export const hasDb = Boolean(process.env.TEST_DATABASE_URL);
export const describeDb = hasDb ? describe : describe.skip;

export interface Shop {
  orgId: string;
  token: string;
  api: (method: 'get' | 'post' | 'patch' | 'delete', path: string) => request.Test;
}

let app: Express | undefined;

/** Built lazily — importing the app pulls in prisma, which needs the env set. */
export async function getApp(): Promise<Express> {
  if (!app) {
    const { createApp } = await import('../../src/app.js');
    app = createApp();
  }
  return app;
}

/**
 * A fresh shop with an owner session, via the real signup route — the same
 * path a customer takes. Every test gets its own org, so tests never need to
 * truncate tables and can safely run against a database with other data in it.
 */
export async function createShop(name = 'Test Shop'): Promise<Shop> {
  const server = await getApp();
  const email = `test-${crypto.randomUUID()}@sillara.test`;

  const res = await request(server)
    .post('/api/v1/public/signup')
    .send({
      shopName: name,
      ownerName: 'Test Owner',
      email,
      country: 'LK',
      planCode: 'FREE',
      password: 'test-password-123',
    });

  if (res.status !== 201) {
    throw new Error(`signup failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  const { orgId, token, mode } = res.body.data as { orgId: string; token?: string; mode: string };
  if (mode !== 'ready' || !token) {
    throw new Error(`expected an instant session, got mode="${mode}"`);
  }

  return {
    orgId,
    token,
    api: (method, path) =>
      request(server)[method](`/api/v1${path}`).set('Authorization', `Bearer ${token}`),
  };
}

/** A tracked product with zero opening stock, so the ledger starts clean. */
export async function createProduct(
  shop: Shop,
  over: Record<string, unknown> = {},
): Promise<{ id: string; name: string }> {
  const res = await shop
    .api('post', '/products')
    .send({ name: `Widget ${crypto.randomUUID().slice(0, 8)}`, price: 100, trackStock: true, stockQty: 0, ...over });
  if (res.status !== 201) throw new Error(`product create failed (${res.status}): ${JSON.stringify(res.body)}`);
  return res.body.data as { id: string; name: string };
}

export async function createCustomer(shop: Shop, name = 'Regular Customer'): Promise<{ id: string }> {
  const res = await shop.api('post', '/customers').send({ name, phone: '0770000000' });
  if (res.status !== 201) throw new Error(`customer create failed (${res.status}): ${JSON.stringify(res.body)}`);
  return res.body.data as { id: string };
}

/** One line of an offline sale, shaped exactly as the POS outbox sends it. */
export function saleBody(over: Record<string, unknown> = {}) {
  return {
    clientUuid: crypto.randomUUID(),
    items: [{ name: 'Item', unitPrice: 100, qty: 1 }],
    tender: 'CASH' as const,
    tendered: 100,
    soldAt: new Date().toISOString(),
    ...over,
  };
}

export async function closeDb(): Promise<void> {
  if (!hasDb) return;
  const { prisma } = await import('../../src/lib/prisma.js');
  await prisma.$disconnect();
}
