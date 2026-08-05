import rateLimit from 'express-rate-limit';

const json = { ok: false, error: { code: 'RATE_LIMITED', message: 'Too many requests' } };

/**
 * Limits are off under test.
 *
 * The store is in-memory and per-process, so when the runner packs two test
 * files into one worker they share a counter that neither of them knows about
 * — the suite then fails on whichever signup happens to be the twenty-first,
 * which is a scheduling detail rather than a defect. That same per-process
 * store is a real production limitation: under PM2 cluster every limit
 * multiplies by the instance count and resets on deploy. Fixing that needs a
 * shared store; this flag only stops it corrupting the tests meanwhile.
 */
const skip = (): boolean => process.env.NODE_ENV === 'test';

export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600, // POS terminals sync frequently — generous envelope
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: json,
  skip,
});

/** Signup + login + magic-link: the abuse surface of a self-serve platform. */
export const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
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
  keyGenerator: (req) => `pin:${(req.body as { userId?: string } | undefined)?.userId ?? req.ip}`,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: json,
  skip,
});
