/**
 * Counter-offers over MRTR, tested against the invariant rather than the happy
 * path.
 *
 * The thing that makes this feature safe is that POST #1 decides nothing
 * durable and POST #2 re-decides everything. That property is invisible when it
 * works and catastrophic when it does not, so every case here is written to
 * FAIL if it is removed:
 *
 *   - a cap is changed BETWEEN the two posts, and the outcome must change
 *   - a state is replayed, and the second use must not become a second order
 *   - the offer post must leave no Razorpay call and no velocity slot spent
 *
 * Where a check could pass for the wrong reason it asserts a control first. "No
 * Razorpay call happened" is trivially true if nothing happened at all, so the
 * offer case also asserts that an offer was actually made.
 *
 * Usage: npx tsx scripts/verify-mrtr.ts    (needs the dev server running)
 */
import "./lib/loadEnv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { generateKeyPair } from "../src/lib/webBotAuth/keys";
import { MandateClient } from "../src/lib/demo/mandateClient";
import { applySeedProducts, fetchCatalog } from "../src/lib/demo/catalog";
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
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(58)} ${detail}`);
}

interface Outcome {
  decision: string;
  reasoning: string;
  traceId: string;
  razorpayResponse: unknown;
  suggestions?: { sku: string; name: string }[];
  counterOffer?: { offered: { sku: string }; accepted: boolean; child?: Outcome };
}

interface Tenant {
  id: string;
  slug: string;
  agentId: string;
  secret: string;
  /** Declares elicitation — gets counter-offers. */
  buyer: MandateClient;
  /** Declares nothing — must still transact, and gets suggestions instead. */
  plain: MandateClient;
}

async function makeTenant(label: string): Promise<Tenant> {
  const slug = `mrtr-${label}-${Math.random().toString(36).slice(2, 7)}`;
  const { data: merchant, error } = await db
    .from("merchants")
    .insert({ name: `MRTR ${label}`, slug })
    .select()
    .single();
  if (error) throw new Error(error.message);
  await applySeedProducts(db, merchant.id);

  const { secretKey, publicKey } = generateKeyPair();
  const { data: agent } = await db
    .from("agents")
    .insert({ merchant_id: merchant.id, name: "Buyer", public_key: publicKey })
    .select()
    .single();

  return {
    id: merchant.id,
    slug,
    agentId: agent!.id,
    secret: secretKey,
    buyer: new MandateClient(BASE, slug, agent!.id, secretKey, true),
    plain: new MandateClient(BASE, slug, agent!.id, secretKey, false),
  };
}

/** Replaces the active rule set. Supersedes rather than deletes: a trace citing
 *  a rule pins it (traces.rule_fired_id has no ON DELETE), so deleting fails
 *  with a foreign key violation once anything has been decided. */
async function onlyRules(merchantId: string, rules: { type: string; name: string; params: Json }[]) {
  const { error: retire } = await db
    .from("policy_rules")
    .update({ status: "superseded" })
    .eq("merchant_id", merchantId)
    .eq("status", "active");
  if (retire) throw new Error(retire.message);
  if (rules.length === 0) return;
  const { error } = await db.from("policy_rules").insert(
    rules.map((r) => ({
      merchant_id: merchantId,
      type: r.type as never,
      name: r.name,
      params: r.params,
      status: "active" as never,
      source: "human" as never,
      rationale: "verify-mrtr",
    }))
  );
  if (error) throw new Error(error.message);
}

const buy = (sku: string, amount: number, category: string) => ({
  actionType: "order.create",
  amount,
  currency: "INR",
  category,
  params: { receipt: `mrtr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, notes: { sku } },
});

async function enforceTraceCount(merchantId: string): Promise<number> {
  const { count } = await db
    .from("traces")
    .select("*", { count: "exact", head: true })
    .eq("merchant_id", merchantId)
    .eq("mode", "enforce");
  return count ?? 0;
}

async function main() {
  const A = await makeTenant("a");
  const B = await makeTenant("b");
  console.log(`tenant A ${A.slug}\ntenant B ${B.slug}\n`);

  try {
    const catalog = await fetchCatalog(db, A.id);
    const mouse = catalog.find((c) => c.sku === "mouse-01")!;

    // No rules at all: the parent clears, so a counter-offer is possible and
    // nothing else can explain an outcome.
    await onlyRules(A.id, []);

    // ---- 1. POST #1 offers, and moves nothing.
    const before = await enforceTraceCount(A.id);
    const offerRes = await A.buyer.callOnce("enforce_action", buy(mouse.sku, mouse.priceInPaise, mouse.category));
    const offered = offerRes.resultType === "input_required";
    check("POST #1 returns an input_required result", offered, offerRes.resultType ?? "(plain result)");

    if (!offered) {
      console.log("\nNo counter-offer was produced, so the MRTR cases below cannot run.");
      console.log("That usually means the model found no complement — try re-running.");
    } else {
      // Control first: "no Razorpay call" is trivially true if nothing ran.
      const after = await enforceTraceCount(A.id);
      check(
        "POST #1 wrote no enforce trace and no Razorpay call",
        after === before,
        `enforce traces ${before} -> ${after}`
      );

      const { data: simTraces } = await db
        .from("traces")
        .select("id, mode, razorpay_response, params")
        .eq("merchant_id", A.id)
        .eq("mode", "simulate")
        .order("created_at", { ascending: false })
        .limit(1);
      const marker = (simTraces?.[0]?.params as { mrtr?: string } | null)?.mrtr;
      check("the offer is recorded as an input_required trace", marker === "input_required", marker ?? "(none)");
      check(
        "that trace carries no Razorpay response",
        simTraces?.[0]?.razorpay_response == null,
        String(simTraces?.[0]?.razorpay_response)
      );

      // ---- 7. It consumed no velocity budget. Asserted on the count itself,
      //         not on a downstream decision that could be right by accident.
      const { count: velocityCountable } = await db
        .from("traces")
        .select("*", { count: "exact", head: true })
        .eq("merchant_id", A.id)
        .eq("mode", "enforce");
      check(
        "an input_required trace consumes no velocity budget",
        (velocityCountable ?? 0) === before,
        `${velocityCountable} enforce-mode traces, unchanged`
      );

      const state = offerRes.requestState!;

      // ---- 2. THE invariant. A cap that did not exist during POST #1 is
      //         installed before POST #2. If the retry resumed a cached
      //         decision it would still execute; it must not.
      await onlyRules(A.id, [
        {
          type: "cap",
          name: "Installed between the two posts",
          params: { max_amount: 1, currency: "INR", scope: "per_transaction" } as Json,
        },
      ]);
      const retried = await A.buyer.callOnce(
        "enforce_action",
        buy(mouse.sku, mouse.priceInPaise, mouse.category),
        { inputResponses: { counter_offer: { action: "accept", content: { accept: true } } }, requestState: state }
      );
      const retryOutcome = MandateClient.unwrap<Outcome>(retried, "enforce_action");
      check(
        "POST #2 re-runs the engine (cap changed between posts)",
        retryOutcome.decision === "block",
        `${retryOutcome.decision} — ${retryOutcome.reasoning.slice(0, 44)}`
      );
      check(
        "a re-decided refusal executed nothing",
        retryOutcome.razorpayResponse == null,
        String(retryOutcome.razorpayResponse)
      );

      // ---- 3. Re-entry guard. Same sealed state, posted again. The unique
      //         index must stop it becoming a second logical purchase.
      //
      //         Asserting only "one trace carries an offer id" was too weak:
      //         that also holds if the replay quietly took some other path and
      //         wrote nothing. So the replay's own outcome is inspected — it
      //         has to be refused, and it must not have executed.
      await onlyRules(A.id, []);
      const replay = await A.buyer
        .callOnce("enforce_action", buy(mouse.sku, mouse.priceInPaise, mouse.category), {
          inputResponses: { counter_offer: { action: "accept", content: { accept: true } } },
          requestState: state,
        })
        .then((r) => ({ threw: false, result: r }))
        .catch((e) => ({ threw: true, result: e instanceof Error ? e.message : String(e) }));

      const replayRefused =
        replay.threw || (typeof replay.result !== "string" && replay.result.isError === true);
      const { count: offerIdUses } = await db
        .from("traces")
        .select("*", { count: "exact", head: true })
        .eq("merchant_id", A.id)
        .not("params->>offer_id", "is", null);
      check(
        "replaying a consumed offer is refused outright",
        replayRefused,
        replay.threw ? "threw" : "isError result"
      );
      check(
        "the same offer id exists on exactly one trace",
        (offerIdUses ?? 0) === 1,
        `${offerIdUses} trace(s)`
      );

      // ---- 6. A's answers and state, replayed against B's endpoint. Fails at
      //         verification: B does not know A's keyid.
      const crossClient = new MandateClient(BASE, B.slug, A.agentId, A.secret, true);
      const crossBlocked = await crossClient
        .callOnce("enforce_action", buy(mouse.sku, mouse.priceInPaise, mouse.category), {
          inputResponses: { counter_offer: { action: "accept", content: { accept: true } } },
          requestState: state,
        })
        .then(() => false)
        .catch(() => true);
      check("A's answers replayed against B fail at verification", crossBlocked, "401 before any policy ran");
    }

    // ---- 4. An accepted offer that breaches a cap is refused while the parent
    //         still executes.
    //
    //         The first attempt at this test capped at the parent's price and
    //         asserted "child did not clear" — which passed while producing NO
    //         OFFER AT ALL, because findCounterOffer only surfaces candidates
    //         that currently clear. It was satisfied by the path never running.
    //
    //         The path is only reachable when state moves between the posts,
    //         which is the same invariant case as above: offer with no cap so a
    //         complement clears, then install a cap that stops the child and
    //         not the parent, then accept.
    await onlyRules(A.id, []);
    const gate1 = await A.buyer.callOnce(
      "enforce_action",
      buy(mouse.sku, mouse.priceInPaise, mouse.category)
    );

    if (gate1.resultType !== "input_required") {
      check("an accepted offer over a new cap is refused, parent still executes", false, "no offer produced");
    } else {
      // Between the posts: a ceiling above the mouse but below anything dearer.
      await onlyRules(A.id, [
        {
          type: "cap",
          name: "Parent clears, complement does not",
          params: { max_amount: mouse.priceInPaise, currency: "INR", scope: "per_transaction" } as Json,
        },
      ]);
      const gated = MandateClient.unwrap<Outcome>(
        await A.buyer.callOnce("enforce_action", buy(mouse.sku, mouse.priceInPaise, mouse.category), {
          inputResponses: { counter_offer: { action: "accept", content: { accept: true } } },
          requestState: gate1.requestState!,
        }),
        "enforce_action"
      );
      const child = gated.counterOffer?.child;
      check(
        "an accepted offer over a new cap is refused, parent still executes",
        gated.decision === "allow" && !!child && child.decision !== "allow",
        `parent ${gated.decision}, child ${child?.decision ?? "(none evaluated)"}`
      );
      check(
        "the refused child moved no money",
        !!child && child.razorpayResponse == null,
        String(child?.razorpayResponse)
      );
    }

    // ---- 8. Declining leaves exactly one executed action and no orphan child.
    await onlyRules(A.id, []);
    const beforeDecline = await enforceTraceCount(A.id);
    const declined = await A.buyer.callTool<Outcome>(
      "enforce_action",
      buy(mouse.sku, mouse.priceInPaise, mouse.category),
      async () => ({ counter_offer: { action: "decline" } })
    );
    const afterDecline = await enforceTraceCount(A.id);
    check(
      "declining executes the parent alone",
      declined.decision === "allow" && afterDecline - beforeDecline === 1,
      `${afterDecline - beforeDecline} enforce trace(s) added`
    );
    const { count: orphans } = await db
      .from("traces")
      .select("*", { count: "exact", head: true })
      .eq("merchant_id", A.id)
      .eq("parent_trace_id", declined.traceId);
    check("a declined offer leaves no child action", (orphans ?? 0) === 0, `${orphans} child trace(s)`);

    // ---- 9. A client that declares no elicitation still transacts, and is
    //         given the same pre-cleared candidate as a suggestion.
    const plain = await A.plain.callTool<Outcome>(
      "enforce_action",
      buy(mouse.sku, mouse.priceInPaise, mouse.category)
    );
    check(
      "a non-elicitation client still transacts",
      plain.decision === "allow" && plain.razorpayResponse != null,
      plain.decision
    );
    check(
      "and receives suggestions on the ordinary result",
      Array.isArray(plain.suggestions) && plain.suggestions.length > 0,
      plain.suggestions?.map((s) => s.sku).join(",") ?? "(none)"
    );

    // ---- 5. A tampered retry dies at the protocol layer, before policy.
    const beforeForged = await enforceTraceCount(A.id);
    const tampered = await A.buyer.sendTamperedRequest();
    const afterForged = await enforceTraceCount(A.id);
    const { data: reject } = await db
      .from("traces")
      .select("decision")
      .eq("merchant_id", A.id)
      .eq("decision", "protocol_reject")
      .order("created_at", { ascending: false })
      .limit(1);
    check(
      "a tampered request is rejected before any policy runs",
      tampered.status === 401 && reject?.[0]?.decision === "protocol_reject",
      `HTTP ${tampered.status}, +${afterForged - beforeForged} money action(s)`
    );
  } finally {
    await db.from("merchants").delete().in("id", [A.id, B.id]);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  for (const f of failed) console.log(`  FAILED: ${f.name} — ${f.detail}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
