import type { Escalation, Trace } from "@/types/db";

/**
 * Revenue impact, derived from decisions that actually happened.
 *
 * The point this measures: a control plane earns its place by *not
 * over-blocking*. A blunt rule refusing everything above a threshold is safe
 * and costs the merchant every rupee above it. Escalating instead means that
 * money is held for a human rather than destroyed, and whatever the human
 * approves still lands. `approvedThroughGate` is exactly that recovered
 * revenue — and it is a replay of real approvals, not a projection.
 *
 * Everything here is a sum over traces the dashboard already fetched. There is
 * deliberately no forecast, no "you could earn X more", and no modelled
 * counterfactual beyond what the recorded decisions literally say.
 */

export interface RevenueImpact {
  /** Executed with no rule stopping it — zero friction, no human involved. */
  clearedAutomatically: number;
  /** Escalated, then approved by a human, then executed. Revenue a rule that
   *  blocked (rather than escalated) at the same threshold would have refused. */
  approvedThroughGate: number;
  /** Escalated and still waiting. Not yet earned, not yet lost. */
  awaitingApproval: number;
  /** Escalated and denied by a human. Deliberately declined, not refused by a rule. */
  deniedAtGate: number;
  /** Stopped by policy outright — a banned category or a rate limit. */
  refused: number;
  /** Executed revenue attributable to an agent's upsell, i.e. a child action
   *  that exists only because a parent purchase happened. A subset of the two
   *  executed figures above, never added on top of them. */
  upsell: number;

  /**
   * Settled money split by what kind of action produced it.
   *
   * Exists because two panels were reporting different totals under the same
   * word. This function counts EVERY enforce-mode action -- orders, campaign
   * payment links, refunds -- while the Buy tab's order history deliberately
   * counts only `order.create`. Both were right; neither said which set it
   * meant, and two figures labelled "moved" that disagree is a credibility
   * problem whoever notices it first.
   *
   * Surfaced rather than resolved: collapsing them would mean either hiding
   * campaign revenue from the headline or claiming a payment link is an order.
   * The split makes the relationship arithmetic anyone can follow.
   */
  byActionType: Record<string, number>;

  counts: {
    clearedAutomatically: number;
    approvedThroughGate: number;
    awaitingApproval: number;
    deniedAtGate: number;
    refused: number;
    upsell: number;
  };
}

function amountOf(trace: Trace): number {
  const params = trace.params as { amount?: number } | null;
  return typeof params?.amount === "number" ? params.amount : 0;
}

export type RevenueBucket =
  | "clearedAutomatically"
  | "approvedThroughGate"
  | "awaitingApproval"
  | "deniedAtGate"
  | "refused";

export interface ClassifiedTrace {
  bucket: RevenueBucket | null;
  amount: number;
  actionType: string;
  isUpsell: boolean;
  /** Money actually reached Razorpay for this trace — allowed outright, or
   *  escalated and then approved. Independent of `bucket`, which is keyed by
   *  *how* the decision was reached rather than *whether* it settled. */
  settled: boolean;
  createdAt: string;
}

/**
 * The one place a trace becomes a revenue bucket.
 *
 * Both `computeRevenueImpact` (the totals) and `computeRevenueTimeline` (the
 * day-by-day series) reduce over this, so the two can never disagree about
 * what counts as "cleared" versus "approved at the gate" versus "refused" —
 * exactly the failure this project keeps finding in other shapes: two
 * implementations of the same classification drifting apart. `mode !==
 * "enforce"` traces (previews, protocol rejects) classify as `bucket: null`
 * and are excluded by both callers.
 */
export function classifyTrace(trace: Trace, escalationStatus: Map<string, string>): ClassifiedTrace {
  const amount = amountOf(trace);
  const base = { amount, actionType: trace.action_type, createdAt: trace.created_at };

  if (trace.mode !== "enforce") {
    return { ...base, bucket: null, isUpsell: false, settled: false };
  }

  if (trace.decision === "allow") {
    return { ...base, bucket: "clearedAutomatically", isUpsell: !!trace.parent_trace_id, settled: true };
  }
  if (trace.decision === "block") {
    return { ...base, bucket: "refused", isUpsell: false, settled: false };
  }
  if (trace.decision === "escalate") {
    // An escalated action's own decision never changes; whether a human
    // answered lives on the escalation row. No row is treated as still
    // waiting rather than assumed approved — counting unanswered money as
    // earned would be the one dishonest thing this could do.
    const status = escalationStatus.get(trace.id);
    if (status === "approved") {
      return { ...base, bucket: "approvedThroughGate", isUpsell: !!trace.parent_trace_id, settled: true };
    }
    if (status === "denied") {
      return { ...base, bucket: "deniedAtGate", isUpsell: false, settled: false };
    }
    return { ...base, bucket: "awaitingApproval", isUpsell: false, settled: false };
  }
  // protocol_reject with mode === "enforce" doesn't occur in practice (a
  // rejected signature never reaches the mode branch), but the switch has to
  // be total.
  return { ...base, bucket: null, isUpsell: false, settled: false };
}

export function computeRevenueImpact(traces: Trace[], escalations: Escalation[]): RevenueImpact {
  const escalationStatus = new Map(escalations.map((e) => [e.trace_id, e.status]));

  const impact: RevenueImpact = {
    clearedAutomatically: 0,
    approvedThroughGate: 0,
    awaitingApproval: 0,
    deniedAtGate: 0,
    refused: 0,
    upsell: 0,
    byActionType: {},
    counts: {
      clearedAutomatically: 0,
      approvedThroughGate: 0,
      awaitingApproval: 0,
      deniedAtGate: 0,
      refused: 0,
      upsell: 0,
    },
  };

  for (const trace of traces) {
    const c = classifyTrace(trace, escalationStatus);
    if (c.settled) {
      impact.byActionType[c.actionType] = (impact.byActionType[c.actionType] ?? 0) + c.amount;
    }
    if (!c.bucket) continue;

    impact[c.bucket] += c.amount;
    impact.counts[c.bucket] += 1;
    if (c.isUpsell) {
      impact.upsell += c.amount;
      impact.counts.upsell += 1;
    }
  }

  return impact;
}

export interface RevenueTimelinePoint {
  /** A short, locale-stable label for the x-axis — day or hour, chosen by
   *  {@link computeRevenueTimeline} based on how much the data actually spans. */
  label: string;
  /** The bucket boundary in epoch ms, for anything that needs to sort or
   *  re-derive rather than just display. */
  at: number;
  clearedAutomatically: number;
  approvedThroughGate: number;
  awaitingApproval: number;
  deniedAtGate: number;
  refused: number;
}

/**
 * The same classification as the totals above, bucketed over time.
 *
 * Buckets by DAY when the traces span more than 36 hours, otherwise by HOUR.
 * A demo dataset generated in one sitting spans minutes to a few hours; a
 * day-bucketed chart over that would draw one bar. Choosing the grain from the
 * data rather than hardcoding "daily" is what keeps this honest on both a
 * fresh install and a merchant with months of history.
 *
 * Empty buckets are filled in (zeros, not omitted) so the chart draws a
 * continuous axis rather than compressing gaps — a quiet Tuesday should read
 * as flat, not vanish.
 */
export function computeRevenueTimeline(traces: Trace[], escalations: Escalation[]): RevenueTimelinePoint[] {
  const escalationStatus = new Map(escalations.map((e) => [e.trace_id, e.status]));
  const classified = traces.map((t) => classifyTrace(t, escalationStatus)).filter((c) => c.bucket !== null);
  if (classified.length === 0) return [];

  const times = classified.map((c) => new Date(c.createdAt).getTime());
  const min = Math.min(...times);
  const max = Math.max(...times);
  const spanMs = Math.max(max - min, 1);
  const byHour = spanMs < 36 * 60 * 60 * 1000;
  const bucketMs = byHour ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;

  const firstBucket = Math.floor(min / bucketMs) * bucketMs;
  const lastBucket = Math.floor(max / bucketMs) * bucketMs;
  const buckets = new Map<number, RevenueTimelinePoint>();
  for (let t = firstBucket; t <= lastBucket; t += bucketMs) {
    buckets.set(t, {
      at: t,
      label: byHour
        ? new Date(t).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })
        : new Date(t).toLocaleDateString("en-IN", { month: "short", day: "numeric" }),
      clearedAutomatically: 0,
      approvedThroughGate: 0,
      awaitingApproval: 0,
      deniedAtGate: 0,
      refused: 0,
    });
  }

  for (const c of classified) {
    const bucketAt = Math.floor(new Date(c.createdAt).getTime() / bucketMs) * bucketMs;
    const point = buckets.get(bucketAt);
    if (point && c.bucket) point[c.bucket] += c.amount;
  }

  return [...buckets.values()].sort((a, b) => a.at - b.at);
}

/** Money that actually reached Razorpay: cleared outright plus approved at the
 *  gate, across EVERY action type. Kept as a function rather than a stored
 *  field so it can never drift out of step with its two components.
 *
 *  Wider than the Buy tab's order revenue on purpose — see `byActionType`. */
export function totalExecuted(impact: RevenueImpact): number {
  return impact.clearedAutomatically + impact.approvedThroughGate;
}
