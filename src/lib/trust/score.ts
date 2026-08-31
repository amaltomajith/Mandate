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
