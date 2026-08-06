/**
 * ---------------------------------------------------------------------------
 * WHAT A SHOP CAN DO
 * ---------------------------------------------------------------------------
 * One vocabulary for the whole platform. Every conditional in the API and the
 * till asks "does this shop have capability X?" — never "is this shop a
 * pharmacy?".
 *
 * That single rule is what stops vertical support becoming a maintenance
 * nightmare. Business type picks a set of capabilities once, at provisioning;
 * after that it is a label. A café that wants tables, or a hardware shop that
 * wants batch tracking, just enables the capability — no code changes, no new
 * branch, no vertical name anywhere near the logic.
 *
 * Capability ids that already exist as plan features keep their exact names,
 * so `plans.features` remains the entitlement source of truth rather than
 * growing a rival one alongside it.
 * ---------------------------------------------------------------------------
 */

export const CAPABILITY_IDS = [
  // --- always on -----------------------------------------------------------
  'sell',
  'products',
  'daily_report',

  // --- established features, gated by plan ---------------------------------
  'inventory',
  'customers',
  'whatsapp_receipts',
  'shifts',
  'loyalty',
  'multi_branch',
  'purchase_orders',

  // --- vertical modules ----------------------------------------------------
  /// Batch numbers and expiry dates, with first-expiry-first-out picking.
  /// Pharmacy, grocery, bakery.
  'stock.batches',
  /// Size/colour style variants grouped under one parent product.
  /// Clothing, electronics, mobile, bookshop.
  'stock.variants',
  /// Serial numbers and IMEI captured at the point of sale.
  /// Electronics, mobile, hardware.
  'stock.serials',
  /// Weighed goods — price by weight from a connected scale.
  /// Grocery, bakery.
  'sell.scale',
  /// Tables, dine-in vs takeaway, open tabs.
  'restaurant.tables',
  /// Kitchen tickets and course firing.
  'restaurant.kitchen',
  /// Appointment book with per-staff availability.
  'salon.appointments',
  /// Per-staff commission on services and sales.
  'staff.commission',
] as const;

export type CapabilityId = (typeof CAPABILITY_IDS)[number];

export interface CapabilityDef {
  id: CapabilityId;
  /** Owner-facing name, as it appears in settings. */
  label: string;
  description: string;
  /**
   * Always on, cannot be switched off by anyone. These are the things that
   * make the product a POS at all.
   */
  core?: boolean;
  /**
   * The `plans.features` entry that must be present for this to be available.
   * Absent means every plan gets it.
   *
   * This is the monetisation seam: putting a vertical module behind a new plan
   * feature is a one-line change here plus a row in the seed.
   */
  planFeature?: string;
  /** Capabilities that must also be on for this one to make sense. */
  requires?: CapabilityId[];
}

export const CAPABILITIES: Record<CapabilityId, CapabilityDef> = {
  sell: { id: 'sell', label: 'Sell screen', description: 'Take payments at the till', core: true },
  products: { id: 'products', label: 'Products', description: 'Your catalogue', core: true },
  daily_report: { id: 'daily_report', label: 'Daily report', description: "The day's takings", core: true },

  inventory: {
    id: 'inventory',
    label: 'Stock tracking',
    description: 'Track quantities, low-stock alerts, stocktakes',
    planFeature: 'inventory',
  },
  customers: {
    id: 'customers',
    label: 'Customers',
    description: 'Customer list, purchase history, account tabs',
    planFeature: 'customers',
  },
  whatsapp_receipts: {
    id: 'whatsapp_receipts',
    label: 'WhatsApp receipts',
    description: 'Share a receipt link with one tap',
    planFeature: 'whatsapp_receipts',
  },
  shifts: {
    id: 'shifts',
    label: 'Cash drawer shifts',
    description: 'Open with a float, close by counting',
    planFeature: 'shifts',
  },
  loyalty: {
    id: 'loyalty',
    label: 'Loyalty points',
    description: 'Earn on spend, redeem at the till',
    planFeature: 'loyalty',
    requires: ['customers'],
  },
  multi_branch: {
    id: 'multi_branch',
    label: 'Multiple locations',
    description: 'Per-branch stock, transfers, consolidated reporting',
    planFeature: 'multi_branch',
  },
  purchase_orders: {
    id: 'purchase_orders',
    label: 'Purchase orders',
    description: 'Order from suppliers, receive against the order',
    planFeature: 'purchase_orders',
    requires: ['inventory'],
  },

  'stock.batches': {
    id: 'stock.batches',
    label: 'Batches & expiry',
    description: 'Batch numbers, expiry dates, sell-oldest-first',
    planFeature: 'inventory',
    requires: ['inventory'],
  },
  'stock.variants': {
    id: 'stock.variants',
    label: 'Size & colour variants',
    description: 'One product, many variants — each with its own barcode and stock',
  },
  // NOT offered by any preset until the module exists — switching it on today
  // would light up a capability with nothing behind it, which is the same
  // mistake as listing Restaurant before tables shipped.
  'stock.serials': {
    id: 'stock.serials',
    label: 'Serial numbers & IMEI',
    description: 'Capture a serial at the till, look it up for warranty',
    planFeature: 'inventory',
    requires: ['inventory'],
  },
  'sell.scale': {
    id: 'sell.scale',
    label: 'Weighed goods',
    description: 'Price by weight',
    requires: ['inventory'],
  },
  'restaurant.tables': {
    id: 'restaurant.tables',
    label: 'Tables & tabs',
    description: 'Dine-in, takeaway, open tabs held across a service',
  },
  'restaurant.kitchen': {
    id: 'restaurant.kitchen',
    label: 'Kitchen tickets',
    description: 'Send orders to the kitchen, fire by course',
    requires: ['restaurant.tables'],
  },
  'salon.appointments': {
    id: 'salon.appointments',
    label: 'Appointments',
    description: 'Book clients against staff availability',
    requires: ['customers'],
  },
  'staff.commission': {
    id: 'staff.commission',
    label: 'Staff commission',
    description: 'Commission per staff member on what they sell',
  },
};

export const CORE_CAPABILITIES: CapabilityId[] = CAPABILITY_IDS.filter((id) => CAPABILITIES[id].core);

export function isCapabilityId(value: string): value is CapabilityId {
  return Object.hasOwn(CAPABILITIES, value);
}
