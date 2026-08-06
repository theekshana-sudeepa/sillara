import type { BusinessType } from '@prisma/client';
import { CAPABILITIES, CORE_CAPABILITIES, isCapabilityId, type CapabilityId } from './registry.js';
import { templateFor, type LayoutConfig } from './templates.js';

/**
 * ---------------------------------------------------------------------------
 * WHAT THIS SHOP CAN ACTUALLY DO, RIGHT NOW
 * ---------------------------------------------------------------------------
 * Four inputs, one answer:
 *
 *   core            always on — the things that make it a POS
 *   template        the preset for this business type
 *   owner overrides what they switched on or off themselves
 *   plan            what they are paying for, which always wins
 *
 * Order matters. The plan is applied last and can only ever take away, so no
 * combination of preset and preference can hand a FREE shop a PRO feature.
 *
 * Overrides are stored separately from the preset on purpose. Keeping "the
 * template chose this" apart from "the owner chose this" is what lets someone
 * change business type later without silently undoing their own settings.
 *
 * Pure — no Prisma, no Express, no clock. Same shape as `decideLifecycle`,
 * `computeLoyalty` and `computeTotals`, and tested the same way.
 * ---------------------------------------------------------------------------
 */

export interface CapabilityOverrides {
  enabled?: string[];
  disabled?: string[];
}

export interface ResolveInput {
  businessType: BusinessType;
  /** `Organization.capabilities` — free-form JSON off the row. */
  overrides?: unknown;
  /** `plans.features` — the entitlement list. */
  planFeatures: string[];
  /** `Organization.layout` — free-form JSON off the row. */
  layout?: unknown;
}

export interface ResolvedCapabilities {
  /** Everything switched on and paid for, sorted for a stable response. */
  active: CapabilityId[];
  /**
   * Switched on by the preset or the owner, but not on their plan. This is
   * what the upgrade prompt is built from — a shop should be told what it is
   * missing, not silently shown less.
   */
  blockedByPlan: CapabilityId[];
  layout: LayoutConfig;
}

/** Tolerant of whatever is in the JSON column, including nothing. */
function parseOverrides(raw: unknown): { enabled: CapabilityId[]; disabled: CapabilityId[] } {
  const value = (raw ?? {}) as CapabilityOverrides;
  const clean = (list: unknown): CapabilityId[] =>
    Array.isArray(list) ? list.filter((v): v is CapabilityId => typeof v === 'string' && isCapabilityId(v)) : [];
  return { enabled: clean(value.enabled), disabled: clean(value.disabled) };
}

function parseLayout(raw: unknown, fallback: LayoutConfig): LayoutConfig {
  if (!raw || typeof raw !== 'object') return fallback;
  const value = raw as Partial<LayoutConfig>;
  return {
    shell: value.shell ?? fallback.shell,
    scanFirst: typeof value.scanFirst === 'boolean' ? value.scanFirst : fallback.scanFirst,
    tileSize: value.tileSize ?? fallback.tileSize,
    quickCash: Array.isArray(value.quickCash) && value.quickCash.length > 0 ? value.quickCash : fallback.quickCash,
  };
}

export function resolveCapabilities(input: ResolveInput): ResolvedCapabilities {
  const template = templateFor(input.businessType);
  const { enabled, disabled } = parseOverrides(input.overrides);

  // preset ∪ owner-enabled, then owner-disabled removed.
  const wanted = new Set<CapabilityId>([...template.capabilities, ...enabled]);
  for (const id of disabled) wanted.delete(id);

  // Core is not negotiable — a till that cannot sell is not a preference.
  for (const id of CORE_CAPABILITIES) wanted.add(id);

  // Entitlement last, and it only subtracts.
  const plan = new Set(input.planFeatures);
  const active: CapabilityId[] = [];
  const blockedByPlan: CapabilityId[] = [];

  for (const id of wanted) {
    const def = CAPABILITIES[id];
    if (def.planFeature && !plan.has(def.planFeature)) {
      blockedByPlan.push(id);
      continue;
    }
    active.push(id);
  }

  // A capability whose dependency did not survive is dropped too: loyalty with
  // no customer list is a screen that cannot work. Repeated until stable so a
  // chain (kitchen → tables) collapses in one pass of the caller's mind.
  const activeSet = new Set(active);
  let settled = false;
  while (!settled) {
    settled = true;
    for (const id of [...activeSet]) {
      const requires = CAPABILITIES[id].requires ?? [];
      if (requires.some((dep) => !activeSet.has(dep))) {
        activeSet.delete(id);
        settled = false;
      }
    }
  }

  return {
    active: [...activeSet].sort(),
    blockedByPlan: blockedByPlan.sort(),
    layout: parseLayout(input.layout, template.layout),
  };
}
