import type { BusinessType } from '@prisma/client';
import type { CapabilityId } from './registry.js';

/**
 * ---------------------------------------------------------------------------
 * THE PRESETS
 * ---------------------------------------------------------------------------
 * This file, and the settings screen, are the ONLY places a vertical name is
 * allowed to appear. A template is data: which capabilities to switch on, what
 * shape the sell screen takes, and what the catalogue looks like on day one.
 * Nothing here is code, and nothing downstream asks what kind of shop it is.
 *
 * Sample prices are in whole US dollars and scaled to the shop's currency at
 * provisioning — an LKR shop gets LKR-shaped numbers, not $1 water.
 * ---------------------------------------------------------------------------
 */

export type SellShell = 'grid' | 'tableMap' | 'appointmentBook';

export interface LayoutConfig {
  /** Which sell screen to mount. */
  shell: SellShell;
  /**
   * Put the cursor in the barcode box on load. A supermarket wants this and a
   * café does not — it is the difference between scanning 300 items an hour
   * and hunting for a text field.
   */
  scanFirst: boolean;
  tileSize: 'sm' | 'md' | 'lg';
  /** Quick-cash keys, in the org's own currency. */
  quickCash: number[];
}

export interface SeedCategory {
  name: string;
  /** Sell-screen tile colour. */
  color: string;
  items: Array<{ name: string; price: number; unit?: string }>;
}

export interface BusinessTemplate {
  label: string;
  /**
   * `ready` appears in the picker. `comingSoon` does not.
   *
   * A vertical whose headline feature does not exist yet is worse than no
   * vertical: the shop arrives expecting a table map, finds a product grid,
   * and tells every other restaurateur it knows. Listing follows shipping.
   */
  status: 'ready' | 'comingSoon';
  /** Switched on at provisioning, on top of the core set. */
  capabilities: CapabilityId[];
  layout: LayoutConfig;
  /** Starter catalogue — the shop must look alive the second the owner walks in. */
  categories: SeedCategory[];
  /** What new products default to. A bakery weighs; a bookshop counts. */
  defaultUnit: string;
}

const DEFAULT_LAYOUT: LayoutConfig = {
  shell: 'grid',
  scanFirst: false,
  tileSize: 'md',
  quickCash: [100, 500, 1000, 5000],
};

/** Everything a shop gets unless its template says otherwise. */
const RETAIL_BASE: CapabilityId[] = ['inventory', 'customers', 'whatsapp_receipts', 'shifts'];

export const TEMPLATES: Record<BusinessType, BusinessTemplate> = {
  GENERAL_RETAIL: {
    label: 'General retail shop',
    status: 'ready',
    capabilities: RETAIL_BASE,
    layout: DEFAULT_LAYOUT,
    defaultUnit: 'pc',
    categories: [
      { name: 'Drinks', color: '#0EA5E9', items: [{ name: 'Water Bottle 500ml', price: 1 }, { name: 'Soft Drink', price: 1.5 }] },
      { name: 'Snacks', color: '#F59E0B', items: [{ name: 'Biscuits', price: 0.8 }, { name: 'Chips', price: 1.2 }] },
      { name: 'General', color: '#6366F1', items: [{ name: 'Sample Item — edit me', price: 5 }] },
    ],
  },

  GROCERY: {
    label: 'Grocery / Supermarket',
    status: 'ready',
    // High item count, low value per item: the barcode gun is the interface.
    capabilities: [...RETAIL_BASE, 'stock.batches', 'sell.scale', 'loyalty', 'purchase_orders'],
    layout: { ...DEFAULT_LAYOUT, scanFirst: true, tileSize: 'sm' },
    defaultUnit: 'pc',
    categories: [
      { name: 'Fresh Produce', color: '#22C55E', items: [{ name: 'Tomatoes', price: 2, unit: 'kg' }, { name: 'Onions', price: 1.5, unit: 'kg' }] },
      { name: 'Dairy & Eggs', color: '#38BDF8', items: [{ name: 'Milk 1L', price: 1.2 }, { name: 'Eggs (10)', price: 2 }] },
      { name: 'Rice & Grains', color: '#F59E0B', items: [{ name: 'Rice', price: 1.1, unit: 'kg' }] },
      { name: 'Household', color: '#A78BFA', items: [{ name: 'Soap Bar', price: 0.7 }] },
    ],
  },

  PHARMACY: {
    label: 'Pharmacy',
    status: 'ready',
    capabilities: [...RETAIL_BASE, 'stock.batches', 'purchase_orders'],
    layout: { ...DEFAULT_LAYOUT, scanFirst: true, tileSize: 'sm' },
    defaultUnit: 'pc',
    categories: [
      { name: 'Prescription', color: '#EF4444', items: [{ name: 'Prescription Item — edit me', price: 5 }] },
      { name: 'Over the Counter', color: '#0EA5E9', items: [{ name: 'Paracetamol 500mg', price: 1 }, { name: 'Antiseptic Cream', price: 3 }] },
      { name: 'Personal Care', color: '#A78BFA', items: [{ name: 'Toothpaste', price: 2 }] },
      { name: 'Baby Care', color: '#F472B6', items: [{ name: 'Baby Wipes', price: 3 }] },
    ],
  },

  BAKERY: {
    label: 'Bakery',
    status: 'ready',
    capabilities: [...RETAIL_BASE, 'stock.batches', 'sell.scale', 'loyalty'],
    layout: { ...DEFAULT_LAYOUT, tileSize: 'lg' },
    defaultUnit: 'pc',
    categories: [
      { name: 'Bread', color: '#D97706', items: [{ name: 'White Loaf', price: 1.5 }, { name: 'Bread Roll', price: 0.4 }] },
      { name: 'Cakes', color: '#F472B6', items: [{ name: 'Sponge Cake', price: 8, unit: 'kg' }] },
      { name: 'Savouries', color: '#F59E0B', items: [{ name: 'Meat Pastry', price: 1 }] },
    ],
  },

  CLOTHING: {
    label: 'Clothing store',
    status: 'ready',
    capabilities: [...RETAIL_BASE, 'stock.variants', 'loyalty'],
    layout: DEFAULT_LAYOUT,
    defaultUnit: 'pc',
    categories: [
      { name: 'Menswear', color: '#3B82F6', items: [{ name: 'T-Shirt', price: 12 }, { name: 'Trousers', price: 25 }] },
      { name: 'Womenswear', color: '#EC4899', items: [{ name: 'Blouse', price: 18 }] },
      { name: 'Kids', color: '#22C55E', items: [{ name: "Kids' T-Shirt", price: 8 }] },
      { name: 'Accessories', color: '#A78BFA', items: [{ name: 'Belt', price: 10 }] },
    ],
  },

  ELECTRONICS: {
    label: 'Electronics store',
    status: 'ready',
    capabilities: [...RETAIL_BASE, 'stock.variants', 'purchase_orders'],
    layout: { ...DEFAULT_LAYOUT, scanFirst: true },
    defaultUnit: 'pc',
    categories: [
      { name: 'Audio', color: '#8B5CF6', items: [{ name: 'Earphones', price: 15 }, { name: 'Bluetooth Speaker', price: 35 }] },
      { name: 'Cables & Chargers', color: '#0EA5E9', items: [{ name: 'USB-C Cable', price: 5 }, { name: 'Wall Charger', price: 12 }] },
      { name: 'Accessories', color: '#F59E0B', items: [{ name: 'Power Bank', price: 20 }] },
    ],
  },

  MOBILE: {
    label: 'Mobile shop',
    status: 'ready',
    capabilities: [...RETAIL_BASE, 'stock.variants'],
    layout: { ...DEFAULT_LAYOUT, scanFirst: true },
    defaultUnit: 'pc',
    categories: [
      { name: 'Handsets', color: '#3B82F6', items: [{ name: 'Smartphone — edit me', price: 150 }] },
      { name: 'Accessories', color: '#F59E0B', items: [{ name: 'Phone Case', price: 6 }, { name: 'Screen Protector', price: 4 }] },
      { name: 'Reload & Data', color: '#22C55E', items: [{ name: 'Airtime Top-up', price: 5 }] },
    ],
  },

  HARDWARE: {
    label: 'Hardware store',
    status: 'ready',
    capabilities: [...RETAIL_BASE, 'purchase_orders'],
    layout: { ...DEFAULT_LAYOUT, scanFirst: true, tileSize: 'sm' },
    defaultUnit: 'pc',
    categories: [
      { name: 'Tools', color: '#F59E0B', items: [{ name: 'Hammer', price: 8 }, { name: 'Screwdriver Set', price: 12 }] },
      { name: 'Fixings', color: '#6B7280', items: [{ name: 'Screws (100)', price: 3 }] },
      { name: 'Paint', color: '#22C55E', items: [{ name: 'Emulsion 1L', price: 9, unit: 'l' }] },
      { name: 'Electrical', color: '#EAB308', items: [{ name: 'LED Bulb', price: 3 }] },
    ],
  },

  BOOKSHOP: {
    label: 'Bookshop',
    status: 'ready',
    capabilities: [...RETAIL_BASE, 'stock.variants', 'purchase_orders'],
    layout: { ...DEFAULT_LAYOUT, scanFirst: true, tileSize: 'sm' },
    defaultUnit: 'pc',
    categories: [
      { name: 'Books', color: '#8B5CF6', items: [{ name: 'Paperback — edit me', price: 10 }] },
      { name: 'Stationery', color: '#0EA5E9', items: [{ name: 'Notebook', price: 2 }, { name: 'Pen', price: 0.5 }] },
      { name: 'School Supplies', color: '#22C55E', items: [{ name: 'Exercise Book', price: 1 }] },
    ],
  },

  SERVICE: {
    label: 'Service business',
    status: 'ready',
    // No shelves to count: stock tracking would be noise on every screen.
    capabilities: ['customers', 'shifts', 'whatsapp_receipts', 'staff.commission'],
    layout: { ...DEFAULT_LAYOUT, tileSize: 'lg' },
    defaultUnit: 'pc',
    categories: [
      { name: 'Services', color: '#6366F1', items: [{ name: 'Standard Service', price: 20 }, { name: 'Callout Fee', price: 10 }] },
      { name: 'Parts', color: '#F59E0B', items: [{ name: 'Replacement Part — edit me', price: 15 }] },
    ],
  },

  OTHER: {
    label: 'Something else',
    status: 'ready',
    capabilities: RETAIL_BASE,
    layout: DEFAULT_LAYOUT,
    defaultUnit: 'pc',
    categories: [{ name: 'General', color: '#6366F1', items: [{ name: 'Sample Item — edit me', price: 5 }] }],
  },

  // --- not offered yet -------------------------------------------------------
  // Both need real domain modules — tables, tabs and kitchen tickets for one,
  // a resource-scheduling book for the other. Each is a month of work, not a
  // switch. Until those ship these presets stay off the picker and open on the
  // ordinary product grid, because a restaurant that lands on a grid it did
  // not expect is a churned restaurant.

  RESTAURANT: {
    label: 'Restaurant / Cafe',
    status: 'comingSoon',
    capabilities: ['customers', 'shifts', 'whatsapp_receipts'],
    // Becomes `tableMap` the day restaurant.tables ships.
    layout: { ...DEFAULT_LAYOUT, tileSize: 'lg' },
    defaultUnit: 'pc',
    categories: [
      { name: 'Starters', color: '#F59E0B', items: [{ name: 'Soup of the Day', price: 4 }] },
      { name: 'Mains', color: '#EF4444', items: [{ name: 'House Special', price: 9 }] },
      { name: 'Drinks', color: '#0EA5E9', items: [{ name: 'Tea', price: 1 }, { name: 'Soft Drink', price: 1.5 }] },
      { name: 'Desserts', color: '#F472B6', items: [{ name: 'Ice Cream', price: 3 }] },
    ],
  },

  SALON: {
    label: 'Salon / Beauty centre',
    status: 'comingSoon',
    capabilities: ['customers', 'shifts', 'whatsapp_receipts', 'staff.commission', 'loyalty'],
    // Becomes `appointmentBook` the day salon.appointments ships.
    layout: { ...DEFAULT_LAYOUT, tileSize: 'lg' },
    defaultUnit: 'pc',
    categories: [
      { name: 'Hair', color: '#8B5CF6', items: [{ name: 'Haircut', price: 12 }, { name: 'Colour', price: 40 }] },
      { name: 'Beauty', color: '#EC4899', items: [{ name: 'Facial', price: 25 }] },
      { name: 'Nails', color: '#F472B6', items: [{ name: 'Manicure', price: 15 }] },
      { name: 'Products', color: '#F59E0B', items: [{ name: 'Shampoo', price: 8 }] },
    ],
  },
};

export const templateFor = (type: BusinessType): BusinessTemplate => TEMPLATES[type] ?? TEMPLATES.GENERAL_RETAIL;

/** The presets a new shop may actually choose from. */
export const offeredTemplates = (): Array<{ value: BusinessType; label: string }> =>
  (Object.entries(TEMPLATES) as Array<[BusinessType, BusinessTemplate]>)
    .filter(([, t]) => t.status === 'ready')
    .map(([value, t]) => ({ value, label: t.label }));
