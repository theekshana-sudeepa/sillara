/**
 * ---------------------------------------------------------------------------
 * WHAT THIS TILL CAN DO
 * ---------------------------------------------------------------------------
 * The server resolves capabilities — preset, owner overrides, and plan — and
 * sends the answer. The client never re-derives them, and never looks at the
 * business type to decide what to render.
 *
 *   if (can('stock.batches'))            ✅
 *   if (org.businessType === 'PHARMACY') ❌ never
 *
 * That rule is the whole reason vertical support does not turn into thirteen
 * divergent front ends. A café that wants tables switches the capability on;
 * no branch anywhere in this codebase learns a new special case.
 *
 * Cached with the org so the till boots offline knowing its own shape.
 * ---------------------------------------------------------------------------
 */

export type CapabilityId =
  | 'sell'
  | 'products'
  | 'daily_report'
  | 'inventory'
  | 'customers'
  | 'whatsapp_receipts'
  | 'shifts'
  | 'loyalty'
  | 'multi_branch'
  | 'purchase_orders'
  | 'stock.batches'
  | 'stock.variants'
  | 'stock.serials'
  | 'sell.scale'
  | 'restaurant.tables'
  | 'restaurant.kitchen'
  | 'salon.appointments'
  | 'staff.commission';

export type SellShell = 'grid' | 'tableMap' | 'appointmentBook';

export interface LayoutConfig {
  shell: SellShell;
  scanFirst: boolean;
  tileSize: 'sm' | 'md' | 'lg';
  quickCash: number[];
}

export interface CapabilityState {
  active: CapabilityId[];
  /** On for this shop's preset, but not on its plan — the upgrade prompt. */
  blockedByPlan: CapabilityId[];
  layout: LayoutConfig;
}

/**
 * What a till falls back to when it has never spoken to the server — a first
 * run with no network. Deliberately the plain retail shape: a shop that can
 * sell is better than a shop showing an error while we wait to be told which
 * kind it is.
 */
export const DEFAULT_CAPABILITIES: CapabilityState = {
  active: ['sell', 'products', 'daily_report', 'inventory', 'customers', 'whatsapp_receipts', 'shifts'],
  blockedByPlan: [],
  layout: { shell: 'grid', scanFirst: false, tileSize: 'md', quickCash: [100, 500, 1000, 5000] },
};

export function hasCapability(state: CapabilityState | null, id: CapabilityId): boolean {
  return (state ?? DEFAULT_CAPABILITIES).active.includes(id);
}
