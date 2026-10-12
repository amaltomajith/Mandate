/**
 * The policy time machine: replay what really happened under a proposed policy and
 * show what would have been decided differently, before anything is saved.
 * Pure replay first (running totals, honest about what it cannot replay), then the
 * database path with a draft set of guardrails.
 *
 *   npx tsx --tsconfig worker/tsconfig.json scripts/verify-timemachine.ts
 */
import "./lib/loadEnv";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "../src/lib/supabase/admin";
import { ensureWorkspace } from "../src/lib/workspace";
import { getSettings } from "../src/lib/settings";
import { applyGuardrails, guardrailPatch } from "../src/lib/policy/guardrails";
import { replayPolicy, replayGuardrails, type PastAction } from "../src/lib/policy/timeMachine";
import type { PolicyRule } from "../src/lib/policy/types";

const db = createAdminClient() as unknown as SupabaseClient;
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
const rupees = (n: number) => n * 100;
const T0 = new Date("2026-03-10T09:00:00");
const act = (i: number, amount: number, o: Partial<PastAction> = {}): PastAction => ({
  id: `t${i}`,
  at: new Date(T0.getTime() + i * 60_000),
  actionType: "payout.create",
  amount: rupees(amount),
  currency: "INR",
  agentId: "a1",
  actual: "allow",
  ...o,
});
const stepUp = (rs: number): PolicyRule => ({ id: "su", type: "step_up", name: "approval", params: { threshold_amount: rupees(rs), currency: "INR", action_types: ["payout.create"] } });
const capTx = (rs: number): PolicyRule => ({ id: "cap", type: "cap", name: "single", params: { max_amount: rupees(rs), currency: "INR", scope: "per_transaction", action_types: ["payout.create"] } });
const capPayee = (rs: number): PolicyRule => ({ id: "pd", type: "cap", name: "payee day", params: { max_amount: rupees(rs), currency: "INR", scope: "per_payee_per_day", action_types: ["payout.create"] } });
const velocity = (n: number): PolicyRule => ({ id: "vel", type: "velocity", name: "rate", params: { max_count: n, window_seconds: 3600, scope: "per_agent" } });

async function main() {
  console.log("the replay");
  {
    const history = [act(1, 1000, { actual: "allow" }), act(2, 6000, { actual: "escalate" }), act(3, 12000, { actual: "escalate" }), act(4, 30000, { actual: "block" })];
    const same = replayPolicy(history, [stepUp(5000), capTx(20000)], [stepUp(5000), capTx(20000)]);
    check("the same policy changes nothing", same.changed.length === 0 && same.evaluated === 4);
    check("and it reproduces what really happened", same.fidelity.matched === 4 && same.fidelity.total === 4, JSON.stringify(same.fidelity));

    const raised = replayPolicy(history, [stepUp(5000), capTx(20000)], [stepUp(10000), capTx(20000)]);
    check("raising the approval amount frees the middle payout", raised.changed.length === 1 && raised.changed[0].id === "t2" && raised.changed[0].from === "escalate" && raised.changed[0].to === "allow", JSON.stringify(raised.changed));
    check("it counts the transition and its value", raised.transitions["escalate>allow"]?.count === 1 && raised.transitions["escalate>allow"]?.valuePaise === rupees(6000), JSON.stringify(raised.transitions));

    const tighter = replayPolicy(history, [stepUp(5000), capTx(20000)], [stepUp(5000), capTx(10000)]);
    check("lowering the cap blocks what used to wait", tighter.changed.some((c) => c.id === "t3" && c.from === "escalate" && c.to === "block"));
    check("the totals under each policy add up", tighter.current.allow + tighter.current.escalate + tighter.current.block === 4 && tighter.draft.block === 2, JSON.stringify(tighter.draft));
  }

  console.log("running totals");
  {
    const day = [act(1, 30000, { payeeId: "p1" }), act(2, 30000, { payeeId: "p1" }), act(3, 30000, { payeeId: "p2" })];
    const r = replayPolicy(day, [capPayee(100000)], [capPayee(50000)]);
    check("a daily cap per payee builds up as the day goes", r.changed.length === 1 && r.changed[0].id === "t2" && r.changed[0].to === "block", JSON.stringify(r.changed));
    check("another payee is counted separately", !r.changed.some((c) => c.id === "t3"));
    const next = replayPolicy([act(1, 30000, { payeeId: "p1" }), { ...act(2, 30000, { payeeId: "p1" }), at: new Date(T0.getTime() + 26 * 3600_000) }], [capPayee(100000)], [capPayee(50000)]);
    check("the next day starts from zero", next.changed.length === 0);
    const blockedFirst = replayPolicy([act(1, 60000, { payeeId: "p1" }), act(2, 30000, { payeeId: "p1" })], [capPayee(100000)], [capPayee(50000)]);
    check("only payments the policy allowed count toward its own total", blockedFirst.changed.length === 1 && blockedFirst.changed[0].id === "t1" && blockedFirst.draft.allow === 1, JSON.stringify(blockedFirst));
    const v = replayPolicy([act(1, 100), act(2, 100), act(3, 100), act(4, 100)], [], [velocity(2)]);
    check("a count limit blocks from the third action in the hour", v.changed.map((c) => c.id).join() === "t3,t4", JSON.stringify(v.changed));
  }

  console.log("honesty about what it cannot replay");
  {
    const budget: PolicyRule = { id: "pb", type: "payout_budget", name: "Weekly budget", params: { currency: "INR", max_amount: rupees(100), period_days: 7 } };
    const margin: PolicyRule = { id: "mm", type: "min_margin_floor", name: "Margin floor", params: { min_margin_bps: 1500 } };
    const r = replayPolicy([act(1, 500)], [budget, margin], [budget, margin]);
    check("rules that need live facts are named, not silently guessed", r.notReplayed.includes("Weekly budget") && r.notReplayed.includes("Margin floor"), JSON.stringify(r.notReplayed));
    check("and they do not distort the result (no cost known, no escalation invented)", r.changed.length === 0 && r.draft.allow === 1);
    const big = replayPolicy([act(1, 1)], [], [], 0);
    check("an empty history is a clean empty result", big.evaluated === 1 && big.changed.length === 0);
    const many = replayPolicy(Array.from({ length: 60 }, (_, i) => act(i, 6000)), [stepUp(5000)], [stepUp(10000)]);
    check("only the biggest changes are listed, but all are counted", many.top.length === 20 && many.changed.length === 60);
  }

  console.log("on real history, with draft guardrails");
  const rnd = Math.random().toString(36).slice(2, 8);
  const { data: m } = await db.from("merchants").insert({ name: "tm", slug: `verify-tm-${rnd}` }).select("*").single();
  await ensureWorkspace(db, m.id);
  try {
    const settings = await getSettings(db, m.id);
    await db.from("merchant_settings").update({ max_single_payout_paise: rupees(20000), approval_threshold_paise: rupees(5000) }).eq("merchant_id", m.id);
    await applyGuardrails(db, m.id, await getSettings(db, m.id));
    const { data: agent } = await db.from("agents").select("id").eq("merchant_id", m.id).limit(1).single();
    const mk = async (amount: number, decision: string, minsAgo: number) =>
      db.from("traces").insert({ merchant_id: m.id, mode: "enforce", action_type: "payout.create", agent_id: agent!.id, decision, params: { amount: rupees(amount), currency: "INR" }, created_at: new Date(Date.now() - minsAgo * 60_000).toISOString() });
    await mk(1000, "allow", 50);
    await mk(7000, "escalate", 40);
    await mk(15000, "escalate", 30);
    await mk(30000, "block", 20);
    await mk(400, "protocol_reject", 10);
    const cur = await getSettings(db, m.id);
    const draft = { ...cur, ...guardrailPatch({ maxSinglePayoutRupees: 20000, approvalThresholdRupees: 10000, minMarginPercent: cur.min_margin_bps / 100, weeklyBudgetRupees: cur.weekly_payout_budget_paise / 100, budgetPercentOfRevenue: cur.payout_budget_pct, startingFloatRupees: cur.starting_float_paise / 100, requireApprovedVendors: cur.require_approved_vendors }) };
    const r = await replayGuardrails(db, m.id, draft, 30);
    check("a protocol rejection is not a policy decision, so it is left out", r.evaluated === 4, String(r.evaluated));
    check("raising the approval amount to ₹10,000 frees the ₹7,000 payout", r.changed.length === 1 && r.changed[0].amount === rupees(7000) && r.changed[0].to === "allow", JSON.stringify(r.changed));
    check("the payout-budget and margin guardrails are listed as not replayed", r.notReplayed.some((n) => /budget/i.test(n)) && r.notReplayed.some((n) => /margin/i.test(n)), JSON.stringify(r.notReplayed));
    check("nothing was saved", (await getSettings(db, m.id)).approval_threshold_paise === settings.approval_threshold_paise || Number((await getSettings(db, m.id)).approval_threshold_paise) === rupees(5000));
    const none = await replayGuardrails(db, m.id, cur, 30);
    check("the unchanged settings change nothing", none.changed.length === 0);
    const other = await replayGuardrails(db, m.id, draft, 0);
    check("a window with no history is empty, not an error", other.evaluated === 0);
  } finally {
    await db.from("merchants").delete().eq("id", m.id);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
