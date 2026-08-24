import type {
  ActionContext,
  EvaluationAggregates,
  PolicyRule,
  RuleMatch,
  CapParams,
  VelocityParams,
  CategoryBlockParams,
  StepUpParams,
} from "./types";

/**
 * Pure policy evaluator. No DB access, no side effects — `simulate_action` and
 * `enforce_action` both call this with the same inputs and get the same decision;
 * only `enforce_action` goes on to make the real Razorpay call when the result is "allow".
 *
 * Priority order is fixed and documented: category_block > cap > velocity > step_up.
 * First match wins. This ordering is a deliberate policy choice (hard blocks and
 * spend caps are absolute; step-up is the last resort that asks a human instead of
 * refusing outright) — change it here, in one place, if that priority is wrong for
 * a given merchant.
 */
export function evaluatePolicy(
  context: ActionContext,
  activeRules: PolicyRule[],
  aggregates: EvaluationAggregates
): RuleMatch | null {
  const byType = (t: PolicyRule["type"]) => activeRules.filter((r) => r.type === t);

  for (const rule of byType("category_block")) {
    const params = rule.params as CategoryBlockParams;
    if (context.category && params.categories.includes(context.category)) {
      return {
        rule,
        decision: "block",
        reasoning: `Category "${context.category}" is on the blocked list for rule "${rule.name}".`,
      };
    }
  }

  for (const rule of byType("cap")) {
    const params = rule.params as CapParams;
    if (params.currency !== context.currency) continue;

    if (params.scope === "per_transaction") {
      if (context.amount > params.max_amount) {
        return {
          rule,
          decision: "block",
          reasoning: `Amount ${context.amount} ${context.currency} exceeds the per-transaction cap of ${params.max_amount} ${params.currency} set by rule "${rule.name}".`,
        };
      }
    } else {
      const soFar = aggregates.dailyAmountSoFar[rule.id] ?? 0;
      const projected = soFar + context.amount;
      if (projected > params.max_amount) {
        return {
          rule,
          decision: "block",
          reasoning: `This action would bring today's total to ${projected} ${context.currency}, over the daily cap of ${params.max_amount} ${params.currency} set by rule "${rule.name}".`,
        };
      }
    }
  }

  for (const rule of byType("velocity")) {
    const params = rule.params as VelocityParams;
    const count = aggregates.velocityCounts[rule.id] ?? 0;
    if (count + 1 > params.max_count) {
      return {
        rule,
        decision: "block",
        reasoning: `This would be action ${count + 1} within ${params.window_seconds}s, over the limit of ${params.max_count} set by rule "${rule.name}".`,
      };
    }
  }

  for (const rule of byType("step_up")) {
    const params = rule.params as StepUpParams;
    if (params.currency !== context.currency) continue;
    if (context.amount >= params.threshold_amount) {
      return {
        rule,
        decision: "escalate",
        reasoning: `Amount ${context.amount} ${context.currency} is at or above the step-up threshold of ${params.threshold_amount} ${params.currency} set by rule "${rule.name}" — a human needs to approve this one.`,
      };
    }
  }

  return null;
}
