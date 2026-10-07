/**
 * Pure policy-engine checks for the rules the COO relies on. No database, no
 * server: `evaluatePolicy` is a pure function, so these run anywhere and fast.
 *
 *   npx tsx scripts/verify-engine.ts
 *
 * What matters most here is the FAIL-CLOSED behaviour: an unresolved payee, an
 * unknown cost and an exhausted budget must each refuse or escalate, because a
 * guardrail that skips when it lacks information is not a guardrail.
 */
import { evaluatePolicy } from "../src/lib/policy/engine";
import type { ActionContext, EvaluationAggregates, PolicyRule } from "../src/lib/policy/types";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

const NO_AGG: EvaluationAggregates = { velocityCounts: {}, dailyAmountSoFar: {}, payoutBudget: {} };
const PAYOUT = ["payout.create"];
const SALES = ["order.create", "payment_link.create", "price.change"];

const rule = (id: string, type: PolicyRule["type"], params: Record<string, unknown>): PolicyRule => ({
  id,
  type,
  name: id,
  params,
});

const payout = (over: Partial<ActionContext> = {}): ActionContext => ({
  actionType: "payout.create",
  amount: 100_000,
  currency: "INR",
  agentId: "a1",
  payee: { id: "p1", status: "active", vendorStatus: "approved" },
  ...over,
});

console.log("whitelisted_payee");
{
  const rules = [rule("wl", "whitelisted_payee", { require_vendor_approved: true, action_types: PAYOUT })];
  check("active payee + approved vendor passes", evaluatePolicy(payout(), rules, NO_AGG) === null);
  check(
    "UNRESOLVED payee is blocked (fail closed)",
    evaluatePolicy(payout({ payee: undefined }), rules, NO_AGG)?.decision === "block"
  );
  check(
    "pending payee is blocked",
    evaluatePolicy(payout({ payee: { id: "p", status: "pending", vendorStatus: "approved" } }), rules, NO_AGG)?.decision === "block"
  );
  check(
    "revoked payee is blocked",
    evaluatePolicy(payout({ payee: { id: "p", status: "revoked", vendorStatus: "approved" } }), rules, NO_AGG)?.decision === "block"
  );
  check(
    "candidate vendor is blocked when approval required",
    evaluatePolicy(payout({ payee: { id: "p", status: "active", vendorStatus: "candidate" } }), rules, NO_AGG)?.decision === "block"
  );
  const lax = [rule("wl2", "whitelisted_payee", { require_vendor_approved: false, action_types: PAYOUT })];
  check(
    "candidate vendor passes when approval is not required",
    evaluatePolicy(payout({ payee: { id: "p", status: "active", vendorStatus: "candidate" } }), lax, NO_AGG) === null
  );
  check(
    "does not apply to a sale",
    evaluatePolicy({ actionType: "order.create", amount: 5000, currency: "INR", agentId: "a1" }, rules, NO_AGG) === null
  );
}

console.log("min_margin_floor");
{
  const rules = [rule("mm", "min_margin_floor", { min_margin_bps: 1500, action_types: SALES })];
  const sale = (revenue: number, cost: number | null): ActionContext => ({
    actionType: "payment_link.create",
    amount: revenue,
    currency: "INR",
    agentId: "a1",
    economics: { revenuePaise: revenue, costPaise: cost },
  });
  check("20% margin passes", evaluatePolicy(sale(100_000, 80_000), rules, NO_AGG) === null);
  check("exactly 15% passes", evaluatePolicy(sale(100_000, 85_000), rules, NO_AGG) === null);
  check("10% margin is blocked", evaluatePolicy(sale(100_000, 90_000), rules, NO_AGG)?.decision === "block");
  check("selling below cost is blocked", evaluatePolicy(sale(100_000, 120_000), rules, NO_AGG)?.decision === "block");
  check("UNKNOWN cost escalates (not skipped)", evaluatePolicy(sale(100_000, null), rules, NO_AGG)?.decision === "escalate");
  check(
    "no economics at all escalates",
    evaluatePolicy({ actionType: "order.create", amount: 100_000, currency: "INR", agentId: "a1" }, rules, NO_AGG)?.decision === "escalate"
  );
  check(
    "price.change below floor is blocked",
    evaluatePolicy(
      { actionType: "price.change", amount: 95_000, currency: "INR", agentId: "a1", economics: { revenuePaise: 95_000, costPaise: 90_000 } },
      rules,
      NO_AGG
    )?.decision === "block"
  );
  check(
    "does not apply to a payout",
    evaluatePolicy(payout({ payee: { id: "p", status: "active", vendorStatus: "approved" } }), rules, NO_AGG) === null
  );
}

console.log("price.change is not spend");
{
  const rules = [
    rule("cap", "cap", { max_amount: 100, currency: "INR", scope: "per_transaction" }),
    rule("step", "step_up", { threshold_amount: 100, currency: "INR" }),
    rule("vel", "velocity", { max_count: 1, window_seconds: 60, scope: "per_agent" }),
  ];
  const change: ActionContext = { actionType: "price.change", amount: 500_000, currency: "INR", agentId: "a1", economics: { revenuePaise: 500_000, costPaise: 1 } };
  check("unscoped cap/step-up/velocity ignore a price change", evaluatePolicy(change, rules, { ...NO_AGG, velocityCounts: { vel: 9 } }) === null);
  check(
    "but still apply to an order",
    evaluatePolicy({ actionType: "order.create", amount: 500_000, currency: "INR", agentId: "a1" }, rules, NO_AGG)?.decision === "block"
  );
}

console.log("cap scopes");
{
  const perTx = [rule("c1", "cap", { max_amount: 500_000, currency: "INR", scope: "per_transaction", action_types: PAYOUT })];
  check("payout over single-payout cap blocked", evaluatePolicy(payout({ amount: 600_000 }), perTx, NO_AGG)?.decision === "block");
  check("payout at the cap passes", evaluatePolicy(payout({ amount: 500_000 }), perTx, NO_AGG) === null);
  const perPayee = [rule("c2", "cap", { max_amount: 1_000_000, currency: "INR", scope: "per_payee_per_day", action_types: PAYOUT })];
  check(
    "per-payee daily total over cap blocked",
    evaluatePolicy(payout({ amount: 300_000 }), perPayee, { ...NO_AGG, dailyAmountSoFar: { c2: 800_000 } })?.decision === "block"
  );
  check(
    "per-payee daily total under cap passes",
    evaluatePolicy(payout({ amount: 100_000 }), perPayee, { ...NO_AGG, dailyAmountSoFar: { c2: 800_000 } }) === null
  );
  const merchantWide = [rule("c3", "cap", { max_amount: 1_000_000, currency: "INR", scope: "per_day_merchant", action_types: PAYOUT })];
  check(
    "merchant-wide daily total over cap blocked",
    evaluatePolicy(payout({ amount: 300_000 }), merchantWide, { ...NO_AGG, dailyAmountSoFar: { c3: 800_000 } })?.decision === "block"
  );
}

console.log("payout_budget");
{
  const params = { currency: "INR", period_days: 7, max_amount: 10_000_000, pct_of_revenue: 70, float_amount: 2_500_000, action_types: PAYOUT };
  const rules = [rule("pb", "payout_budget", params)];
  // allowance = 25,00,000 float + 70% of 10,00,000 revenue = 32,00,000
  check("within float + share of revenue passes", evaluatePolicy(payout({ amount: 3_000_000 }), rules, { ...NO_AGG, payoutBudget: { pb: { spent: 0, revenue: 1_000_000 } } }) === null);
  check("over float + share of revenue blocked", evaluatePolicy(payout({ amount: 3_300_000 }), rules, { ...NO_AGG, payoutBudget: { pb: { spent: 0, revenue: 1_000_000 } } })?.decision === "block");
  check("already-spent counts against the allowance", evaluatePolicy(payout({ amount: 1_000_000 }), rules, { ...NO_AGG, payoutBudget: { pb: { spent: 2_500_000, revenue: 1_000_000 } } })?.decision === "block");
  check("no revenue: only the float is available", evaluatePolicy(payout({ amount: 2_600_000 }), rules, { ...NO_AGG, payoutBudget: { pb: { spent: 0, revenue: 0 } } })?.decision === "block");
  check("no revenue: spending within the float passes", evaluatePolicy(payout({ amount: 2_500_000 }), rules, { ...NO_AGG, payoutBudget: { pb: { spent: 0, revenue: 0 } } }) === null);
  const hardCap = [rule("pb2", "payout_budget", { ...params, max_amount: 1_000_000 })];
  check("hard weekly ceiling wins over a larger allowance", evaluatePolicy(payout({ amount: 1_100_000 }), hardCap, { ...NO_AGG, payoutBudget: { pb2: { spent: 0, revenue: 99_000_000 } } })?.decision === "block");
}

console.log("priority");
{
  const rules = [
    rule("step", "step_up", { threshold_amount: 1, currency: "INR", action_types: PAYOUT }),
    rule("cap", "cap", { max_amount: 1, currency: "INR", scope: "per_transaction", action_types: PAYOUT }),
    rule("wl", "whitelisted_payee", { require_vendor_approved: true, action_types: PAYOUT }),
  ];
  const m = evaluatePolicy(payout({ payee: undefined }), rules, NO_AGG);
  check("payee check outranks cap and step-up", m?.rule.id === "wl", `fired ${m?.rule.id}`);
  const m2 = evaluatePolicy(payout(), rules, NO_AGG);
  check("then the cap outranks step-up", m2?.rule.id === "cap", `fired ${m2?.rule.id}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
