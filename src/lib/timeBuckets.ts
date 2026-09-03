/**
 * Auto-grain time bucketing, shared by every timeline chart in the dashboard.
 *
 * Extracted out of `computeRevenueTimeline` rather than left there: a second
 * caller (decision-volume-over-time, on Transactions) needed the identical
 * "day bucket, unless the data spans under 36 hours, then hour bucket" rule,
 * and copying that threshold a second place is exactly the kind of drift this
 * project keeps finding and fixing in other shapes — two implementations of
 * one rule that quietly stop agreeing. One function, two callers.
 */

export interface TimeBucket {
  at: number;
  label: string;
}

/**
 * Builds a CONTINUOUS run of empty buckets spanning the given timestamps —
 * every bucket between the earliest and latest point exists, even ones with
 * no events, so a chart reads a quiet hour as flat rather than compressing it
 * away and implying continuity that wasn't there.
 *
 * Grain is chosen from the data, not hardcoded: a demo dataset generated in
 * one sitting spans minutes to a few hours, and a day-bucketed chart over
 * that draws one bar. A merchant with months of history gets daily buckets, or
 * the axis would carry thousands of hourly labels.
 */
export function buildTimeBuckets(timestamps: string[]): TimeBucket[] {
  if (timestamps.length === 0) return [];
  const times = timestamps.map((t) => new Date(t).getTime());
  const min = Math.min(...times);
  const max = Math.max(...times);
  const spanMs = Math.max(max - min, 1);
  const byHour = spanMs < 36 * 60 * 60 * 1000;
  const bucketMs = byHour ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;

  const firstBucket = Math.floor(min / bucketMs) * bucketMs;
  const lastBucket = Math.floor(max / bucketMs) * bucketMs;
  const buckets: TimeBucket[] = [];
  for (let t = firstBucket; t <= lastBucket; t += bucketMs) {
    buckets.push({
      at: t,
      label: byHour
        ? new Date(t).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })
        : new Date(t).toLocaleDateString("en-IN", { month: "short", day: "numeric" }),
    });
  }
  return buckets;
}

/** Which bucket (by its `at`) a given timestamp falls into, using the same
 *  grain {@link buildTimeBuckets} chose — derived from the two adjacent
 *  buckets rather than re-deciding the grain, so the two can never disagree
 *  about where the boundary is. */
export function bucketKeyFor(iso: string, buckets: TimeBucket[]): number | null {
  if (buckets.length === 0) return null;
  const bucketMs = buckets.length > 1 ? buckets[1].at - buckets[0].at : 24 * 60 * 60 * 1000;
  const key = Math.floor(new Date(iso).getTime() / bucketMs) * bucketMs;
  return buckets.some((b) => b.at === key) ? key : null;
}
