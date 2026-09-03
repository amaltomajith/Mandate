import { z } from "zod";
import type { Decision, PolicyRuleType } from "@/types/db";

/** Optional on every rule type: restricts the rule to specific action types.
 *  Absent means "applies to every action", which is what every rule written
 *  before this field existed means, so nothing changes meaning by default.
 *  See `appliesTo` in engine.ts. */
const actionTypes = { action_types: z.array(z.string()).optional() };

export const CapParams = z.object({
  max_amount: z.number().positive(),
  currency: z.string().length(3),
  scope: z.enum(["per_transaction", "per_day"]),
  ...actionTypes,
});
export type CapParams = z.infer<typeof CapParams>;

export const VelocityParams = z.object({
  max_count: z.number().int().positive(),
  window_seconds: z.number().int().positive(),
  scope: z.enum(["per_agent", "per_customer"]),
  ...actionTypes,
});
export type VelocityParams = z.infer<typeof VelocityParams>;

export const CategoryBlockParams = z.object({
  categories: z.array(z.string()).min(1),
  ...actionTypes,
});
export type CategoryBlockParams = z.infer<typeof CategoryBlockParams>;

export const StepUpParams = z.object({
  threshold_amount: z.number().positive(),
  currency: z.string().length(3),
  ...actionTypes,
});
export type StepUpParams = z.infer<typeof StepUpParams>;

/** Reputation gate. Below `min_score`, this agent's actions are held —
 *  escalated for a human by default, or refused outright — whatever the
 *  amount. The trust score is computed on every enforce decision
 *  (src/lib/trust/score.ts); this is the rule that makes it consequential
 *  rather than merely displayed. */
export const TrustFloorParams = z.object({
  min_score: z.number().min(0).max(100),
  action: z.enum(["escalate", "block"]).default("escalate"),
  ...actionTypes,
});
export type TrustFloorParams = z.infer<typeof TrustFloorParams>;

/**
 * Per-agent catalog scope, read from the AGENT rather than from this rule.
 *
 * The rule carries no categories of its own, which looks odd next to
 * category_block until you see what it is for: this is one merchant-wide rule
 * saying "agents are held to their assigned scope", and the scope itself is a
 * property of each agent. Exactly the shape of trust_floor, which states a
 * threshold while the score it compares against lives on the agent.
 *
 * Putting the categories here instead would mean one rule per agent, which is
 * per-rule targeting under another name -- built once, removed once, recorded
 * in section 17.
 */
export const CatalogScopeParams = z.object({
  ...actionTypes,
});
export type CatalogScopeParams = z.infer<typeof CatalogScopeParams>;

export const RuleParamsByType = {
  cap: CapParams,
  velocity: VelocityParams,
  category_block: CategoryBlockParams,
  catalog_scope: CatalogScopeParams,
  step_up: StepUpParams,
  trust_floor: TrustFloorParams,
} satisfies Record<PolicyRuleType, z.ZodType>;

/** Rule shape the policy engine operates on — a narrowed view of a `policy_rules` row. */
export interface PolicyRule {
  id: string;
  type: PolicyRuleType;
  name: string;
  params: unknown;
}

export interface ActionContext {
  actionType: string; // e.g. "order.create" | "refund.create" | "subscription.create"
  amount: number; // smallest currency unit (paise)
  currency: string;
  category?: string;
  agentId: string;
  customerId?: string;
  /** The acting agent's current trust score (0-100), read by `trust_floor`
   *  rules. Optional because the pure evaluator must stay callable without
   *  it — the backtest in draft_policy replays historical actions where the
   *  score at the time isn't recoverable, and guessing would be worse than
   *  skipping the rule. */
  agentTrustScore?: number;
  /**
   * Categories this agent may transact, read by `catalog_scope` rules.
   *
   * Three states, and they are not interchangeable:
   *   undefined -- the caller could not supply one. The rule is skipped, the
   *                same way trust_floor is skipped without a score. The
   *                draft_policy backtest replays historical actions where the
   *                scope at the time is unrecoverable, and guessing would be
   *                worse than not evaluating.
   *   null      -- this agent is explicitly unscoped: the full catalog.
   *   string[]  -- exactly these categories, and an EMPTY array means none.
   *
   * Collapsing undefined and null would make a backtest silently assert that
   * every historical action was in scope, which is a confident claim about
   * something nobody knows.
   */
  agentCatalogScope?: string[] | null;
}

export interface RuleMatch {
  rule: PolicyRule;
  decision: Exclude<Decision, "protocol_reject" | "allow">;
  reasoning: string;
}

/** Everything the evaluator needs beyond the rule list, pre-computed by the caller
 *  (it needs DB access the pure evaluator deliberately doesn't have). */
export interface EvaluationAggregates {
  /** ruleId -> count of the agent/customer's matching actions already inside the rule's window (excludes the current one). */
  velocityCounts: Record<string, number>;
  /** ruleId -> sum of today's amounts for the relevant scope so far (excludes the current one), only needed for cap rules with scope "per_day". */
  dailyAmountSoFar: Record<string, number>;
}
