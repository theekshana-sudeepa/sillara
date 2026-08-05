import { api } from './api';
import { bumpAttempts, pendingSales, purgeSales, kvSet } from './db';

/**
 * Outbox flush. Called: on reconnect, after every sale, and every 30s while
 * pending rows exist. Server-side UUID dedupe makes over-flushing free —
 * the worst case is a no-op response listing already-synced UUIDs.
 */
let flushing = false;
const listeners = new Set<(pending: number) => void>();

export function onPendingChange(fn: (pending: number) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function notify(): Promise<void> {
  const pending = (await pendingSales()).length;
  for (const fn of listeners) fn(pending);
}

export async function flushOutbox(): Promise<{ synced: number; failed: number }> {
  if (flushing || !navigator.onLine) return { synced: 0, failed: 0 };
  flushing = true;
  try {
    const pending = await pendingSales();
    if (pending.length === 0) return { synced: 0, failed: 0 };

    const batch = pending.slice(0, 100).map((s) => ({
      clientUuid: s.clientUuid,
      publicId: s.publicId,
      registerId: s.registerId,
      branchId: s.branchId,
      shiftId: s.shiftId,
      customerId: s.customerId,
      redeemPoints: s.redeemPoints,
      items: s.items,
      discount: s.discount,
      tender: s.tender,
      tendered: s.tendered,
      note: s.note,
      soldAt: s.soldAt,
    }));

    const result = await api.post<{ purgeable: string[]; results: Array<{ clientUuid: string; status: string }> }>(
      '/sales/sync',
      { sales: batch },
    );

    await purgeSales(result.purgeable);
    const failed = result.results.filter((r) => r.status === 'failed').map((r) => r.clientUuid);
    if (failed.length > 0) await bumpAttempts(failed);

    await kvSet('lastSyncAt', new Date().toISOString());
    await notify();
    return { synced: result.purgeable.length, failed: failed.length };
  } catch {
    // Offline or server unreachable — the outbox simply waits.
    return { synced: 0, failed: 0 };
  } finally {
    flushing = false;
  }
}

export function startSyncLoop(): () => void {
  const onOnline = () => void flushOutbox();
  window.addEventListener('online', onOnline);
  const interval = setInterval(() => void flushOutbox(), 30_000);
  void flushOutbox();
  void notify();
  return () => {
    window.removeEventListener('online', onOnline);
    clearInterval(interval);
  };
}

export { notify as notifyPendingChange };
