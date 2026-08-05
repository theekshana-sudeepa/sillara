import { Prisma, type StockMoveType } from '@prisma/client';
import { D, money } from '../lib/money.js';
import { NotFound } from '../lib/errors.js';

/**
 * ---------------------------------------------------------------------------
 * THE ONLY WAY STOCK MOVES
 * ---------------------------------------------------------------------------
 * Three things have to change together, every time, or inventory quietly lies:
 *
 *   1. `stock_movements`   — the immutable ledger. What happened, and why.
 *   2. `products.stockQty` — the org-wide cached balance (the sell screen).
 *   3. `branch_stock.qty`  — the per-location cached balance.
 *
 * Before this module, each route did its own two-of-three. Selling wrote all
 * three. Receiving goods wrote two. Voids and stocktakes wrote two — a
 * different two. The failure was invisible in exactly the worst way: the org
 * rollup, which is the number everyone looks at, stayed correct, while the
 * per-branch balance decayed downward on every sale and was never put back.
 *
 * The bug was never one careless line. It was that "how stock moves" had no
 * home, so every new route re-derived it and each one drifted a little.
 *
 * So routes no longer touch those three tables. They describe a movement and
 * this module posts it. One rule, one place, one transaction — the same shape
 * as `decideLifecycle` and `computeLoyalty`, the two pieces of this codebase
 * that have never had an integrity bug.
 * ---------------------------------------------------------------------------
 */

/**
 * A transfer relocates stock between branches; it never changes how much the
 * business owns. The org-wide rollup must not move for these two types — the
 * per-branch balances carry the whole story.
 */
const RELOCATION_TYPES: ReadonlySet<StockMoveType> = new Set<StockMoveType>(['TRANSFER_IN', 'TRANSFER_OUT']);

export interface StockContext {
  orgId: string;
  /** Null only for orgs provisioned before branches existed. */
  branchId: string | null;
  userId?: string | null;
}

export interface StockPosting {
  productId: string;
  /** Signed. What leaves is negative, what arrives is positive. */
  qty: Prisma.Decimal | number;
  type: StockMoveType;
  /** Cost per unit on RECEIVE rows — this is what margin reporting grows from. */
  unitCost?: number | Prisma.Decimal | null;
  note?: string | null;
  refType?: string | null;
  refId?: string | null;
}

/**
 * Post one or more movements. Must be called inside a transaction that also
 * carries whatever caused the movement (the sale, the receipt, the void), so
 * stock and its reason can never be committed apart.
 */
export async function postStock(
  tx: Prisma.TransactionClient,
  ctx: StockContext,
  postings: readonly StockPosting[],
): Promise<void> {
  for (const posting of postings) {
    const qty = D(posting.qty);
    // A zero movement is noise in an audit trail that people read by hand.
    if (qty.isZero()) continue;

    if (!RELOCATION_TYPES.has(posting.type)) {
      await tx.product.update({
        where: { id: posting.productId },
        data: { stockQty: { increment: qty } },
      });
    }

    if (ctx.branchId) {
      await tx.branchStock.upsert({
        where: { branchId_productId: { branchId: ctx.branchId, productId: posting.productId } },
        create: { orgId: ctx.orgId, branchId: ctx.branchId, productId: posting.productId, qty },
        update: { qty: { increment: qty } },
      });
    }

    await tx.stockMovement.create({
      data: {
        orgId: ctx.orgId,
        branchId: ctx.branchId,
        productId: posting.productId,
        type: posting.type,
        qty,
        unitCost: posting.unitCost != null ? money(posting.unitCost) : null,
        note: posting.note ?? null,
        refType: posting.refType ?? null,
        refId: posting.refId ?? null,
        createdById: ctx.userId ?? null,
      },
    });
  }
}

/**
 * Stocktake: "there are 40 on the shelf." Recorded as the delta that makes it
 * so, because the ledger only ever speaks in movements.
 *
 * The lock matters. Read-compute-set is a lost update waiting to happen: a
 * sale landing between the read and the set is silently erased, and the COUNT
 * row records a delta that never reconciles. Every stock writer updates the
 * `products` row, so taking that row first serialises a stocktake against the
 * till without needing a lock the rest of the code has to know about.
 */
export async function setStockLevel(
  tx: Prisma.TransactionClient,
  ctx: StockContext,
  args: { productId: string; counted: number; note: string },
): Promise<{ previous: Prisma.Decimal; counted: Prisma.Decimal; delta: Prisma.Decimal }> {
  await tx.$queryRaw`SELECT id FROM products WHERE id = ${args.productId} FOR UPDATE`;

  // Counting happens at a place. With branches, the count sets that branch's
  // shelf and moves the org rollup by the difference — counting the Colombo
  // shop must not overwrite what Kandy holds.
  const previous = ctx.branchId
    ? (
        await tx.branchStock.findUnique({
          where: { branchId_productId: { branchId: ctx.branchId, productId: args.productId } },
          select: { qty: true },
        })
      )?.qty ?? D(0)
    : (
        await tx.product.findUniqueOrThrow({
          where: { id: args.productId },
          select: { stockQty: true },
        })
      ).stockQty;

  const counted = D(args.counted);
  const delta = counted.minus(previous);

  await postStock(tx, ctx, [{ productId: args.productId, qty: delta, type: 'COUNT', note: args.note }]);

  return { previous, counted, delta };
}

/**
 * Blend a delivery's cost into the cost already on the shelf.
 *
 * Receiving used to overwrite: the newest supplier price became the cost of
 * every unit, including the ones bought cheaper last month. That is what made
 * historical margin move — and it also misstates the stock on hand, which is
 * a balance-sheet number.
 *
 * Weighted average is the right default for a POS. FIFO is more precise and
 * needs per-batch cost layers; nothing here carries batches yet, and a wrong
 * average beats a confident lie.
 */
export function weightedAverageCost(args: {
  currentQty: Prisma.Decimal | number;
  currentCost: Prisma.Decimal | number;
  receivedQty: Prisma.Decimal | number;
  receivedCost: Prisma.Decimal | number;
}): Prisma.Decimal {
  // Negative stock is an oversell, not a holding worth averaging against.
  const onHand = Prisma.Decimal.max(D(args.currentQty), D(0));
  const incoming = D(args.receivedQty);
  const totalQty = onHand.plus(incoming);

  if (totalQty.lte(0)) return money(args.receivedCost);

  const value = onHand.mul(D(args.currentCost)).plus(incoming.mul(D(args.receivedCost)));
  return money(value.div(totalQty));
}

/**
 * Resolve the branch a movement belongs to, proving it belongs to this org on
 * the way through.
 *
 * Both halves matter. Single-branch shops send no branchId and must still land
 * in their default branch, or per-branch stock is empty for the majority of
 * tenants. And a branchId that arrives from a device is untrusted input: an id
 * belonging to another org would otherwise write that org's shelf.
 */
export async function resolveBranchId(
  db: Prisma.TransactionClient,
  orgId: string,
  requested?: string | null,
): Promise<string | null> {
  if (requested) {
    const branch = await db.branch.findFirst({
      where: { id: requested, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!branch) throw NotFound('Branch');
    return branch.id;
  }

  const fallback = await db.branch.findFirst({
    where: { orgId, isDefault: true, deletedAt: null },
    select: { id: true },
  });
  return fallback?.id ?? null;
}
