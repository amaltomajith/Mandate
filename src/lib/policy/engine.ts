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

/** Paise -> a reasoning string a merchant can actually read at a glance. */
function formatMoney(amountPaise: number, currency: string): string {
  const amount = amountPaise / 100;
  const formatted = amount.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  return currency === "INR" ? `₹${formatted}` : `${formatted} ${currency}`;
}

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
        reasoning: `"${context.category}" is on the blocked category list for rule "${rule.name}".`,
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
          reasoning: `This action is ${formatMoney(context.amount, context.currency)}, over the per-transaction cap of ${formatMoney(params.max_amount, params.currency)} set by rule "${rule.name}".`,
        };
      }
    } else {
      const soFar = aggregates.dailyAmountSoFar[rule.id] ?? 0;
      const projected = soFar + context.amount;
      if (projected > params.max_amount) {
        return {
          rule,
          decision: "block",
          reasoning: `This would bring today's total to ${formatMoney(projected, context.currency)}, over the daily cap of ${formatMoney(params.max_amount, params.currency)} set by rule "${rule.name}".`,
        };
      }
    }
  }

  for (const rule of byType("velocity")) {
    const params = rule.params as VelocityParams;
    const count = aggregates.velocityCounts[rule.id] ?? 0;
    if (count + 1 > params.max_count) {
      const windowLabel =
        params.window_seconds >= 3600
          ? `${Math.round(params.window_seconds / 3600)}h`
          : `${Math.round(params.window_seconds / 60)}m`;
      return {
        rule,
        decision: "block",
        reasoning: `This would be action ${count + 1} within ${windowLabel}, over the limit of ${params.max_count} set by rule "${rule.name}".`,
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
        reasoning: `This action is ${formatMoney(context.amount, context.currency)}, at or above the ${formatMoney(params.threshold_amount, params.currency)} step-up threshold set by rule "${rule.name}" — a human needs to approve it.`,
      };
    }
  }

  return null;
}
