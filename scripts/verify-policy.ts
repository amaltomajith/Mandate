/**
 * Proves every policy rule type actually fires, against a live engine.
 *
 * The engine is pure and could be unit-tested in isolation, but that would only
 * prove the evaluator agrees with itself. What matters is the whole path: a
 * signed request, the aggregates fetched from real traces, the rule matched,
 * the decision recorded. So this installs one rule at a time on a throwaway
 * merchant and drives it through MCP exactly as an agent would.
 *
 * Each case asserts BOTH directions — the rule fires when it should and does
 * not when it should not. A test that only checks the block is satisfied by an
 * engine that blocks everything.
 *
 * `per_customer` velocity gets the most attention here. That scope existed in
 * the schema from the start and `draft_policy` offered it to the model as a
 * rule it could generate, but `getAggregates` only ever filtered by agent, so a
 * per-customer rule behaved identically to a per-agent one and nothing said so.
 * No active rule used it, so nothing was wrong in practice - but it is the
 * guardrail a campaign depends on, and a fix nobody verified is just a
 * different untested claim.
 *
 * Usage: npx tsx scripts/verify-policy.ts    (needs the dev server running)
 */
import "./lib/loadEnv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { generateKeyPair } from "../src/lib/webBotAuth/keys";
import { MandateClient } from "../src/lib/demo/mandateClient";
import { applySeedProducts } from "../src/lib/demo/catalog";
import type { Json } from "../src/types/db";

const db: SupabaseClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);
const BASE = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(56)} ${detail}`);
}

interface ActionResult {
  decision: "allow" | "block" | "escalate";
  reasoning: string;
  ruleFired: { name: string; type: string } | null;
  traceId: string;
}

let merchantId = "";
let client: MandateClient;
/** The scoped agent's row id, so the scope can be changed mid-run. */
let scopedAgentId = "";
const customerIds: string[] = [];

/**
 * Leaves exactly one active rule, so each case is evaluated against that rule
 * alone and a pass cannot be another rule's doing.
 *
 * Supersedes rather than deletes. `traces.rule_fired_id` references
 * `policy_rules` with no ON DELETE clause, so once any trace has cited a rule
 * that rule cannot be removed - the delete fails with a foreign key violation.
 * The first version of this script deleted and did not check the error, so
 * every rule stayed active and later cases were being decided by earlier ones:
 * a step_up case reporting `cap` as the rule that fired. Superseding is also
 * what the dashboard itself does, so this now exercises the real operation.
 */
async function onlyRule(type: string, name: string, params: Json) {
  const { error: retireErr } = await db
    .from("policy_rules")
    .update({ status: "superseded" })
    .eq("merchant_id", merchantId)
    .eq("status", "active");
  if (retireErr) throw new Error(`retiring rules: ${retireErr.message}`);

  const { error } = await db.from("policy_rules").insert({
    merchant_id: merchantId,
    type: type as never,
    name,
    params,
    status: "active",
    source: "human",
    rationale: "verify-policy",
  });
  if (error) throw new Error(error.message);
}

async function order(amountPaise: number, category: string, customerId?: string) {
  return client.callTool<ActionResult>("enforce_action", {
    actionType: "order.create",
    amount: amountPaise,
    currency: "INR",
    category,
    ...(customerId ? { customerId } : {}),
    params: { receipt: `pol-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` },
  });
}

async function main() {
  const slug = `pol-${Math.random().toString(36).slice(2, 8)}`;
  const { data: merchant, error } = await db
    .from("merchants")
    .insert({ name: "Policy Test", slug })
    .select()
    .single();
  if (error) throw new Error(error.message);
  merchantId = merchant.id;
  await applySeedProducts(db, merchantId);

  const { secretKey, publicKey } = generateKeyPair();
  const { data: agent } = await db
    .from("agents")
    .insert({ merchant_id: merchantId, name: "Policy Probe", public_key: publicKey })
    .select()
    .single();

  for (const n of ["Cust One", "Cust Two"]) {
    const { data } = await db
      .from("customers")
      .insert({ merchant_id: merchantId, name: n, email: `${n.replace(" ", ".")}@example.com` })
      .select()
      .single();
    customerIds.push(data!.id);
  }

  scopedAgentId = agent!.id;
  client = new MandateClient(BASE, slug, agent!.id, secretKey);
  await client.initialize("verify-policy");
  console.log(`merchant ${slug}\n`);

  try {
    // ---- category_block
    await onlyRule("category_block", "Blocked categories", { categories: ["crypto", "gambling"] } as Json);
    const banned = await order(50000, "crypto");
    const allowed = await order(50000, "electronics");
    check("category_block refuses a banned category", banned.decision === "block", banned.ruleFired?.type ?? "");
    check("category_block leaves other categories alone", allowed.decision === "allow", allowed.decision);

    // ---- cap, per transaction
    await onlyRule("cap", "Per-transaction cap", {
      max_amount: 100000,
      currency: "INR",
      scope: "per_transaction",
    } as Json);
    const over = await order(150000, "electronics");
    const under = await order(50000, "electronics");
    check("cap blocks above the ceiling", over.decision === "block", over.ruleFired?.type ?? "");
    check("cap allows below the ceiling", under.decision === "allow", under.decision);

    // ---- step_up
    await onlyRule("step_up", "Step-up", { threshold_amount: 100000, currency: "INR" } as Json);
    const big = await order(150000, "electronics");
    const small = await order(50000, "electronics");
    check("step_up escalates above the threshold", big.decision === "escalate", big.ruleFired?.type ?? "");
    check("step_up allows below the threshold", small.decision === "allow", small.decision);

    // ---- trust_floor. Trust starts at 50, so a floor of 90 must hold
    //      everything and a floor of 10 must hold nothing, regardless of amount.
    await onlyRule("trust_floor", "High floor", { min_score: 90, action: "escalate" } as Json);
    const held = await order(1000, "electronics");
    check("trust_floor holds a below-floor agent at any amount", held.decision === "escalate", held.ruleFired?.type ?? "");

    await onlyRule("trust_floor", "Low floor", { min_score: 5, action: "escalate" } as Json);
    const free = await order(1000, "electronics");
    check("trust_floor ignores an above-floor agent", free.decision === "allow", free.decision);

    // ---- velocity, per_agent.
    //      Deliberately driven by a FRESH agent. The main probe has already
    //      made a dozen actions inside any sensible window by this point, so
    //      reusing it would blow a limit of 3 before the case even began - and
    //      the first version of this script did exactly that, then reported it
    //      as the engine failing. A rate limit test whose subject is already
    //      rate-limited proves nothing.
    await onlyRule("velocity", "Per-agent rate", {
      max_count: 3,
      window_seconds: 600,
      scope: "per_agent",
    } as Json);

    const fresh = generateKeyPair();
    const { data: freshAgent } = await db
      .from("agents")
      .insert({ merchant_id: merchantId, name: "Fresh Probe", public_key: fresh.publicKey })
      .select()
      .single();
    const freshClient = new MandateClient(BASE, slug, freshAgent!.id, fresh.secretKey);
    await freshClient.initialize("verify-policy-fresh");

    const agentSeq: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await freshClient.callTool<ActionResult>("enforce_action", {
        actionType: "order.create",
        amount: 1000,
        currency: "INR",
        category: "electronics",
        params: { receipt: `pol-fresh-${Date.now()}-${i}` },
      });
      agentSeq.push(r.decision);
    }
    check(
      "velocity per_agent blocks past the limit",
      agentSeq.slice(0, 3).every((d) => d === "allow") && agentSeq.slice(3).every((d) => d === "block"),
      agentSeq.join(",")
    );

    // ---- velocity, per_customer. THE case this script exists for.
    //      Two allowed per customer. Customer One is driven past the limit,
    //      then Customer Two must still be clear - same agent, same window.
    //      Before the fix this second assertion failed, because the count was
    //      filtered by agent and customer two inherited customer one's usage.
    await onlyRule("velocity", "Per-customer rate", {
      max_count: 2,
      window_seconds: 600,
      scope: "per_customer",
    } as Json);

    const one: string[] = [];
    for (let i = 0; i < 4; i++) one.push((await order(1000, "electronics", customerIds[0])).decision);
    check(
      "velocity per_customer blocks past the limit",
      one.slice(0, 2).every((d) => d === "allow") && one.slice(2).every((d) => d === "block"),
      one.join(",")
    );

    const two = await order(1000, "electronics", customerIds[1]);
    check(
      "velocity per_customer does NOT leak across customers",
      two.decision === "allow",
      `${two.decision} — same agent, second customer`
    );

    // An action naming no customer must not be counted against, or refused by,
    // a per-customer rule: there is nobody it could have hit too often.
    const anon = await order(1000, "electronics");
    check("velocity per_customer ignores unattributed actions", anon.decision === "allow", anon.decision);

    // ---- action_types scoping: a rule that names other action types must not
    //      bind this one.
    await onlyRule("cap", "Links only", {
      max_amount: 1,
      currency: "INR",
      scope: "per_transaction",
      action_types: ["payment_link.create"],
    } as Json);
    const unscoped = await order(500000, "electronics");
    check(
      "action_types scoping keeps a rule off other action types",
      unscoped.decision === "allow",
      `${unscoped.decision} against a cap of 1 paise on payment links`
    );

    // ---- priority: with a category block and a step_up both matching, the
    //      category block must win and be the rule the merchant is shown.
    const { error: retire2 } = await db
      .from("policy_rules")
      .update({ status: "superseded" })
      .eq("merchant_id", merchantId)
      .eq("status", "active");
    if (retire2) throw new Error(`retiring rules: ${retire2.message}`);
    await db.from("policy_rules").insert([
      {
        merchant_id: merchantId,
        type: "category_block" as never,
        name: "Blocked categories",
        params: { categories: ["crypto"] } as Json,
        status: "active" as never,
        source: "human" as never,
        rationale: "verify-policy",
      },
      {
        merchant_id: merchantId,
        type: "step_up" as never,
        name: "Step-up",
        params: { threshold_amount: 1000, currency: "INR" } as Json,
        status: "active" as never,
        source: "human" as never,
        rationale: "verify-policy",
      },
    ]);
    const both = await order(500000, "crypto");
    check(
      "priority: category_block beats step_up when both match",
      both.decision === "block" && both.ruleFired?.type === "category_block",
      `${both.decision} via ${both.ruleFired?.type}`
    );

    // ---------------------------------------------------------- catalog_scope
    //
    // Every check here carries a CONTROL. "The scoped agent cannot buy office"
    // passes vacuously if nothing could buy office at that moment -- a rule
    // change, a cap, a rate limit -- so each one is paired with an unscoped
    // agent doing the identical thing in the same instant. Without that pairing
    // these tests would keep passing after the feature was deleted.
    await onlyRule("catalog_scope", "Agents keep to their assigned catalog", {});

    const controlKeys = generateKeyPair();
    const { data: controlAgent } = await db
      .from("agents")
      .insert({ merchant_id: merchantId, name: "Unscoped Control", public_key: controlKeys.publicKey })
      .select()
      .single();
    const unscopedClient = new MandateClient(BASE, slug, controlAgent!.id, controlKeys.secretKey);
    const controlOrder = (amount: number, category: string) =>
      unscopedClient.callTool<ActionResult>("enforce_action", {
        actionType: "order.create",
        amount,
        currency: "INR",
        category,
        params: { receipt: `ctl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` },
      });

    // Unscoped (NULL) must behave exactly as before the column existed.
    const beforeScope = await order(100000, "office");
    check(
      "an agent with no scope is unaffected",
      beforeScope.decision === "allow",
      `${beforeScope.decision}`
    );

    await db.from("agents").update({ catalog_scope: ["electronics"] }).eq("id", scopedAgentId);

    const outOfScope = await order(100000, "office");
    check(
      "a scoped agent is blocked outside its scope",
      outOfScope.decision === "block" && outOfScope.ruleFired?.type === "catalog_scope",
      `${outOfScope.decision} via ${outOfScope.ruleFired?.type}`
    );
    check(
      "the reason names the scope AND the category",
      /electronics/.test(outOfScope.reasoning) && /office/.test(outOfScope.reasoning),
      outOfScope.reasoning.slice(0, 68)
    );

    // THE CONTROL. Same category, same amount, same instant, different agent.
    const control = await controlOrder(100000, "office");
    check(
      "CONTROL: the same purchase is allowed for an unscoped agent",
      control.decision === "allow",
      `${control.decision} — so the block above is the scope, not the catalog`
    );

    const inScope = await order(100000, "electronics");
    check(
      "the scoped agent can still buy inside its scope",
      inScope.decision === "allow",
      `${inScope.decision}`
    );

    // Scope changes take effect on the next request, with no restart. The
    // engine is handed the scope per call rather than caching it.
    await db.from("agents").update({ catalog_scope: ["electronics", "office"] }).eq("id", scopedAgentId);
    const widened = await order(100000, "office");
    check(
      "widening the scope takes effect on the next request",
      widened.decision === "allow",
      `${widened.decision}, no restart`
    );

    // An EMPTY array is not "unset". It means nothing is permitted, and the
    // reason has to say so rather than listing an empty set of categories.
    await db.from("agents").update({ catalog_scope: [] }).eq("id", scopedAgentId);
    const nothing = await order(100000, "electronics");
    check(
      "an empty scope permits nothing, and says so",
      nothing.decision === "block" && /nothing/.test(nothing.reasoning),
      nothing.reasoning.slice(0, 60)
    );

    // ---- ordering: a merchant-wide prohibition outranks one agent's boundary
    await db.from("agents").update({ catalog_scope: ["electronics"] }).eq("id", scopedAgentId);
    await db
      .from("policy_rules")
      .insert({
        merchant_id: merchantId,
        type: "category_block" as never,
        name: "Blocked categories",
        params: { categories: ["gambling"] },
        status: "active",
        source: "human",
        rationale: "verify-policy",
      });
    const bothApply = await order(100000, "gambling");
    check(
      "priority: category_block beats catalog_scope when both apply",
      bothApply.decision === "block" && bothApply.ruleFired?.type === "category_block",
      `${bothApply.decision} via ${bothApply.ruleFired?.type}`
    );

    // ---- the two decisions from phase 2, asserted on the counts themselves
    //
    // A scope block CONSUMES velocity budget and COSTS trust, both for the same
    // reason: category_block is the exact analogue and does both. Refusing to
    // count would hand an agent a free enumeration oracle -- name SKUs until
    // one sticks, unmetered -- and a block type that cost nothing would be the
    // only one in the system. Asserted here rather than left to inference,
    // because "decided by omission" is the shape of three separate bugs in
    // section 17.
    const { count: enforceTraces } = await db
      .from("traces")
      .select("*", { count: "exact", head: true })
      .eq("agent_id", scopedAgentId)
      .eq("mode", "enforce")
      .eq("decision", "block");
    check(
      "a scope block is written as an enforce-mode block trace",
      (enforceTraces ?? 0) > 0,
      `${enforceTraces} block trace(s) — so velocity counts it and trust sees it`
    );

    const { data: scopedRow } = await db
      .from("agents")
      .select("trust_score")
      .eq("id", scopedAgentId)
      .single();
    check(
      "and it therefore moves the trust score below a clean 80",
      (scopedRow?.trust_score ?? 100) < 80,
      `trust ${Math.round(scopedRow?.trust_score ?? -1)} after blocks`
    );
  } finally {
    await db.from("merchants").delete().eq("id", merchantId);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) for (const f of failed) console.log(`  FAILED: ${f.name} — ${f.detail}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
