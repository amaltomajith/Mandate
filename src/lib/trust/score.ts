/**
 * Trust score formula (documented in the build plan, §Trust score):
 *
 *   score = clamp(0, 100,
 *     50
 *     + 30 * (approvals - blocks) / total
 *     - 20 * (escalations / total)
 *     + 10 * min(accountAgeDays, 30) / 30
 *   )
 *
 * Starts every agent at a neutral 50. Rewards a clean approve/block ratio, penalizes
 * escalations (they're not failures, but a trustworthy agent shouldn't need many),
 * and gives a small, capped boost for tenure so a brand-new agent can't out-trust
 * an established one on a lucky streak. Every component is stored alongside the
 * score so `explain()` can show its reasoning instead of just a number.
 */

export interface TrustInputs {
  approvals: number;
  blocks: number;
  escalations: number;
  /** protocol_reject events count separately — they reflect a malformed/tampered
   *  call, not a policy judgment, but repeated ones should still drag trust down. */
  protocolRejects: number;
  accountAgeDays: number;
}

export interface TrustComponents {
  score: number;
  base: number;
  approvalBlockTerm: number;
  escalationPenalty: number;
  tenureBonus: number;
  protocolRejectPenalty: number;
  totalDecisions: number;
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
      protocolRejectPenalty: 0,
      totalDecisions: 0,
    };
  }

  const approvalBlockTerm = 30 * ((inputs.approvals - inputs.blocks) / total);
  const escalationPenalty = -20 * (inputs.escalations / total);
  const tenureBonus = 10 * (Math.min(inputs.accountAgeDays, 30) / 30);
  const protocolRejectPenalty = -5 * Math.min(inputs.protocolRejects, 4); // caps at -20

  const raw = base + approvalBlockTerm + escalationPenalty + tenureBonus + protocolRejectPenalty;
  const score = Math.max(0, Math.min(100, raw));

  return {
    score,
    base,
    approvalBlockTerm,
    escalationPenalty,
    tenureBonus,
    protocolRejectPenalty,
    totalDecisions: total,
  };
}
