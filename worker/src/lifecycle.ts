import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The small, testable parts of the worker's lifecycle: stopping without hanging
 * on a sleep, backing off a merchant that keeps failing, and saying it is alive.
 */

/** A stop request that wakes any sleeper at once. */
export function createStopSignal() {
  let stopping = false;
  const wakers = new Set<() => void>();
  return {
    get stopping() {
      return stopping;
    },
    stop() {
      stopping = true;
      for (const wake of wakers) wake();
      wakers.clear();
    },
    /** Resolves after `ms`, or immediately if a stop is requested (or already was). */
    sleep(ms: number): Promise<void> {
      if (stopping) return Promise.resolve();
      return new Promise((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          wakers.delete(wake);
          resolve();
        }, ms);
        wakers.add(wake);
      });
    },
  };
}

const MAX_BACKOFF_MS = 15 * 60_000;

/** How long to leave a merchant alone after `failures` passes in a row failed: none, then one pass, doubling, capped. */
export function backoffMs(failures: number, passMs: number): number {
  if (failures <= 0) return 0;
  return Math.min(passMs * 2 ** (failures - 1), MAX_BACKOFF_MS);
}

/** The worker's pulse: one row, updated in place. The dashboard reads it to say whether the worker is running. */
export async function reportAlive(db: SupabaseClient, info: Record<string, unknown> = {}): Promise<void> {
  const { error } = await db.from("worker_status").upsert({ id: "main", beat_at: new Date().toISOString(), info }, { onConflict: "id" });
  if (error) console.warn("[worker] could not report that it is alive:", error.message);
}
