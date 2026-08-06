import { describe, it, expect } from 'vitest';
import { resolveCapabilities } from './resolve.js';
import { CORE_CAPABILITIES } from './registry.js';

/**
 * The resolver decides what every screen in the product is allowed to show, so
 * the rules it encodes are worth pinning down precisely — particularly the one
 * that matters commercially: no combination of preset and preference can hand
 * a shop something it is not paying for.
 */

const PRO = [
  'sell',
  'products',
  'daily_report',
  'inventory',
  'customers',
  'whatsapp_receipts',
  'loyalty',
  'multi_branch',
  'shifts',
  'purchase_orders',
];
const FREE = ['sell', 'products', 'daily_report'];

const resolve = (over: Partial<Parameters<typeof resolveCapabilities>[0]> = {}) =>
  resolveCapabilities({ businessType: 'GENERAL_RETAIL', planFeatures: PRO, ...over });

describe('core capabilities', () => {
  it('are on for everyone, on every plan', () => {
    const free = resolve({ planFeatures: FREE });
    for (const id of CORE_CAPABILITIES) expect(free.active).toContain(id);
  });

  it('cannot be switched off, however hard the owner tries', () => {
    const result = resolve({ overrides: { disabled: ['sell', 'products', 'daily_report'] } });
    for (const id of CORE_CAPABILITIES) expect(result.active).toContain(id);
  });
});

describe('the preset chooses, the owner adjusts', () => {
  it('gives a pharmacy batch tracking without anyone asking', () => {
    expect(resolve({ businessType: 'PHARMACY' }).active).toContain('stock.batches');
  });

  it('does not give a general shop batch tracking', () => {
    expect(resolve({ businessType: 'GENERAL_RETAIL' }).active).not.toContain('stock.batches');
  });

  it('lets a hardware shop turn batches on anyway — no vertical name required', () => {
    // The whole point of capabilities: a shop is not trapped by its label.
    const result = resolve({ businessType: 'HARDWARE', overrides: { enabled: ['stock.batches'] } });
    expect(result.active).toContain('stock.batches');
  });

  it('lets a grocery turn off something its preset switched on', () => {
    const result = resolve({ businessType: 'GROCERY', overrides: { disabled: ['sell.scale'] } });
    expect(result.active).not.toContain('sell.scale');
    expect(result.active).toContain('stock.batches'); // the rest of the preset survives
  });

  it('ignores junk in the overrides column instead of falling over', () => {
    expect(() => resolve({ overrides: { enabled: ['not_a_capability', 42, null] } })).not.toThrow();
    expect(resolve({ overrides: 'nonsense' }).active.length).toBeGreaterThan(0);
    expect(resolve({ overrides: { enabled: ['not_a_capability'] } }).active).not.toContain('not_a_capability');
  });
});

describe('the plan always wins', () => {
  it('withholds a preset capability the plan does not include', () => {
    const result = resolve({ businessType: 'GROCERY', planFeatures: FREE });
    expect(result.active).not.toContain('loyalty');
    expect(result.blockedByPlan).toContain('loyalty');
  });

  it('cannot be talked round by an override', () => {
    // The revenue-critical case: enabling it yourself must not grant it.
    const result = resolve({ planFeatures: FREE, overrides: { enabled: ['multi_branch', 'loyalty'] } });
    expect(result.active).not.toContain('multi_branch');
    expect(result.active).not.toContain('loyalty');
    expect(result.blockedByPlan).toEqual(expect.arrayContaining(['loyalty', 'multi_branch']));
  });

  it('reports what is missing so the shop can be told, not just shown less', () => {
    const result = resolve({ businessType: 'PHARMACY', planFeatures: FREE });
    expect(result.blockedByPlan).toContain('inventory');
    expect(result.blockedByPlan.length).toBeGreaterThan(0);
  });
});

describe('dependencies', () => {
  it('drops loyalty when the customer list it needs is gone', () => {
    const result = resolve({ businessType: 'CLOTHING', overrides: { disabled: ['customers'] } });
    expect(result.active).not.toContain('customers');
    expect(result.active).not.toContain('loyalty');
  });

  it('collapses a chain — no tables means no kitchen tickets', () => {
    const result = resolve({
      businessType: 'GENERAL_RETAIL',
      overrides: { enabled: ['restaurant.kitchen'] }, // asked for, but tables is off
    });
    expect(result.active).not.toContain('restaurant.tables');
    expect(result.active).not.toContain('restaurant.kitchen');
  });

  it('keeps the chain when the root survives', () => {
    const result = resolve({
      businessType: 'GENERAL_RETAIL',
      overrides: { enabled: ['restaurant.tables', 'restaurant.kitchen'] },
    });
    expect(result.active).toContain('restaurant.tables');
    expect(result.active).toContain('restaurant.kitchen');
  });

  it('keeps a preset chain — a pharmacy needs stock tracking under its batches', () => {
    expect(resolve({ businessType: 'PHARMACY' }).active).toEqual(
      expect.arrayContaining(['inventory', 'stock.batches', 'purchase_orders']),
    );
  });
});

describe('layout', () => {
  it('comes from the preset by default', () => {
    expect(resolve({ businessType: 'GROCERY' }).layout.scanFirst).toBe(true);
    expect(resolve({ businessType: 'GENERAL_RETAIL' }).layout.scanFirst).toBe(false);
    expect(resolve({ businessType: 'BAKERY' }).layout.tileSize).toBe('lg');
  });

  it('keeps an unshipped preset on the grid rather than an empty shell', () => {
    // Restaurant and salon become tableMap and appointmentBook the day their
    // modules land. Until then they must not promise a screen that is not
    // there — a shell with nothing behind it is worse than no vertical.
    expect(resolve({ businessType: 'RESTAURANT' }).layout.shell).toBe('grid');
    expect(resolve({ businessType: 'SALON' }).layout.shell).toBe('grid');
  });

  it('is overridden field by field, so one preference does not wipe the rest', () => {
    const result = resolve({ businessType: 'GROCERY', layout: { tileSize: 'lg' } });
    expect(result.layout.tileSize).toBe('lg');
    expect(result.layout.scanFirst).toBe(true); // still the grocery default
  });

  it('falls back cleanly when the column holds nothing useful', () => {
    expect(resolve({ layout: null }).layout.shell).toBe('grid');
    expect(resolve({ layout: 'nonsense' }).layout.quickCash.length).toBeGreaterThan(0);
  });
});

describe('every business type resolves', () => {
  it('produces a usable till for all thirteen presets', () => {
    const types = [
      'GENERAL_RETAIL', 'RESTAURANT', 'SALON', 'GROCERY', 'PHARMACY', 'CLOTHING',
      'ELECTRONICS', 'HARDWARE', 'MOBILE', 'BAKERY', 'BOOKSHOP', 'SERVICE', 'OTHER',
    ] as const;

    for (const businessType of types) {
      const result = resolve({ businessType });
      expect(result.active).toContain('sell');
      expect(result.active).toContain('products');
      expect(result.layout.quickCash.length).toBeGreaterThan(0);
    }
  });
});
