import { BadRequest } from '../lib/errors.js';

/**
 * ---------------------------------------------------------------------------
 * ONE PRODUCT, MANY THINGS ON THE SHELF
 * ---------------------------------------------------------------------------
 * A clothing shop does not sell "T-Shirt". It sells a red medium one, and that
 * is what has a barcode, a price and a quantity — so that is what a product
 * row is here. The parent is a folder: it groups the children on the sell grid
 * and holds the option list that generates them.
 *
 * Everything downstream is unchanged by this. The stock ledger, the tax
 * engine, margin reporting and the offline outbox all work on products, and a
 * variant is a product.
 *
 * Pure — no Prisma, no Express. The combination maths is the part worth
 * testing, and it tests in milliseconds.
 * ---------------------------------------------------------------------------
 */

export interface VariantOption {
  /** "Size", "Colour". */
  name: string;
  /** In display order: S, M, L — never alphabetical. */
  values: string[];
}

export interface VariantCombination {
  /** `{ Size: "M", Colour: "Red" }` */
  attributes: Record<string, string>;
  /** "T-Shirt · M / Red" — what the receipt and the picker show. */
  name: string;
  /** Stable within a parent, so re-generating does not duplicate. */
  key: string;
}

const MAX_COMBINATIONS = 200;

/** `{ Size: "M", Colour: "Red" }` → `"Colour=Red|Size=M"`, order-independent. */
export function attributeKey(attributes: Record<string, string>): string {
  return Object.keys(attributes)
    .sort()
    .map((k) => `${k}=${attributes[k]}`)
    .join('|');
}

export function validateOptions(options: readonly VariantOption[]): VariantOption[] {
  if (options.length === 0) throw BadRequest('A variant product needs at least one option, like Size or Colour');
  if (options.length > 3) {
    throw BadRequest('Three options is the practical limit — Size, Colour and one more');
  }

  const seen = new Set<string>();
  const clean = options.map((option) => {
    const name = option.name.trim();
    if (!name) throw BadRequest('Every option needs a name');
    const lower = name.toLowerCase();
    if (seen.has(lower)) throw BadRequest(`"${name}" is listed twice`);
    seen.add(lower);

    // Duplicate values would generate two identical children.
    const values = [...new Set(option.values.map((v) => v.trim()).filter(Boolean))];
    if (values.length === 0) throw BadRequest(`"${name}" needs at least one value`);
    return { name, values };
  });

  const total = clean.reduce((n, o) => n * o.values.length, 1);
  if (total > MAX_COMBINATIONS) {
    // 6 sizes × 8 colours × 5 fits is 240 rows from one screen. Almost always
    // a mistake, and always a mess to undo by hand.
    throw BadRequest(
      `That makes ${total} variants. Keep it under ${MAX_COMBINATIONS} — split into separate products instead.`,
    );
  }

  return clean;
}

/**
 * The cartesian product of the options, in declaration order.
 *
 * Order matters: a picker that lists S, M, L reads as a size chart, and one
 * that lists L, M, S reads as a bug.
 */
export function buildCombinations(baseName: string, options: readonly VariantOption[]): VariantCombination[] {
  const clean = validateOptions(options);

  let rows: Array<Record<string, string>> = [{}];
  for (const option of clean) {
    const next: Array<Record<string, string>> = [];
    for (const row of rows) {
      for (const value of option.values) next.push({ ...row, [option.name]: value });
    }
    rows = next;
  }

  return rows.map((attributes) => ({
    attributes,
    // Values in option order, which is what a human reads: "M / Red".
    name: `${baseName} · ${clean.map((o) => attributes[o.name]).join(' / ')}`,
    key: attributeKey(attributes),
  }));
}

/**
 * A parent is a folder. Selling one is meaningless — it has no stock and no
 * price anyone agreed to — so the sale path has to refuse it rather than
 * quietly ring up a zero.
 */
export function assertSellable(product: { id: string; name: string; variantOptions: unknown }): void {
  if (product.variantOptions) {
    throw BadRequest(`"${product.name}" has variants — pick the size or colour being sold`);
  }
}

export const isParent = (product: { variantOptions: unknown }): boolean => Boolean(product.variantOptions);
