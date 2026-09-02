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
    // simulate-mode traces are previews that never moved money, and a
    // protocol_reject never carried a verified amount to begin with.
    if (trace.mode !== "enforce") continue;
    const amount = amountOf(trace);

    // Settled means money reached Razorpay: allowed outright, or escalated and
    // then approved by a human. Tracked alongside the buckets rather than
    // derived from them, because the buckets are keyed by how a decision was
    // reached and this is keyed by what was bought.
    const settled =
      trace.decision === "allow" ||
      (trace.decision === "escalate" && escalationStatus.get(trace.id) === "approved");
    if (settled) {
      impact.byActionType[trace.action_type] = (impact.byActionType[trace.action_type] ?? 0) + amount;
    }

    if (trace.decision === "allow") {
      impact.clearedAutomatically += amount;
      impact.counts.clearedAutomatically += 1;
      if (trace.parent_trace_id) {
        impact.upsell += amount;
        impact.counts.upsell += 1;
      }
    } else if (trace.decision === "block") {
      impact.refused += amount;
      impact.counts.refused += 1;
    } else if (trace.decision === "escalate") {
      // An escalated action's own decision never changes; whether a human
      // answered lives on the escalation row. A trace with no escalation row
      // is treated as still waiting rather than assumed approved — counting
      // unanswered money as earned would be the one dishonest thing this
      // panel could do.
      const status = escalationStatus.get(trace.id);
      if (status === "approved") {
        impact.approvedThroughGate += amount;
        impact.counts.approvedThroughGate += 1;
        if (trace.parent_trace_id) {
          impact.upsell += amount;
          impact.counts.upsell += 1;
        }
      } else if (status === "denied") {
        impact.deniedAtGate += amount;
        impact.counts.deniedAtGate += 1;
      } else {
        impact.awaitingApproval += amount;
        impact.counts.awaitingApproval += 1;
      }
    }
  }

  return impact;
}

/** Money that actually reached Razorpay: cleared outright plus approved at the
 *  gate, across EVERY action type. Kept as a function rather than a stored
 *  field so it can never drift out of step with its two components.
 *
 *  Wider than the Buy tab's order revenue on purpose — see `byActionType`. */
export function totalExecuted(impact: RevenueImpact): number {
  return impact.clearedAutomatically + impact.approvedThroughGate;
}
