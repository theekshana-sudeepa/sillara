import { useMemo, useState } from 'react';
import type { CachedProduct } from '@/lib/db';
import { money } from '@/lib/format';

/**
 * Pick the size and colour actually being sold.
 *
 * The grid shows one tile for "T-Shirt" rather than six, because a clothing
 * shop with forty styles and three hundred variants has an unusable grid
 * otherwise. Tapping the tile asks the one question the cashier still needs
 * answered, and adds the variant — which is an ordinary product, with its own
 * barcode, price and stock.
 *
 * Scanning skips this entirely: the barcode is on the variant, so it goes
 * straight into the cart.
 */

/** Order-independent, matching the server's `attributeKey`. */
const keyOf = (attributes: Record<string, string>): string =>
  Object.keys(attributes)
    .sort()
    .map((k) => `${k}=${attributes[k]}`)
    .join('|');

export function VariantPicker({
  parent,
  variants,
  currency,
  onPick,
  onClose,
}: {
  parent: CachedProduct;
  variants: CachedProduct[];
  currency: string;
  onPick: (variant: CachedProduct) => void;
  onClose: () => void;
}) {
  const options = parent.variantOptions ?? [];
  const [chosen, setChosen] = useState<Record<string, string>>({});

  const byKey = useMemo(() => {
    const map = new Map<string, CachedProduct>();
    for (const v of variants) map.set(keyOf(v.variantAttributes ?? {}), v);
    return map;
  }, [variants]);

  const complete = options.length > 0 && options.every((o) => chosen[o.name]);
  const match = complete ? byKey.get(keyOf(chosen)) : undefined;

  /**
   * A combination that exists but is out of stock still shows — greying it
   * out tells the cashier "we do that, not today", which is what the customer
   * is actually asking. Hiding it looks like it was never made.
   */
  const availability = (optionName: string, value: string): 'ok' | 'empty' | 'missing' => {
    const probe = { ...chosen, [optionName]: value };
    const candidates = [...byKey.entries()].filter(([, v]) => {
      const attrs = v.variantAttributes ?? {};
      return Object.entries(probe).every(([k, val]) => attrs[k] === val);
    });
    if (candidates.length === 0) return 'missing';
    const anyStock = candidates.some(([, v]) => !v.trackStock || v.stockQty > 0);
    return anyStock ? 'ok' : 'empty';
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/50 backdrop-blur-sm sm:items-center" onClick={onClose}>
      <div className="w-full max-w-md rounded-t-2xl bg-card p-5 sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold">{parent.name}</h2>
        <p className="mt-0.5 text-[13px] text-muted-foreground">Which one?</p>

        <div className="mt-4 flex flex-col gap-4">
          {options.map((option) => (
            <div key={option.name}>
              <p className="text-[11.5px] font-bold uppercase tracking-[0.07em] text-muted-foreground">{option.name}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {option.values.map((value) => {
                  const state = availability(option.name, value);
                  const selected = chosen[option.name] === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={selected}
                      disabled={state === 'missing'}
                      onClick={() => setChosen((prev) => ({ ...prev, [option.name]: value }))}
                      className={`pressable min-w-[52px] rounded-xl border px-3.5 py-2.5 text-[14px] font-semibold transition-colors ${
                        selected
                          ? 'border-primary bg-primary text-primary-foreground'
                          : state === 'empty'
                            ? 'border-border bg-card text-subtle-foreground line-through'
                            : 'border-border bg-card hover:border-ring'
                      } disabled:pointer-events-none disabled:opacity-30`}
                    >
                      {value}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {match ? (
          <p className="mt-4 flex items-baseline justify-between rounded-xl bg-secondary px-3.5 py-2.5">
            <span className="text-[13px] font-medium text-muted-foreground">
              {match.trackStock ? `${match.stockQty} in stock` : 'In stock'}
            </span>
            <span className="tabular text-[17px] font-bold">{money(match.price, currency)}</span>
          </p>
        ) : null}

        <div className="mt-4 grid grid-cols-2 gap-2">
          <button onClick={onClose} className="h-12 rounded-xl bg-secondary text-sm font-semibold">
            Cancel
          </button>
          <button
            disabled={!match}
            onClick={() => match && onPick(match)}
            className="h-12 rounded-xl bg-primary text-sm font-bold text-primary-foreground disabled:opacity-50"
          >
            {complete && !match ? 'Not stocked' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  );
}
