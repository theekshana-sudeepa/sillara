import { Suspense, lazy, type ComponentType, type ReactNode } from 'react';
import { useCapability } from '@/state/store';
import type { CapabilityId } from '@/lib/capabilities';

/**
 * ---------------------------------------------------------------------------
 * MOUNTING A VERTICAL MODULE
 * ---------------------------------------------------------------------------
 * Two rules keep thirteen business types from becoming thirteen front ends:
 *
 *   1. Nothing renders because of what kind of shop this is — only because of
 *      what it can do.
 *   2. A module a shop cannot use is never downloaded. A salon should not pay
 *      for the kitchen-ticket bundle over a phone connection, and a village
 *      grocery should not wait on JavaScript for a table map it will never
 *      open.
 * ---------------------------------------------------------------------------
 */

/** Render children only when the capability is on. */
export function Capable({
  need,
  fallback = null,
  children,
}: {
  need: CapabilityId;
  fallback?: ReactNode;
  children: ReactNode;
}) {
  const can = useCapability();
  return <>{can(need) ? children : fallback}</>;
}

/**
 * A route-level module, code-split and loaded on demand.
 *
 * The import lives inside a thunk so the bundler emits a separate chunk that
 * only a shop with the capability ever fetches.
 */
export function lazyModule(
  need: CapabilityId,
  loader: () => Promise<{ default: ComponentType }>,
): ComponentType {
  const Loaded = lazy(loader);

  return function CapabilityRoute() {
    const can = useCapability();
    if (!can(need)) return <ModuleUnavailable />;
    return (
      <Suspense fallback={<ModuleLoading />}>
        <Loaded />
      </Suspense>
    );
  };
}

function ModuleLoading() {
  return (
    <div className="grid min-h-[40vh] place-items-center">
      <span
        className="size-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent"
        aria-label="Loading"
      />
    </div>
  );
}

/**
 * Reached by deep link or a stale bookmark after a capability was switched
 * off. Says what happened rather than showing an empty screen.
 */
function ModuleUnavailable() {
  return (
    <div className="grid min-h-[40vh] place-items-center p-6 text-center">
      <div>
        <p className="text-[15px] font-bold">Not switched on</p>
        <p className="mt-1 text-[13.5px] text-muted-foreground">
          This feature is off for your shop. An owner can turn it on in Settings.
        </p>
      </div>
    </div>
  );
}
