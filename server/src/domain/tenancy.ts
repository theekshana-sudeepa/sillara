import type { Prisma } from '@prisma/client';
import { logger } from '../lib/logger.js';

/**
 * ---------------------------------------------------------------------------
 * A CUID IN A REQUEST BODY IS NOT PROOF OF OWNERSHIP
 * ---------------------------------------------------------------------------
 * Tenant identity comes from the JWT and nothing else — but a sale also
 * carries four ids the device chose: its branch, its shift, its register, its
 * customer. Zod checked their *shape* and nothing checked whose they were.
 *
 * `branchId` was the dangerous one (it decides which shelf decrements) and is
 * handled in `domain/stock.ts`, which refuses outright. The other three are
 * attribution rather than money, and get a different answer here.
 *
 * Why null instead of refuse: these ids go stale legitimately. A register gets
 * deleted, a customer is removed, and a phone that was offline for two days
 * flushes an outbox full of sales referring to them. Refusing would strand
 * that outbox forever — the till would stop, which is the one thing this
 * platform promises never to do. A sale that lands without its shift is a
 * reporting gap; a sale that never lands is missing money.
 *
 * Nulling is equally safe against the attack: an id from another org resolves
 * to nothing and is dropped, so no cross-tenant row is ever written. It is
 * only the *response* to a bad id that differs, and availability wins.
 * ---------------------------------------------------------------------------
 */

export interface SaleRefs {
  shiftId?: string | null;
  registerId?: string | null;
  customerId?: string | null;
}

/**
 * Keep the references that belong to this org; drop the rest.
 * Anything dropped is logged — a device sending foreign ids is either broken
 * or probing, and both are worth seeing.
 */
export async function resolveSaleRefs(
  tx: Prisma.TransactionClient,
  orgId: string,
  refs: SaleRefs,
): Promise<Required<SaleRefs>> {
  const [shift, register, customer] = await Promise.all([
    refs.shiftId
      ? tx.shift.findFirst({ where: { id: refs.shiftId, orgId }, select: { id: true } })
      : Promise.resolve(null),
    refs.registerId
      ? tx.register.findFirst({ where: { id: refs.registerId, orgId }, select: { id: true } })
      : Promise.resolve(null),
    refs.customerId
      ? tx.customer.findFirst({ where: { id: refs.customerId, orgId, deletedAt: null }, select: { id: true } })
      : Promise.resolve(null),
  ]);

  const dropped: string[] = [];
  if (refs.shiftId && !shift) dropped.push('shiftId');
  if (refs.registerId && !register) dropped.push('registerId');
  if (refs.customerId && !customer) dropped.push('customerId');

  if (dropped.length > 0) {
    logger.warn({ orgId, dropped, refs }, 'sale referenced ids this org does not own — dropped');
  }

  return {
    shiftId: shift?.id ?? null,
    registerId: register?.id ?? null,
    customerId: customer?.id ?? null,
  };
}
