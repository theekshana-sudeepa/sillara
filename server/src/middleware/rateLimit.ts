import rateLimit from 'express-rate-limit';
import { MySqlRateLimitStore } from '../lib/rateLimitStore.js';

const json = { ok: false, error: { code: 'RATE_LIMITED', message: 'Too many requests' } };

/**
 * Limits are off under test.
 *
 * A suite that creates a shop per test legitimately trips a 20-per-15-minutes
 * signup limit, and which test lands on the twenty-first depends on how the
 * runner packs files into workers — a scheduling detail rather than a defect.
 * The limits themselves are exercised directly where they matter (see the PIN
 * lockout tests, which drive the counter rather than the limiter).
 */
const skip = (): boolean => process.env.NODE_ENV === 'test';

/**
 * Deliberately in-memory, unlike the two below.
 *
 * This is coarse protection against one client hammering the API, and it sits
 * in front of every request including sale sync. Putting a database write on
 * the sell path to make it cluster-accurate would cost more than it buys —
 * volumetric abuse belongs at the edge (Nginx, Cloudflare), where the traffic
 * can be dropped without touching Node at all.
 */
export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600, // POS terminals sync frequently — generous envelope
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: json,
  skip,
});

/**
 * Signup + login + magic-link: the abuse surface of a self-serve platform.
 *
 * Shared across instances. Under PM2 cluster an in-memory store makes "20 per
 * 15 minutes" mean "20 per worker, reset on every deploy" — which is not a
 * limit so much as a suggestion, and the reset lands exactly when the surface
 * is most worth hitting.
 */
export const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  store: new MySqlRateLimitStore(),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: json,
  skip,
});

/**
 * PIN switching mints a session for another user from four digits, so the
 * search space is 10,000 — small enough that the ordinary 600-per-15-minutes
 * envelope is an attack budget rather than a limit.
 *
 * Keyed per target account, not per IP. A whole shop leaves through one NAT
 * address, so an IP-keyed limit counts every till's shift change against the
 * same budget and starts refusing real cashiers on a busy afternoon — the
 * limiter would become an outage. Nobody legitimately switches into the *same*
 * account twenty times in a quarter of an hour.
 *
 * This is the second of two brakes. The per-user lockout in auth.routes.ts is
 * the one that actually stops a walk through the keyspace, because it survives
 * an attacker changing address.
 */
export const pinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  store: new MySqlRateLimitStore(),
  keyGenerator: (req) => `pin:${(req.body as { userId?: string } | undefined)?.userId ?? req.ip}`,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: json,
  skip,
});
