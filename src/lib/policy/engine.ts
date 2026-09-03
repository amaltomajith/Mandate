import type {
  ActionContext,
  EvaluationAggregates,
  PolicyRule,
  RuleMatch,
  CapParams,
  VelocityParams,
  CategoryBlockParams,
  StepUpParams,
  TrustFloorParams,
} from "./types";

/** Paise -> a reasoning string a merchant can actually read at a glance. */
function formatMoney(amountPaise: number, currency: string): string {
  const amount = amountPaise / 100;
  const formatted = amount.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  return currency === "INR" ? `₹${formatted}` : `${formatted} ${currency}`;
}

/**
 * Optional per-rule action-type scoping.
 *
 * Rules were global: a per-transaction cap written for purchase orders also
 * bound refunds, subscriptions, and anything added later, with no way to say
 * otherwise. That is the right default — a merchant who writes a spend ceiling
 * means it — but it makes some perfectly ordinary policies unexpressible.
 * "Fifty thousand a day of discounted payment links, on top of the two lakh a
 * day of orders" needs the two ceilings to be about different things.
 *
 * Absent or empty means the rule applies to everything, so every rule written
 * before this existed keeps its exact meaning. Reading it off `params` rather
 * than adding a column keeps it out of the migration path and lets one check
 * cover all five rule types instead of five near-identical ones.
 */
function appliesTo(rule: PolicyRule, actionType: string): boolean {
  const scope = (rule.params as { action_types?: unknown } | null)?.action_types;
  if (!Array.isArray(scope) || scope.length === 0) return true;
  return scope.includes(actionType);
}

/**
 * Pure policy evaluator. No DB access, no side effects — `simulate_action` and
 * `enforce_action` both call this with the same inputs and get the same decision;
 * only `enforce_action` goes on to make the real Razorpay call when the result is "allow".
 *
 * Priority order is fixed and documented:
 *   category_block > catalog_scope > cap > velocity > trust_floor > step_up.
 * First match wins. This ordering is a deliberate policy choice (hard blocks and
 * spend caps are absolute; step-up is the last resort that asks a human instead of
 * refusing outright) — change it here, in one place, if that priority is wrong for
 * a given merchant.
 *
 * catalog_scope sits SECOND, and the reason is about which sentence the merchant
 * should read. A merchant-wide prohibition is a stronger and more general fact
 * than one agent's permission boundary: if gambling is blocked for everyone,
 * "gambling is blocked" is the true and useful explanation, not "this particular
 * agent happens to be out of scope" — which would imply that widening the scope
 * would help, when it would not. Scope then precedes the money rules because
 * "may not transact this at all" outranks "how much of it".
 *
 * trust_floor sits above step_up because "this agent has not earned the benefit
 * of the doubt" is a stronger reason to involve a human than "this amount is
 * large" — a distrusted agent should be held at any amount, so its reasoning
 * should be the one the merchant reads, not an amount threshold that happens to
 * also match.
 */
export function evaluatePolicy(
  context: ActionContext,
  activeRules: PolicyRule[],
  aggregates: EvaluationAggregates
): RuleMatch | null {
  const byType = (t: PolicyRule["type"]) =>
    activeRules.filter((r) => r.type === t && appliesTo(r, context.actionType));

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

  /**
   * Per-agent catalog scope.
   *
   * `undefined` means the caller had no scope to give (the draft_policy
   * backtest replays historical actions where it is unrecoverable), so the rule
   * is skipped entirely — the same treatment trust_floor gets without a score.
   * `null` means explicitly unscoped, which is the full catalog and never
   * fires. Those two are kept apart deliberately: collapsing them would make a
   * backtest quietly assert every historical action was in scope.
   *
   * An action carrying no category cannot be judged against a scope, so it
   * passes. Scope restricts what an agent may buy from THIS catalog; a refund
   * or a subscription with no category attached is not a catalog purchase, and
   * blocking it here would be this rule reaching past what it knows about.
   */
  if (Array.isArray(context.agentCatalogScope)) {
    const scope = context.agentCatalogScope;
    for (const rule of byType("catalog_scope")) {
      if (!context.category) continue;
      if (!scope.includes(context.category)) {
        // Names both halves. "Out of scope" alone tells the merchant nothing
        // actionable -- they need to see what this agent IS allowed in order to
        // decide whether the boundary or the purchase is the thing that is
        // wrong.
        const allowed =
          scope.length === 0
            ? "nothing — this agent is scoped to an empty catalog"
            : scope.join(", ");
        return {
          rule,
          decision: "block",
          reasoning: `This agent may transact ${allowed}, and this action is in "${context.category}" — outside its catalog scope, set by rule "${rule.name}".`,
        };
      }
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

  // Reputation gate. Skipped when the caller couldn't supply a score (the
  // draft_policy backtest replays historical actions, where the agent's score
  // at that moment isn't recoverable) — better to omit the rule from that
  // replay than to score it against today's number and report a confident
  // count that never happened.
  if (typeof context.agentTrustScore === "number") {
    for (const rule of byType("trust_floor")) {
      const params = rule.params as TrustFloorParams;
      if (context.agentTrustScore < params.min_score) {
        return {
          rule,
          decision: params.action ?? "escalate",
          reasoning:
            `This agent's trust score is ${context.agentTrustScore.toFixed(0)}, below the minimum of ` +
            `${params.min_score} set by rule "${rule.name}" — held regardless of amount.`,
        };
      }
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
