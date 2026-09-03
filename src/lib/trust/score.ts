/**
 * Trust score formula:
 *
 *   score = clamp(0, 100,
 *     50
 *     + 30 * (approvals - blocks) / total
 *     - 10 * (escalations / total)
 *     + 10 * min(accountAgeDays, 30) / 30
 *   )
 *
 * Starts every agent at a neutral 50. Rewards a clean approve/block ratio,
 * penalizes escalations lightly, and gives a small, capped boost for tenure so
 * a brand-new agent can't out-trust an established one on a lucky streak.
 *
 * That escalation weight is deliberately small (-10, not -30 like a block),
 * and the reason is a trap found by working the arithmetic backwards. An
 * escalation is not a failure — it is the system working, a human being asked.
 * But once a trust_floor rule starts holding an agent, EVERY subsequent
 * decision is an escalation, so the penalty becomes self-sustaining. At -20
 * an agent held by the floor settles at 30.0 and can never climb back above a
 * floor of 35: the gate becomes a one-way trapdoor that no amount of good
 * behaviour reopens. At -10 that equilibrium is 40, comfortably above the
 * floor, so being held is a state an agent recovers from — while an agent
 * genuinely being blocked still lands near 29 and stays held. Any change to
 * this weight or to a trust_floor threshold has to preserve that ordering. Every
 * component is stored alongside the score so the dashboard and `explain()` can
 * show the reasoning instead of just a number.
 *
 * Computed over a WINDOW of recent decisions, not all history — see
 * TRUST_WINDOW_SIZE in traceHelpers.ts. An all-time score can't be recovered
 * from: an agent with a few hundred clean actions barely moves when it
 * misbehaves, and one that misbehaved badly is punished forever no matter how
 * it behaves afterwards. Neither is what a reputation signal should do, and a
 * score that can't move is one the trust_floor rule can't meaningfully gate on.
 *
 * There is deliberately NO penalty for forged/tampered requests, despite those
 * being logged. A request whose signature doesn't verify carries no proven
 * identity — the signature is what proves it — so it can't be attributed to an
 * agent at all. Attributing by the *claimed* keyid would let anyone destroy a
 * competitor's score by sending forgeries in their name. Those rejections are
 * recorded as traces and alerts, just not against anybody's reputation.
 */

/** How many recent enforce-mode decisions the score is computed over. Small
 *  enough that a single bad week can move it — a window covering years of
 *  history is one no gate can usefully act on — and large enough that a
 *  single unlucky block doesn't swing it wildly.
 *
 *  Canonical here, not in traceHelpers.ts (which imports it): this file has no
 *  dependencies of its own, so it's the one direction that can't create a
 *  cycle. `computeTrustTrajectory` below and the live `recomputeTrust` in
 *  traceHelpers.ts both read this constant, which is what keeps a replayed
 *  history and a freshly recomputed score describable by the same rule. */
export const TRUST_WINDOW_SIZE = 50;

export interface TrustInputs {
  approvals: number;
  blocks: number;
  escalations: number;
  accountAgeDays: number;
}

export interface TrustComponents {
  score: number;
  base: number;
  approvalBlockTerm: number;
  escalationPenalty: number;
  tenureBonus: number;
  totalDecisions: number;
  /** The raw counts each term was derived from, stored alongside the terms so
   *  the dashboard can show "why this score" without re-querying. */
  approvals: number;
  blocks: number;
  escalations: number;
  accountAgeDays: number;
}

export function computeTrustScore(inputs: TrustInputs): TrustComponents {
  const total = inputs.approvals + inputs.blocks + inputs.escalations;
  const base = 50;

  if (total === 0) {
    return {
      score: base,
      base,
      approvalBlockTerm: 0,
      escalationPenalty: 0,
      tenureBonus: 0,
      totalDecisions: 0,
      approvals: inputs.approvals,
      blocks: inputs.blocks,
      escalations: inputs.escalations,
      accountAgeDays: inputs.accountAgeDays,
    };
  }

  const approvalBlockTerm = 30 * ((inputs.approvals - inputs.blocks) / total);
  const escalationPenalty = -10 * (inputs.escalations / total);
  const tenureBonus = 10 * (Math.min(inputs.accountAgeDays, 30) / 30);
  const raw = base + approvalBlockTerm + escalationPenalty + tenureBonus;
  const score = Math.max(0, Math.min(100, raw));

  return {
    score,
    base,
    approvalBlockTerm,
    escalationPenalty,
    tenureBonus,
    totalDecisions: total,
    approvals: inputs.approvals,
    blocks: inputs.blocks,
    escalations: inputs.escalations,
    accountAgeDays: inputs.accountAgeDays,
  };
}

export interface TrustTrajectoryPoint {
  at: string;
  score: number;
}

/**
 * What the live score WAS at each point in an agent's history, replayed.
 *
 * Not stored anywhere — `agents.trust_score` only ever holds the current
 * value, overwritten on every `recomputeTrust`. This derives the whole curve
 * from the same trace history that produces the live number, using the exact
 * same formula and the exact same window, so a chart built from this can never
 * show a trajectory that disagrees with the score sitting next to it.
 *
 * `accountAgeDays` at each point uses that decision's OWN `created_at`, not
 * today's date — `recomputeTrust` runs synchronously right after a trace is
 * written, so at the time index `i` actually happened, "now" for that
 * calculation was (approximately) decisions[i].createdAt. Using today's date
 * throughout would make every historical point read as if it happened moments
 * ago.
 *
 * That approximation is exact for allow/block, and off by a few points of
 * `tenureBonus` for the LAST point when it is an escalation resolved well
 * after it was proposed — verified against live data: an escalation created
 * at 02:31 and approved at 04:46 recomputes trust at 04:46's Date.now(), which
 * this function has no way to know without also fetching the resolution time.
 * The point is stamped at the trace's created_at anyway rather than the
 * escalation's resolved_at, because the chart's job is to show *when the
 * action happened*, not when a human got around to it — a trajectory that
 * jumped a point forward to approval time would misrepresent the timeline for
 * the sake of a decimal. The gap this leaves is small (observed: under 0.05 of
 * a 0-100 score) and only ever touches the single most recent point.
 *
 * Sliding-window, O(n): each step adds the newest decision and, once the
 * window is full, removes the oldest — never recounts from scratch.
 */
export function computeTrustTrajectory(
  decisions: { decision: "allow" | "block" | "escalate"; createdAt: string }[],
  accountCreatedAt: string
): TrustTrajectoryPoint[] {
  const chronological = [...decisions].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const accountCreatedMs = new Date(accountCreatedAt).getTime();
  const window: (typeof chronological)[number][] = [];
  const counts = { allow: 0, block: 0, escalate: 0 };
  const points: TrustTrajectoryPoint[] = [];

  for (const d of chronological) {
    window.push(d);
    counts[d.decision] += 1;
    if (window.length > TRUST_WINDOW_SIZE) {
      const dropped = window.shift()!;
      counts[dropped.decision] -= 1;
    }

    const accountAgeDays = Math.max(0, (new Date(d.createdAt).getTime() - accountCreatedMs) / (1000 * 60 * 60 * 24));
    const { score } = computeTrustScore({
      approvals: counts.allow,
      blocks: counts.block,
      escalations: counts.escalate,
      accountAgeDays,
    });
    points.push({ at: d.createdAt, score });
  }

  return points;
}
