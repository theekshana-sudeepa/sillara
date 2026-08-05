import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { UserRole } from '@prisma/client';
import { env } from '../config/env.js';
import { Forbidden, Unauthorized } from '../lib/errors.js';

/**
 * The token IS the tenancy. `orgId` is baked into the JWT at login and is the
 * only source of tenant identity — never a header, never a query param, never
 * a body field a client could tamper with. Every downstream query scopes by
 * `req.auth.orgId`, which makes cross-tenant reads structurally impossible
 * rather than "hopefully filtered".
 */
export interface AuthContext {
  userId: string;
  orgId: string;
  role: UserRole;
  email: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export function signToken(ctx: AuthContext): string {
  return jwt.sign(ctx, env.JWT_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL,
    issuer: 'sillara',
    audience: 'sillara-pos',
  } as jwt.SignOptions);
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return next(Unauthorized());
  try {
    req.auth = jwt.verify(header.slice(7), env.JWT_SECRET, {
      issuer: 'sillara',
      audience: 'sillara-pos',
    }) as AuthContext;
    next();
  } catch {
    next(Unauthorized('Session expired — sign in again'));
  }
}

const RANK: Record<UserRole, number> = { CASHIER: 0, MANAGER: 1, OWNER: 2 };

/** requireRole('MANAGER') — a MANAGER or OWNER passes; a CASHIER does not. */
export function requireRole(minimum: UserRole) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) return next(Unauthorized());
    if (RANK[req.auth.role] < RANK[minimum]) return next(Forbidden(`Requires ${minimum} access`));
    next();
  };
}
