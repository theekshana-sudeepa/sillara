import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, ok } from '../../lib/http.js';
import { validate } from '../../middleware/validate.js';
import type { TenderType } from '@prisma/client';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { NotFound, BadRequest } from '../../lib/errors.js';
import { D, toNumber } from '../../lib/money.js';
import { postCredit } from '../../domain/credit.js';

const customerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.string().trim().toLowerCase().email().nullable().optional().or(z.literal('').transform(() => null)),
  notes: z.string().trim().max(2000).nullable().optional(),
});

export const customersRouter = Router();
customersRouter.use(requireAuth);

customersRouter.get(
  '/',
  validate({ query: z.object({ search: z.string().trim().max(80).optional() }) }),
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    const search = (req.query as { search?: string }).search;
    const customers = await prisma.customer.findMany({
      where: {
        orgId,
        deletedAt: null,
        ...(search ? { OR: [{ name: { contains: search } }, { phone: { contains: search } }] } : {}),
      },
      orderBy: { name: 'asc' },
      take: 200,
    });
    ok(res, customers);
  }),
);

customersRouter.post(
  '/',
  validate({ body: customerSchema }),
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    const customer = await prisma.customer.create({ data: { orgId, ...(req.body as z.infer<typeof customerSchema>) } });
    ok(res, customer, 201);
  }),
);

customersRouter.patch(
  '/:id',
  validate({ params: z.object({ id: z.string().cuid() }), body: customerSchema.partial() }),
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    const existing = await prisma.customer.findFirst({ where: { id: req.params.id!, orgId, deletedAt: null } });
    if (!existing) throw NotFound('Customer');
    ok(res, await prisma.customer.update({ where: { id: existing.id }, data: req.body as never }));
  }),
);

/** The tab: what they owe, and how it got there. */
customersRouter.get(
  '/:id/credit',
  validate({
    params: z.object({ id: z.string().cuid() }),
    query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
  }),
  asyncHandler(async (req, res) => {
    const { orgId } = req.auth!;
    const customer = await prisma.customer.findFirst({
      where: { id: req.params.id!, orgId, deletedAt: null },
      select: { id: true, name: true, creditBalance: true },
    });
    if (!customer) throw NotFound('Customer');

    const transactions = await prisma.customerCreditTransaction.findMany({
      where: { orgId, customerId: customer.id },
      orderBy: { createdAt: 'desc' },
      take: Number(req.query.limit),
      include: { sale: { select: { number: true } } },
    });

    ok(res, {
      customer: { id: customer.id, name: customer.name },
      balance: toNumber(customer.creditBalance),
      transactions: transactions.map((t) => ({
        id: t.id,
        type: t.type,
        amount: toNumber(t.amount),
        method: t.method,
        note: t.note,
        receiptNumber: t.sale?.number ?? null,
        createdAt: t.createdAt,
      })),
    });
  }),
);

/**
 * Pay down a tab.
 *
 * The other half of an account sale. Without it a CREDIT balance only ever
 * grows, which is a debt register rather than a ledger.
 */
customersRouter.post(
  '/:id/credit/settle',
  requireRole('MANAGER'),
  validate({
    params: z.object({ id: z.string().cuid() }),
    body: z.object({
      amount: z.coerce.number().positive().max(99_999_999),
      method: z.enum(['CASH', 'CARD', 'QR', 'OTHER']).default('CASH'),
      note: z.string().trim().max(255).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { orgId, userId } = req.auth!;
    const body = req.body as { amount: number; method: TenderType; note?: string };

    const customer = await prisma.customer.findFirst({
      where: { id: req.params.id!, orgId, deletedAt: null },
      select: { id: true, creditBalance: true },
    });
    if (!customer) throw NotFound('Customer');

    // Paying more than is owed would leave a negative balance, which reads as
    // the shop owing the customer — a different product (store credit) that
    // this table does not mean.
    if (D(body.amount).gt(customer.creditBalance)) {
      throw BadRequest(`They owe ${toNumber(customer.creditBalance).toFixed(2)} — you cannot settle more than that`);
    }

    const updated = await prisma.$transaction(async (tx) => {
      await postCredit(tx, { orgId, userId }, [
        {
          customerId: customer.id,
          type: 'SETTLE',
          amount: D(body.amount).negated(),
          method: body.method,
          note: body.note ?? 'Payment received',
        },
      ]);
      return tx.customer.findUniqueOrThrow({ where: { id: customer.id }, select: { creditBalance: true } });
    });

    ok(res, { customerId: customer.id, balance: toNumber(updated.creditBalance) }, 201);
  }),
);
