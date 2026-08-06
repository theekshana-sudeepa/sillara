import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, ok } from '../../lib/http.js';
import { validate } from '../../middleware/validate.js';
import type { UserRole } from '@prisma/client';
import { publicLimiter, pinLimiter } from '../../middleware/rateLimit.js';
import { requireAuth, requireRole, signToken } from '../../middleware/auth.js';
import { invalidateOrgCache } from '../../middleware/org.js';
import { DUMMY_PASSWORD_HASH, hashPassword, hashPin, sha256, verifyPassword, verifyPin } from '../../lib/crypto.js';
import { BadRequest, Unauthorized, Conflict, NotFound, Forbidden } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { resolveCapabilities } from '../../capabilities/resolve.js';

const passwordSchema = z.string().min(8, 'At least 8 characters').max(128);

export const authRouter = Router();

/**
 * Magic-link activation — the last step of provisioning. Consumes the token,
 * sets the owner's password, returns a live session. From email click to
 * selling: one form.
 */
authRouter.post(
  '/activate',
  publicLimiter,
  validate({ body: z.object({ token: z.string().min(20), password: passwordSchema }) }),
  asyncHandler(async (req, res) => {
    const user = await prisma.orgUser.findUnique({
      where: { magicToken: sha256(req.body.token as string) },
      include: { org: true },
    });
    if (!user || !user.magicExpiresAt || user.magicExpiresAt < new Date()) {
      throw BadRequest('This activation link is invalid or expired. Sign up again or ask for a new link.');
    }

    await prisma.orgUser.update({
      where: { id: user.id },
      data: {
        passwordHash: await hashPassword(req.body.password as string),
        magicToken: null,
        magicExpiresAt: null,
        lastLoginAt: new Date(),
      },
    });

    ok(res, {
      token: signToken({ userId: user.id, orgId: user.orgId, role: user.role, email: user.email }),
      org: { id: user.org.id, slug: user.org.slug, name: user.org.name, currency: user.org.currency, language: user.org.language },
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  }),
);

/**
 * Sign in.
 *
 * `OrgUser` is unique on (orgId, email), so one person can hold accounts at
 * several shops under one address — which is the normal case for the owner of
 * two branches trading as separate businesses, and for the bookkeeper who
 * works for four of them.
 *
 * This used to take `findFirst(... orderBy createdAt asc)`: the oldest account
 * won and every other shop that email belonged to was simply unreachable. No
 * error, no chooser — the second shop just could not be logged into.
 *
 * So: verify the password against every account that address holds, and if
 * more than one answers, hand back the list and let them pick. The list is
 * only ever returned *after* a password matched, so it tells an attacker
 * nothing they did not already know.
 */
const MAX_ACCOUNTS_PER_EMAIL = 10;

authRouter.post(
  '/login',
  publicLimiter,
  validate({
    body: z.object({
      email: z.string().trim().toLowerCase().email(),
      password: z.string().min(1),
      /// Supplied on the second call when the first returned a chooser.
      orgId: z.string().cuid().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { email, password, orgId } = req.body as { email: string; password: string; orgId?: string };

    const candidates = await prisma.orgUser.findMany({
      where: {
        email,
        deletedAt: null,
        isActive: true,
        ...(orgId ? { orgId } : {}),
        org: { deletedAt: null },
      },
      include: { org: true },
      orderBy: { createdAt: 'asc' },
      take: MAX_ACCOUNTS_PER_EMAIL,
    });

    // Always do the work, even when there is no such user — see DUMMY_PASSWORD_HASH.
    if (candidates.length === 0) {
      await verifyPassword(password, DUMMY_PASSWORD_HASH);
      throw Unauthorized('Incorrect email or password');
    }

    const matched: typeof candidates = [];
    for (const candidate of candidates) {
      if (candidate.passwordHash && (await verifyPassword(password, candidate.passwordHash))) {
        matched.push(candidate);
      }
    }
    if (matched.length === 0) throw Unauthorized('Incorrect email or password');

    // Several shops, same credentials: ask which one rather than guessing.
    if (matched.length > 1) {
      ok(res, {
        mode: 'choose',
        shops: matched.map((m) => ({
          orgId: m.org.id,
          name: m.org.name,
          slug: m.org.slug,
          role: m.role,
          suspended: m.org.status === 'SUSPENDED' || m.org.status === 'CANCELLED',
        })),
      });
      return;
    }

    const user = matched[0]!;
    if (user.org.status === 'SUSPENDED' || user.org.status === 'CANCELLED') {
      throw Unauthorized('This shop is suspended. Contact support@sillara.com');
    }

    await prisma.orgUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    ok(res, {
      mode: 'ready',
      token: signToken({ userId: user.id, orgId: user.orgId, role: user.role, email: user.email }),
      org: { id: user.org.id, slug: user.org.slug, name: user.org.name, currency: user.org.currency, language: user.org.language },
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  }),
);

/**
 * Everything the till needs to draw itself.
 *
 * Capabilities are resolved server-side and shipped here, so the client never
 * re-derives them from business type — it cannot, and it must not try. The
 * till asks "can I do X?"; the answer arrives already decided, with the plan
 * applied. `blockedByPlan` comes too, because a shop should be told what it is
 * missing rather than shown a smaller product with no explanation.
 */
authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.orgUser.findFirst({
      where: { id: req.auth!.userId, deletedAt: null },
      include: { org: { include: { plan: true } } },
    });
    if (!user) throw Unauthorized();

    const resolved = resolveCapabilities({
      businessType: user.org.businessType,
      overrides: user.org.capabilities,
      planFeatures: (user.org.plan.features as string[] | null) ?? [],
      layout: user.org.layout,
    });

    ok(res, {
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      org: {
        id: user.org.id,
        slug: user.org.slug,
        name: user.org.name,
        currency: user.org.currency,
        timezone: user.org.timezone,
        language: user.org.language,
        status: user.org.status,
        plan: user.org.planCode,
        trialEndsAt: user.org.trialEndsAt,
        businessType: user.org.businessType,
      },
      capabilities: resolved.active,
      blockedByPlan: resolved.blockedByPlan,
      layout: resolved.layout,
    });
  }),
);

// --- staff management (cashiers with PINs) ---------------------------------

authRouter.get(
  '/staff',
  requireAuth,
  requireRole('MANAGER'),
  asyncHandler(async (req, res) => {
    const staff = await prisma.orgUser.findMany({
      where: { orgId: req.auth!.orgId, deletedAt: null },
      select: { id: true, name: true, email: true, role: true, isActive: true, lastLoginAt: true },
      orderBy: { createdAt: 'asc' },
    });
    ok(res, staff);
  }),
);

authRouter.post(
  '/staff',
  requireAuth,
  requireRole('MANAGER'),
  validate({
    body: z.object({
      name: z.string().trim().min(2).max(120),
      email: z.string().trim().toLowerCase().email(),
      role: z.enum(['MANAGER', 'CASHIER']).default('CASHIER'),
      pin: z.string().regex(/^\d{4}$/, 'PIN must be 4 digits'),
    }),
  }),
  asyncHandler(async (req, res) => {
    const exists = await prisma.orgUser.findFirst({
      where: { orgId: req.auth!.orgId, email: req.body.email as string, deletedAt: null },
    });
    if (exists) throw Conflict('A staff member with that email already exists');

    const user = await prisma.orgUser.create({
      data: {
        orgId: req.auth!.orgId,
        name: req.body.name as string,
        email: req.body.email as string,
        role: req.body.role as 'MANAGER' | 'CASHIER',
        pin: await hashPin(req.body.pin as string),
      },
      select: { id: true, name: true, email: true, role: true, isActive: true },
    });
    ok(res, user, 201);
  }),
);

/**
 * Cashier PIN switch — fast user change on a shared terminal, same org only.
 *
 * This endpoint hands out a full session for another user, including the
 * owner, in exchange for four digits. With no counter, a cashier who already
 * holds a valid token can walk all 10,000 combinations well inside the normal
 * rate limit and come back as OWNER — an escalation that leaves no trace.
 *
 * So: lock the target account after a handful of misses, and write down every
 * attempt either way. The lockout is per-target rather than per-IP because the
 * account is what is under attack, and an attacker can change IP far more
 * easily than they can change which owner they are trying to become.
 */
const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCKOUT_MS = 15 * 60 * 1000;

authRouter.post(
  '/switch',
  requireAuth,
  pinLimiter,
  validate({ body: z.object({ userId: z.string().cuid(), pin: z.string().regex(/^\d{4}$/) }) }),
  asyncHandler(async (req, res) => {
    const { orgId, userId: actorId } = req.auth!;
    const targetId = req.body.userId as string;

    const target = await prisma.orgUser.findFirst({
      where: { id: targetId, orgId, deletedAt: null, isActive: true },
    });

    // One message for every failure below — "wrong PIN" must not also answer
    // "does this user exist" or "have you locked them out yet".
    const reject = (): never => {
      throw Unauthorized('Wrong PIN');
    };

    if (!target?.pin) return reject();

    if (target.pinLockedUntil && target.pinLockedUntil > new Date()) {
      const minutes = Math.max(1, Math.ceil((target.pinLockedUntil.getTime() - Date.now()) / 60_000));
      await audit({
        orgId,
        actorId,
        action: 'auth.pin_switch.locked_out',
        entity: 'OrgUser',
        entityId: target.id,
        ip: req.ip,
      });
      throw Unauthorized(`Too many wrong PINs. Try again in ${minutes} minute(s), or sign in with a password.`);
    }

    if (!(await verifyPin(req.body.pin as string, target.pin))) {
      const attempts = target.pinFailedAttempts + 1;
      const locking = attempts >= PIN_MAX_ATTEMPTS;
      await prisma.orgUser.update({
        where: { id: target.id },
        data: {
          pinFailedAttempts: locking ? 0 : attempts,
          pinLockedUntil: locking ? new Date(Date.now() + PIN_LOCKOUT_MS) : null,
        },
      });
      await audit({
        orgId,
        actorId,
        action: locking ? 'auth.pin_switch.locked' : 'auth.pin_switch.failed',
        entity: 'OrgUser',
        entityId: target.id,
        detail: { attempts, targetRole: target.role },
        ip: req.ip,
      });
      return reject();
    }

    await prisma.orgUser.update({
      where: { id: target.id },
      data: { pinFailedAttempts: 0, pinLockedUntil: null, lastLoginAt: new Date() },
    });
    await audit({
      orgId,
      actorId,
      action: 'auth.pin_switch.ok',
      entity: 'OrgUser',
      entityId: target.id,
      detail: { targetRole: target.role },
      ip: req.ip,
    });

    ok(res, {
      token: signToken({ userId: target.id, orgId: target.orgId, role: target.role, email: target.email }),
      user: { id: target.id, name: target.name, role: target.role },
    });
  }),
);

/**
 * Change or deactivate a staff member.
 *
 * This did not exist. `attachOrg` has always refused a token whose user is
 * `isActive: false` — the enforcement was correct and complete — but nothing
 * in the API could ever set that flag. Firing a cashier required someone with
 * a MySQL prompt, which in practice means it did not happen.
 *
 * The guards below all protect the same thing: a shop must not be able to lock
 * itself out of its own account.
 */
authRouter.patch(
  '/staff/:id',
  requireAuth,
  requireRole('MANAGER'),
  validate({
    params: z.object({ id: z.string().cuid() }),
    body: z
      .object({
        name: z.string().trim().min(2).max(120).optional(),
        role: z.enum(['OWNER', 'MANAGER', 'CASHIER']).optional(),
        isActive: z.boolean().optional(),
        pin: z.string().regex(/^\d{4}$/, 'PIN must be 4 digits').optional(),
      })
      .refine((b) => Object.keys(b).length > 0, 'Nothing to change'),
  }),
  asyncHandler(async (req, res) => {
    const { orgId, userId: actorId, role: actorRole } = req.auth!;
    const body = req.body as { name?: string; role?: UserRole; isActive?: boolean; pin?: string };

    const target = await prisma.orgUser.findFirst({
      where: { id: req.params.id!, orgId, deletedAt: null },
    });
    if (!target) throw NotFound('Staff member');

    // A manager cannot edit an owner, nor mint one.
    if (actorRole !== 'OWNER' && (target.role === 'OWNER' || body.role === 'OWNER')) {
      throw Forbidden('Only an owner can change owner access');
    }

    // Deactivating yourself ends your own session on the next request.
    if (target.id === actorId && body.isActive === false) {
      throw BadRequest('You cannot deactivate your own account — ask another owner or manager');
    }

    // The shop must keep at least one way in.
    const losingAnOwner = target.role === 'OWNER' && (body.isActive === false || (body.role && body.role !== 'OWNER'));
    if (losingAnOwner) {
      const otherOwners = await prisma.orgUser.count({
        where: { orgId, role: 'OWNER', isActive: true, deletedAt: null, id: { not: target.id } },
      });
      if (otherOwners === 0) throw Conflict('This is the last owner — promote someone else first');
    }

    const updated = await prisma.orgUser.update({
      where: { id: target.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        ...(body.pin !== undefined ? { pin: await hashPin(body.pin), pinFailedAttempts: 0, pinLockedUntil: null } : {}),
      },
      select: { id: true, name: true, email: true, role: true, isActive: true },
    });

    // The entitlement cache keys on user+org and holds for a few seconds. A
    // deactivation the manager can still see working is worse than no button.
    invalidateOrgCache(orgId);

    await audit({
      orgId,
      actorId,
      action: body.isActive === false ? 'staff.deactivated' : 'staff.updated',
      entity: 'OrgUser',
      entityId: target.id,
      detail: {
        changed: Object.keys(body),
        ...(body.role ? { fromRole: target.role, toRole: body.role } : {}),
      },
      ip: req.ip,
    });

    ok(res, updated);
  }),
);
