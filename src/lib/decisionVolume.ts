import type { Trace, Decision } from "@/types/db";
import { buildTimeBuckets, bucketKeyFor } from "./timeBuckets";

export interface DecisionVolumePoint {
  at: number;
  label: string;
  allow: number;
  escalate: number;
  block: number;
  protocol_reject: number;
}

/**
 * How many actions of each decision happened per bucket — the pairing this
 * project's original design brief for the dashboard asked for and never
 * built: a high-density grid (Transactions, already there) alongside a
 * time-series view of the same rows, not a different dataset.
 *
 * Deliberately counts EVERY trace the caller passes in, not just
 * `mode === "enforce"` ones. `computeRevenueTimeline` filters to enforce
 * because it's counting settled money; this chart sits above the Transactions
 * grid, which shows every trace regardless of mode — a volume chart that
 * silently excluded simulate-mode rows the grid below it includes would be
 * describing a different dataset than the one right underneath it.
 */
export function computeDecisionVolumeTimeline(traces: Trace[]): DecisionVolumePoint[] {
  if (traces.length === 0) return [];
  const buckets = buildTimeBuckets(traces.map((t) => t.created_at));
  const points = new Map<number, DecisionVolumePoint>(
    buckets.map((b) => [b.at, { at: b.at, label: b.label, allow: 0, escalate: 0, block: 0, protocol_reject: 0 }])
  );

  for (const t of traces) {
    const key = bucketKeyFor(t.created_at, buckets);
    const point = key !== null ? points.get(key) : undefined;
    if (point) point[t.decision as Decision] += 1;
  }

  return [...points.values()].sort((a, b) => a.at - b.at);
}
