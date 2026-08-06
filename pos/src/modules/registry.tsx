import type { ComponentType } from 'react';
import { lazyModule } from '@/components/Capability';
import type { CapabilityId, IconishName } from './types';

/**
 * ---------------------------------------------------------------------------
 * THE MODULE REGISTRY
 * ---------------------------------------------------------------------------
 * Every vertical module is declared here and nowhere else. Adding one means
 * adding a row: a path, the capability it needs, and a dynamic import. The
 * router and the navigation both read from this list, so a module cannot be
 * half-wired — reachable but not visible, or listed but not routable.
 *
 * There are no entries yet on purpose. Week one builds the mechanism; the
 * modules land behind it in weeks three and four, and the two that are real
 * domain work — tables and appointments — are their own projects after that.
 *
 * To add one:
 *
 *   {
 *     path: 'batches',
 *     need: 'stock.batches',
 *     label: 'Batches',
 *     icon: 'box',
 *     load: () => import('@/modules/batches/BatchesPage'),
 *   }
 *
 * The import stays inside the thunk so the chunk is only fetched by shops that
 * have the capability.
 * ---------------------------------------------------------------------------
 */

export interface ModuleRoute {
  /** Relative to the app shell, e.g. "batches" → /batches */
  path: string;
  need: CapabilityId;
  /** Shown in navigation. Omit to route without a nav entry. */
  label?: string;
  icon?: IconishName;
  load: () => Promise<{ default: ComponentType }>;
}

export const MODULE_ROUTES: ModuleRoute[] = [];

/** Resolved once at module load — each entry becomes a capability-gated route. */
export const moduleElements: Array<{ path: string; Element: ComponentType }> = MODULE_ROUTES.map((m) => ({
  path: m.path,
  Element: lazyModule(m.need, m.load),
}));

/** Navigation entries for the modules this shop can actually reach. */
export function visibleModules(can: (id: CapabilityId) => boolean): ModuleRoute[] {
  return MODULE_ROUTES.filter((m) => m.label && can(m.need));
}
