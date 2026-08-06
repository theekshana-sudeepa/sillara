import { Prisma, type BusinessType } from '@prisma/client';
import { templateFor } from './templates.js';

/**
 * ---------------------------------------------------------------------------
 * THE STARTER CATALOGUE
 * ---------------------------------------------------------------------------
 * A shop must look alive the second the owner walks in — an empty grid is a
 * shop that has not started yet, and the whole promise is "selling in ten
 * minutes". So a preset lands with the categories that vertical actually uses:
 * a pharmacy opens on Prescription / OTC / Personal Care, not on Drinks and
 * Snacks.
 *
 * Two rules keep this from becoming a mess:
 *
 *   • Prices are scaled to the shop's currency. $1 water in an LKR shop reads
 *     as broken software before the owner has sold anything.
 *   • It never runs over an existing catalogue. Seeding is for an empty shop;
 *     an owner who has entered their real products must never find sample
 *     items appearing among them because they changed a setting.
 * ---------------------------------------------------------------------------
 */

/** LKR shops get LKR-shaped sample prices, not $1 water. */
export const PRICE_SCALE: Record<string, number> = {
  LKR: 300,
  INR: 80,
  BDT: 110,
  NPR: 130,
  PKR: 280,
  IDR: 15000,
  NGN: 1500,
  KES: 130,
};

export interface SeedResult {
  categories: number;
  products: number;
  removed: number;
  skipped: boolean;
}

/**
 * Remove the previous preset's sample items, and only those.
 *
 * A shop provisions as general retail and then picks "Pharmacy" in the wizard.
 * Without this it opens on Prescription and OTC *next to* Drinks and Snacks,
 * which reads as a broken import.
 *
 * The test for "safe to remove" is deliberately strict: the product still has
 * the exact name the old template gave it, it has never been sold, and it
 * holds no stock. Anything an owner has touched — renamed, priced, received,
 * or sold even once — stays. Deleting real catalogue data to tidy up a preset
 * would be a far worse bug than a few leftover rows.
 */
async function removeUntouchedStarter(
  tx: Prisma.TransactionClient,
  orgId: string,
  previous: BusinessType,
): Promise<number> {
  const old = templateFor(previous);
  const names = old.categories.flatMap((c) => c.items.map((i) => i.name));
  if (names.length === 0) return 0;

  const candidates = await tx.product.findMany({
    where: { orgId, name: { in: names }, deletedAt: null, stockQty: 0 },
    select: { id: true, _count: { select: { saleItems: true } } },
  });
  const removable = candidates.filter((p) => p._count.saleItems === 0).map((p) => p.id);
  if (removable.length === 0) return 0;

  const { count } = await tx.product.deleteMany({ where: { id: { in: removable }, orgId } });

  // Categories the old preset created that are now empty go too — an empty
  // "Snacks" tile on a pharmacy till is the same confusion in miniature.
  const oldCategoryNames = old.categories.map((c) => c.name);
  const empties = await tx.category.findMany({
    where: { orgId, name: { in: oldCategoryNames }, deletedAt: null, products: { none: {} } },
    select: { id: true },
  });
  if (empties.length > 0) {
    await tx.category.deleteMany({ where: { id: { in: empties.map((c) => c.id) }, orgId } });
  }

  return count;
}

/**
 * Write a template's starter catalogue.
 *
 * Must run inside a transaction that owns the org, so a half-seeded shop is
 * never visible. Returns `skipped` when there was already a catalogue here.
 */
export async function seedCatalog(
  tx: Prisma.TransactionClient,
  args: {
    orgId: string;
    businessType: BusinessType;
    currency: string;
    force?: boolean;
    /** The preset being replaced, whose untouched samples should make way. */
    replacing?: BusinessType;
  },
): Promise<SeedResult> {
  const template = templateFor(args.businessType);
  const scale = PRICE_SCALE[args.currency] ?? 1;

  const removed =
    args.replacing && args.replacing !== args.businessType
      ? await removeUntouchedStarter(tx, args.orgId, args.replacing)
      : 0;

  if (!args.force) {
    const existing = await tx.product.count({ where: { orgId: args.orgId, deletedAt: null } });
    // A shop with a real catalogue keeps it. Sample items never appear among
    // stock somebody actually entered.
    if (existing > 0) return { categories: 0, products: 0, removed, skipped: true };
  }

  let products = 0;
  for (const [i, group] of template.categories.entries()) {
    // A category may already exist by name from a previous preset; reuse it
    // rather than colliding with UNIQUE(orgId, name).
    const category =
      (await tx.category.findFirst({ where: { orgId: args.orgId, name: group.name, deletedAt: null } })) ??
      (await tx.category.create({
        data: { orgId: args.orgId, name: group.name, color: group.color, sortOrder: i },
      }));

    const created = await tx.product.createMany({
      data: group.items.map((item) => ({
        orgId: args.orgId,
        categoryId: category.id,
        name: item.name,
        price: new Prisma.Decimal(Math.round(item.price * scale * 100) / 100),
        unit: item.unit ?? template.defaultUnit,
      })),
    });
    products += created.count;
  }

  return { categories: template.categories.length, products, removed, skipped: false };
}
