import type { NextFunction, Request, Response } from 'express';
import type { OrgStatus, PlanCode } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { AppError, Unauthorized } from '../lib/errors.js';
import { canWrite } from '../services/lifecycle.js';

/**
 * ---------------------------------------------------------------------------
 * THE GATE BETWEEN A TOKEN AND THE TILL
 * ---------------------------------------------------------------------------
 * `requireAuth` proves the token is real. It cannot prove the *shop* is still
 * entitled to sell, or that the cashier holding it still works there — a JWT
 * is a 12-hour snapshot, and both facts change inside that window.
 *
 * Without this middleware a suspended shop sells free until its token expires
 * and then, because login itself never checked either, forever. A cashier
 * fired at 9am keeps a working till until 9pm.
 *
 * So: one indexed lookup per request, memoised for a few seconds, that answers
 * both questions. The cost is a fraction of a millisecond on the sell path.
 * The alternative is a revenue leak with an authentication hole attached.
 */

export interface OrgContext {
  id: string;
  status: OrgStatus;
  planCode: PlanCode;
  currency: string;
  timezone: string;
  maxTerminals: number;
  maxProducts: number;
  maxUsers: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      org?: OrgContext;
    }
  }
}

/**
 * Short TTL by design. Long enough that a POS syncing a 100-sale outbox does
 * one lookup instead of a hundred; short enough that deactivating a cashier
 * takes effect while the manager is still looking at the screen.
 */
const TTL_MS = 5_000;
const cache = new Map<string, { at: number; org: OrgContext }>();

/** Called whenever something changes that this cache would otherwise hide. */
export function invalidateOrgCache(orgId?: string): void {
  if (!orgId) return cache.clear();
  for (const key of cache.keys()) if (key.startsWith(`${orgId}:`)) cache.delete(key);
}

export async function attachOrg(req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (!req.auth) return next(Unauthorized());
  const { orgId, userId } = req.auth;
  const key = `${orgId}:${userId}`;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    req.org = hit.org;
    return next();
  }

  try {
    // One query answers both questions: the user row proves employment, the
    // nested org+plan proves entitlement.
    const user = await prisma.orgUser.findFirst({
      where: { id: userId, orgId, isActive: true, deletedAt: null },
      select: {
        org: {
          select: {
            id: true,
            status: true,
            planCode: true,
            currency: true,
            timezone: true,
            deletedAt: true,
            plan: { select: { maxTerminals: true, maxProducts: true, maxUsers: true } },
          },
        },
      },
    });

    if (!user || user.org.deletedAt) {
      cache.delete(key);
      return next(new AppError(401, 'ACCOUNT_INACTIVE', 'This account is no longer active'));
    }

    const org: OrgContext = {
      id: user.org.id,
      status: user.org.status,
      planCode: user.org.planCode,
      currency: user.org.currency,
      timezone: user.org.timezone,
      maxTerminals: user.org.plan.maxTerminals,
      maxProducts: user.org.plan.maxProducts,
      maxUsers: user.org.plan.maxUsers,
    };
    cache.set(key, { at: Date.now(), org });
    req.org = org;
    next();
  } catch (err) {
    next(err);
  }
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Suspended and cancelled shops become read-only.
 *
 * Reads are *never* blocked. A shop that stopped paying must always be able to
 * pull its own sales history, its customer list, its stock — holding data
 * hostage is how you turn a lapsed customer into an angry one who tells every
 * other shop owner on the street. Writing is what costs money, so writing is
 * what pauses.
 */
export function requireWritableOrg(req: Request, _res: Response, next: NextFunction): void {
  if (!req.org) return next(Unauthorized());
  if (READ_METHODS.has(req.method) || canWrite(req.org.status)) return next();

  next(
    new AppError(
      402,
      'ORG_SUSPENDED',
      req.org.status === 'CANCELLED'
        ? 'This shop was closed. Reactivate it to start selling again — your data is intact.'
        : 'Selling is paused while billing is sorted out. Your data is safe and reports still work.',
    ),
  );
}

/** requireAuth → attachOrg → requireWritableOrg, in the order they must run. */
export const guarded = [attachOrg, requireWritableOrg];
