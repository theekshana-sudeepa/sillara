import { describe, it, expect } from 'vitest';
import { buildCombinations, validateOptions, attributeKey, assertSellable } from './variants.js';

const SIZE = { name: 'Size', values: ['S', 'M', 'L'] };
const COLOUR = { name: 'Colour', values: ['Red', 'Blue'] };

describe('buildCombinations', () => {
  it('makes one child per combination', () => {
    const rows = buildCombinations('T-Shirt', [SIZE, COLOUR]);
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((r) => r.key)).size).toBe(6);
  });

  it('keeps the option order the owner typed, not alphabetical', () => {
    // A picker listing L, M, S reads as a bug. S, M, L reads as a size chart.
    const rows = buildCombinations('T-Shirt', [SIZE]);
    expect(rows.map((r) => r.attributes.Size)).toEqual(['S', 'M', 'L']);
  });

  it('names a child the way a receipt should read it', () => {
    const rows = buildCombinations('T-Shirt', [SIZE, COLOUR]);
    expect(rows[0]!.name).toBe('T-Shirt · S / Red');
    expect(rows[5]!.name).toBe('T-Shirt · L / Blue');
  });

  it('handles a single option', () => {
    expect(buildCombinations('Mug', [{ name: 'Colour', values: ['White'] }])).toHaveLength(1);
  });

  it('handles three options', () => {
    const rows = buildCombinations('Shoe', [SIZE, COLOUR, { name: 'Fit', values: ['Wide', 'Narrow'] }]);
    expect(rows).toHaveLength(12);
    expect(rows[0]!.name).toBe('Shoe · S / Red / Wide');
  });
});

describe('attributeKey', () => {
  it('is stable however the attributes are ordered', () => {
    // Re-generating a parent must not create duplicate children just because
    // the object came back with its keys in a different order.
    expect(attributeKey({ Size: 'M', Colour: 'Red' })).toBe(attributeKey({ Colour: 'Red', Size: 'M' }));
  });

  it('separates genuinely different combinations', () => {
    expect(attributeKey({ Size: 'M' })).not.toBe(attributeKey({ Size: 'L' }));
  });
});

describe('validateOptions', () => {
  it('refuses an empty option set', () => {
    expect(() => validateOptions([])).toThrow(/at least one option/i);
  });

  it('refuses an option with no values', () => {
    expect(() => validateOptions([{ name: 'Size', values: [] }])).toThrow(/at least one value/i);
    expect(() => validateOptions([{ name: 'Size', values: ['  '] }])).toThrow(/at least one value/i);
  });

  it('refuses a duplicated option name, however it is cased', () => {
    expect(() => validateOptions([SIZE, { name: 'size', values: ['XL'] }])).toThrow(/twice/i);
  });

  it('collapses duplicate values instead of making identical children', () => {
    const [option] = validateOptions([{ name: 'Size', values: ['M', 'M', 'L'] }]);
    expect(option!.values).toEqual(['M', 'L']);
  });

  it('refuses a combinatorial explosion', () => {
    // 6 × 8 × 5 is 240 rows from one screen — always a mistake, always painful
    // to undo by hand.
    const huge = [
      { name: 'Size', values: ['XS', 'S', 'M', 'L', 'XL', 'XXL'] },
      { name: 'Colour', values: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] },
      { name: 'Fit', values: ['1', '2', '3', '4', '5'] },
    ];
    expect(() => validateOptions(huge)).toThrow(/240 variants/);
  });

  it('trims names and values', () => {
    const [option] = validateOptions([{ name: '  Size  ', values: ['  M  '] }]);
    expect(option!.name).toBe('Size');
    expect(option!.values).toEqual(['M']);
  });
});

describe('assertSellable', () => {
  it('refuses to sell a parent — it is a folder, not a thing on the shelf', () => {
    expect(() => assertSellable({ id: 'p1', name: 'T-Shirt', variantOptions: [SIZE] })).toThrow(/pick the size/i);
  });

  it('allows a child and an ordinary product through', () => {
    expect(() => assertSellable({ id: 'c1', name: 'T-Shirt · M', variantOptions: null })).not.toThrow();
    expect(() => assertSellable({ id: 'x1', name: 'Biscuits', variantOptions: null })).not.toThrow();
  });
});
