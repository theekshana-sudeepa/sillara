import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { AppError } from '../lib/errors.js';

/**
 * ---------------------------------------------------------------------------
 * SHELFIE — photograph your shop, get your catalog.
 * ---------------------------------------------------------------------------
 * The #1 activation killer for any POS is typing in hundreds of products.
 * Shelfie reads photos of shelves, printed price lists, handwritten price
 * books, or supplier invoices — in any language, including Sinhala and Tamil —
 * and returns draft products the owner reviews before inserting.
 *
 * Design decisions:
 *   • Claude Opus 5 with vision + structured outputs — the JSON schema
 *     guarantees parseable results; no regex scraping of prose.
 *   • effort "medium": extraction is not deep reasoning; medium keeps the
 *     round-trip fast and cheap without hurting read accuracy.
 *   • Drafts, never direct inserts — the model proposes, the human disposes.
 *     Every extracted row goes through the review screen with a confidence
 *     flag so low-confidence reads are visually distinct.
 *   • stop_reason "refusal" is handled — a shelf photo will never trip it in
 *     practice, but unguarded content[0] access is how production breaks.
 */

export interface ShelfieImage {
  data: string; // base64, no data: prefix
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
}

export interface DraftProduct {
  name: string;
  price: number | null;
  category: string | null;
  confidence: 'high' | 'medium' | 'low';
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    products: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Product name as sold, cleaned up (brand + item + size)' },
          price: {
            type: ['number', 'null'],
            description: 'Numeric selling price without currency symbols; null if not visible',
          },
          category: {
            type: ['string', 'null'],
            description: 'Short category guess like Drinks, Snacks, Dairy; null if unclear',
          },
          confidence: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
            description: 'How certain the reading of name AND price is',
          },
        },
        required: ['name', 'price', 'category', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['products'],
  additionalProperties: false,
} as const;

// --- Shelfie v2: supplier invoice → goods received --------------------------

export interface DraftInvoiceItem {
  name: string;
  quantity: number;
  unitCost: number | null;
  confidence: 'high' | 'medium' | 'low';
}

export interface InvoiceExtraction {
  supplier: string | null;
  items: DraftInvoiceItem[];
}

const INVOICE_SCHEMA = {
  type: 'object',
  properties: {
    supplier: { type: ['string', 'null'], description: 'Supplier / vendor name printed on the document; null if not visible' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Product name as written on the line (brand + item + size)' },
          quantity: { type: 'number', description: 'Units delivered on this line; 1 if not stated' },
          unitCost: {
            type: ['number', 'null'],
            description: 'Cost PER UNIT without currency symbols. If only a line total is shown, divide by quantity. Null if unreadable.',
          },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['name', 'quantity', 'unitCost', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['supplier', 'items'],
  additionalProperties: false,
} as const;

let client: Anthropic | null = null;

export const shelfieEnabled = (): boolean => Boolean(env.ANTHROPIC_API_KEY);

export async function extractProductsFromImages(
  images: ShelfieImage[],
  context: { currency: string; language: string },
): Promise<{ products: DraftProduct[]; model: string }> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new AppError(503, 'SHELFIE_DISABLED', 'Photo import is not configured on this server yet');
  }
  client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const imageBlocks = images.map((img) => ({
    type: 'image' as const,
    source: { type: 'base64' as const, media_type: img.mediaType, data: img.data },
  }));

  const prompt = [
    'These photos are from a retail shop: shelves, printed price lists, handwritten price books, or supplier invoices.',
    'They may be in any language, including Sinhala (සිංහල) and Tamil (தமிழ்) — read them natively and keep product names in the language shown.',
    `Extract every distinct sellable product you can identify. Prices are in ${context.currency}; strip currency symbols and thousands separators and return plain numbers.`,
    'Rules:',
    '- One entry per distinct product; merge duplicates across photos.',
    '- If a price is unreadable or absent, use null — never guess a number.',
    '- Clean up names (brand + item + size, e.g. "Anchor Milk Powder 400g") but do not invent details that are not visible.',
    '- Skip shelf labels that are not products (aisle signs, promo posters).',
    '- Mark confidence low when the text is blurry or partially hidden.',
  ].join('\n');

  const started = Date.now();

  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model: env.SHELFIE_MODEL,
      max_tokens: 16000,
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: OUTPUT_SCHEMA as unknown as Record<string, unknown> },
      },
      messages: [{ role: 'user', content: [...imageBlocks, { type: 'text', text: prompt }] }],
    } as Anthropic.MessageCreateParamsNonStreaming);
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      throw new AppError(429, 'SHELFIE_BUSY', 'Photo import is busy right now — try again in a minute');
    }
    if (err instanceof Anthropic.APIError) {
      logger.error({ status: err.status, message: err.message }, 'shelfie: Claude API error');
      throw new AppError(502, 'SHELFIE_FAILED', 'Could not read the photos — try clearer, closer shots');
    }
    throw err;
  }

  if (response.stop_reason === 'refusal') {
    throw new AppError(422, 'SHELFIE_REFUSED', 'These photos could not be processed. Use photos of products and price lists only.');
  }

  const text = response.content.find((b) => b.type === 'text')?.text ?? '{"products":[]}';

  let parsed: { products: DraftProduct[] };
  try {
    parsed = JSON.parse(text) as { products: DraftProduct[] };
  } catch {
    logger.error({ text: text.slice(0, 400) }, 'shelfie: unparseable model output');
    throw new AppError(502, 'SHELFIE_FAILED', 'Could not read the photos — try again');
  }

  // Post-validate: the schema guarantees shape, we enforce sanity.
  const products = (parsed.products ?? [])
    .filter((p) => typeof p.name === 'string' && p.name.trim().length > 0)
    .slice(0, 300)
    .map((p) => ({
      name: p.name.trim().slice(0, 180),
      price: typeof p.price === 'number' && p.price >= 0 && p.price < 100_000_000 ? Math.round(p.price * 100) / 100 : null,
      category: p.category?.trim().slice(0, 80) || null,
      confidence: (p.confidence === 'high' || p.confidence === 'low' ? p.confidence : 'medium') as DraftProduct['confidence'],
    }));

  logger.info(
    {
      images: images.length,
      products: products.length,
      ms: Date.now() - started,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
    '📸 shelfie extraction complete',
  );

  return { products, model: response.model };
}

/**
 * Shelfie v2 — read a supplier invoice / delivery note / GRN photo and return
 * line items ready for the receive-goods flow. Same guardrails as catalog
 * mode: drafts only, refusal handled, sanity-clamped output.
 */
export async function extractInvoiceItems(
  images: ShelfieImage[],
  context: { currency: string },
): Promise<{ extraction: InvoiceExtraction; model: string }> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new AppError(503, 'SHELFIE_DISABLED', 'Photo import is not configured on this server yet');
  }
  client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const imageBlocks = images.map((img) => ({
    type: 'image' as const,
    source: { type: 'base64' as const, media_type: img.mediaType, data: img.data },
  }));

  const prompt = [
    'These photos show a supplier invoice, delivery note, or goods-received note for a retail shop.',
    'They may be printed or handwritten, in any language including Sinhala (සිංහල) and Tamil (தமிழ்).',
    `Extract the supplier name and every product line. Costs are in ${context.currency}; return plain numbers without symbols or thousands separators.`,
    'Rules:',
    '- quantity = units delivered on that line; use 1 if no quantity column exists.',
    '- unitCost = cost per single unit. If only a line total is printed, divide it by the quantity. Null if unreadable — never guess.',
    '- Skip non-product lines: subtotals, VAT/tax rows, delivery charges, totals, discounts.',
    '- Clean product names (brand + item + size) but do not invent details.',
    '- Mark confidence low when text is blurry, crossed out, or partially hidden.',
  ].join('\n');

  const started = Date.now();

  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model: env.SHELFIE_MODEL,
      max_tokens: 16000,
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: INVOICE_SCHEMA as unknown as Record<string, unknown> },
      },
      messages: [{ role: 'user', content: [...imageBlocks, { type: 'text', text: prompt }] }],
    } as Anthropic.MessageCreateParamsNonStreaming);
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      throw new AppError(429, 'SHELFIE_BUSY', 'Photo import is busy right now — try again in a minute');
    }
    if (err instanceof Anthropic.APIError) {
      logger.error({ status: err.status, message: err.message }, 'shelfie invoice: Claude API error');
      throw new AppError(502, 'SHELFIE_FAILED', 'Could not read the invoice — try a clearer, flatter shot');
    }
    throw err;
  }

  if (response.stop_reason === 'refusal') {
    throw new AppError(422, 'SHELFIE_REFUSED', 'This document could not be processed. Use supplier invoices or delivery notes only.');
  }

  const text = response.content.find((b) => b.type === 'text')?.text ?? '{"supplier":null,"items":[]}';

  let parsed: InvoiceExtraction;
  try {
    parsed = JSON.parse(text) as InvoiceExtraction;
  } catch {
    logger.error({ text: text.slice(0, 400) }, 'shelfie invoice: unparseable model output');
    throw new AppError(502, 'SHELFIE_FAILED', 'Could not read the invoice — try again');
  }

  const items = (parsed.items ?? [])
    .filter((i) => typeof i.name === 'string' && i.name.trim().length > 0)
    .slice(0, 200)
    .map((i) => ({
      name: i.name.trim().slice(0, 180),
      quantity: typeof i.quantity === 'number' && i.quantity > 0 && i.quantity < 1_000_000 ? Math.round(i.quantity * 1000) / 1000 : 1,
      unitCost:
        typeof i.unitCost === 'number' && i.unitCost >= 0 && i.unitCost < 100_000_000
          ? Math.round(i.unitCost * 100) / 100
          : null,
      confidence: i.confidence === 'high' || i.confidence === 'low' ? i.confidence : 'medium' as const,
    }));

  logger.info(
    { images: images.length, items: items.length, supplier: parsed.supplier ?? null, ms: Date.now() - started },
    '📥 shelfie invoice extraction complete',
  );

  return {
    extraction: { supplier: parsed.supplier?.trim().slice(0, 120) || null, items },
    model: response.model,
  };
}
