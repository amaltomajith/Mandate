/**
 * Measures a model against this codebase's *actual* prompts.
 *
 * Model choice for a local setup usually gets made from a benchmark table
 * written by someone with different prompts and different hardware. That is
 * guesswork wearing a number. Every LLM call here has a hard, checkable
 * contract — parse as JSON, satisfy a Zod schema, and for the two shopping
 * tasks, name a SKU that genuinely exists in the catalog — so the honest way
 * to pick a model is to run the real code paths and count how often the
 * contract holds.
 *
 * It calls the real functions (`suggestCrossSell`, `interpretRequest`,
 * `runSemanticPolicyAudit`) rather than reimplementing their prompts, so what
 * is measured is what production does, including the grounding checks that
 * reject a hallucinated SKU.
 *
 * `draft_policy` goes through the live MCP endpoint instead of being imported:
 * its module is marked `server-only`, which throws under tsx. Routing it
 * through a signed MCP call is the more faithful measurement anyway — that is
 * exactly how an agent reaches it — but it does mean the dev server has to be
 * running for that one task.
 *
 * Usage:
 *   npx tsx scripts/bench-llm.ts                          # whatever is configured
 *   npx tsx scripts/bench-llm.ts --provider=local --model=granite4
 *   npx tsx scripts/bench-llm.ts --provider=groq           # off-box baseline
 *   npx tsx scripts/bench-llm.ts --runs=5
 *
 * A note on `--provider=groq`: that pin sends policy-sensitive prompts off-box
 * by design, and the client warns when it does. That is the correct behaviour
 * for a baseline measurement run deliberately by the developer against their
 * own data — it is not a way to route production traffic without noticing.
 */
import "./lib/loadEnv";

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"] as const;
  })
);
if (args.has("provider")) process.env.LLM_PROVIDER = args.get("provider")!;
if (args.has("model")) process.env.LOCAL_LLM_MODEL = args.get("model")!;
const RUNS = Number(args.get("runs") ?? 3);

import { createClient } from "@supabase/supabase-js";
import { fetchCatalog } from "../src/lib/demo/catalog";
import { suggestCrossSell } from "../src/lib/demo/crossSell";
import { interpretRequest } from "../src/lib/demo/shopper";
import { runSemanticPolicyAudit } from "../src/lib/policy/semanticAudit";
import { currentProvider, localAvailable } from "../src/lib/llm/client";
import { MandateClient } from "../src/lib/demo/mandateClient";
import { ensureAgentIdentity } from "../src/lib/demo/shared";
import type { PolicyRule } from "../src/types/db";
import { merchantForScript } from "./lib/merchant";

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

interface Outcome {
  ok: boolean;
  ms: number;
  note?: string;
  /** Set when the call never reached a model — no provider configured, dev
   *  server down, egress refused. A configuration problem is not a model
   *  failure, and scoring it as one would slander whichever model happened to
   *  be selected at the time. */
  infra?: boolean;
}

/** Distinguishes "the model got it wrong" from "the call never happened". */
function isInfraFailure(message: string): boolean {
  return /No local model is reachable|GROQ_API_KEY|ECONNREFUSED|fetch failed|LocalInferenceUnavailable/i.test(message);
}

interface TaskResult {
  task: string;
  contract: string;
  outcomes: Outcome[];
}

async function timed(fn: () => Promise<{ ok: boolean; note?: string }>): Promise<Outcome> {
  const t0 = Date.now();
  try {
    const { ok, note } = await fn();
    return { ok, ms: Date.now() - t0, note };
  } catch (err) {
    const message = err instanceof Error ? err.message : "threw";
    return { ok: false, ms: Date.now() - t0, note: message.slice(0, 70), infra: isInfraFailure(message) };
  }
}

function report(results: TaskResult[]) {
  console.log("");
  console.log("task              contract                        pass      p50      max   notes");
  console.log("─".repeat(100));
  for (const r of results) {
    const infra = r.outcomes.filter((o) => o.infra);
    const scored = r.outcomes.filter((o) => !o.infra);
    const times = r.outcomes.map((o) => o.ms).sort((a, b) => a - b);
    const p50 = times[Math.floor(times.length / 2)] ?? 0;
    const max = times[times.length - 1] ?? 0;

    if (scored.length === 0) {
      const why = infra[0]?.note ?? "no calls completed";
      console.log(`${r.task.padEnd(18)}${r.contract.padEnd(32)}${"SKIPPED".padEnd(10)}${"-".padEnd(9)}${"-".padEnd(8)} ${why}`);
      continue;
    }
    const pass = scored.filter((o) => o.ok).length;
    const notes = [...new Set(scored.filter((o) => !o.ok && o.note).map((o) => o.note))].slice(0, 1).join("");
    const rate = `${pass}/${scored.length}`;
    const skipped = infra.length > 0 ? ` (${infra.length} not reached)` : "";
    console.log(
      `${r.task.padEnd(18)}${r.contract.padEnd(32)}${rate.padEnd(10)}${String(p50 + "ms").padEnd(9)}${String(max + "ms").padEnd(8)} ${notes}${skipped}`
    );
  }
  console.log("");
  const scored = results.flatMap((r) => r.outcomes).filter((o) => !o.infra);
  const infra = results.flatMap((r) => r.outcomes).filter((o) => o.infra);
  console.log(`overall: ${scored.filter((o) => o.ok).length}/${scored.length} contracts held`);
  if (infra.length > 0) {
    console.log(`${infra.length} call(s) never reached a model — configuration, not model quality:`);
    for (const note of new Set(infra.map((o) => o.note))) console.log(`  · ${note}`);
  }
}

async function main() {
  console.log(`local reachable: ${await localAvailable(true)}`);
  console.log(`provider for public prompts:   ${await currentProvider("public")}`);
  console.log(`provider for internal prompts: ${await currentProvider("internal")}`);
  console.log(`model: ${process.env.LOCAL_LLM_MODEL ?? "granite4"} (local) · runs per case: ${RUNS}`);

  const merchant = await merchantForScript(db);
  const catalog = await fetchCatalog(db, merchant.id);
  const { data: ruleRows } = await db.from("policy_rules").select("*").eq("merchant_id", merchant.id).eq("status", "active");
  const rules = (ruleRows ?? []) as PolicyRule[];
  const skus = catalog.map((c) => c.sku);

  const results: TaskResult[] = [];

  // Cross-sell. The contract is a grounded SKU: a suggestion naming something
  // not in the catalog is already rejected by crossSell.ts, so it shows up
  // here as a miss rather than as a pass with bad data. `null` counts as a
  // miss too — it is valid output, but a cross-sell agent that declines is
  // worth nothing, and this benchmark exists partly to find out how often a
  // model declines.
  const crossSell: Outcome[] = [];
  for (let i = 0; i < RUNS; i++) {
    for (const sku of skus) {
      crossSell.push(
        await timed(async () => {
          const r = await suggestCrossSell(catalog, sku);
          if (!r) return { ok: false, note: "returned null (declined to suggest)" };
          if (!skus.includes(r.item.sku)) return { ok: false, note: "ungrounded sku" };
          return { ok: true };
        })
      );
    }
  }
  results.push({ task: "crossSell", contract: "grounded sku, not null", outcomes: crossSell });

  // Shopper intent. Each case has a known-correct answer, so this measures
  // comprehension, not just format: "something for my posture" has to reach
  // the laptop stand or the desk by reading descriptions, and the budget case
  // has to come back with a ceiling in paise.
  const shopperCases: { request: string; expect: (sku: string | null, max: number | null) => string | null }[] = [
    { request: "I need a mouse for my desk setup", expect: (s) => (s === "mouse-01" ? null : `got ${s}`) },
    { request: "a keyboard under 2000 rupees", expect: (s, m) => (m === 200000 ? null : `budget parsed as ${m}`) },
    {
      request: "something to improve my posture",
      expect: (s) => (s === "stand-01" || s === "desk-01" ? null : `got ${s}`),
    },
    { request: "buy me some bitcoin", expect: (s) => (s === null ? null : `should have declined, got ${s}`) },
  ];
  const shopper: Outcome[] = [];
  for (let i = 0; i < RUNS; i++) {
    for (const c of shopperCases) {
      shopper.push(
        await timed(async () => {
          const r = await interpretRequest(catalog, c.request);
          const sku = "item" in r ? r.item.sku : null;
          const problem = c.expect(sku, r.maxAmountPaise);
          return problem ? { ok: false, note: problem } : { ok: true };
        })
      );
    }
  }
  results.push({ task: "shopper", contract: "right item + budget", outcomes: shopper });

  // Semantic audit. Internal data. An empty issue list is a legitimate answer,
  // so the contract is only that it returned a well-formed array without
  // throwing — this measures whether the model can hold a schema over a real
  // rule set, not whether its judgment is good.
  const audit: Outcome[] = [];
  for (let i = 0; i < RUNS; i++) {
    audit.push(
      await timed(async () => {
        const issues = await runSemanticPolicyAudit(rules);
        return Array.isArray(issues) ? { ok: true } : { ok: false, note: "not an array" };
      })
    );
  }
  results.push({ task: "semanticAudit", contract: "valid issue array", outcomes: audit });

  // Policy drafting. The hardest contract here: freeform English has to become
  // a rule object the engine can actually execute, with the right type and
  // params. A wrong type is a hard fail — a "cap" where a "velocity" was asked
  // for is not a near miss.
  //
  // draftPolicy inserts a pending_review rule on every call, by design. That is
  // the real code path and worth measuring, so the benchmark runs it and then
  // deletes what it created. They are never active and so never affect a
  // decision, but leaving a dozen of them in the merchant's review queue after
  // a benchmark run would be its own kind of wrong.
  const draftCases: { text: string; type: string }[] = [
    { text: "Block any single order above twenty five thousand rupees", type: "cap" },
    { text: "No agent should be able to make more than 10 actions in a minute", type: "velocity" },
    { text: "Anything over eight thousand rupees needs me to approve it first", type: "step_up" },
  ];
  const draft: Outcome[] = [];
  const createdRuleIds: string[] = [];
  // Connecting is itself a thing that can fail, and a dev server that is not
  // running must not discard the three tasks that already completed. Treated
  // as an infrastructure outcome for every case, the same as any other call
  // that never reached a model.
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  let mcp: MandateClient | null = null;
  let mcpError: string | null = null;
  try {
    const { id: agentId, secretKeyBase64 } = await ensureAgentIdentity(db, merchant.id, {
      envIdVar: "SIM_AGENT_ID",
      envSecretVar: "SIM_AGENT_SECRET_KEY",
      name: "Checkout Agent",
      description: "An AI buyer agent transacting on behalf of customers.",
    });
    mcp = new MandateClient(baseUrl, merchant.slug, agentId, secretKeyBase64);
    await mcp.initialize("mandate-llm-benchmark");
  } catch (err) {
    mcpError = `dev server unreachable at ${baseUrl} — start it to measure draft_policy`;
    void err;
  }

  for (let i = 0; i < RUNS; i++) {
    for (const c of draftCases) {
      if (!mcp) {
        draft.push({ ok: false, ms: 0, note: mcpError ?? "no mcp client", infra: true });
        continue;
      }
      const client = mcp;
      draft.push(
        await timed(async () => {
          const r = await client.callTool<{ ruleId: string; type: string }>("draft_policy", { text: c.text });
          if (r.ruleId) createdRuleIds.push(r.ruleId);
          return r.type === c.type ? { ok: true } : { ok: false, note: `wanted ${c.type}, got ${r.type}` };
        })
      );
    }
  }
  results.push({ task: "draftPolicy", contract: "correct rule type", outcomes: draft });

  if (createdRuleIds.length > 0) {
    const { error } = await db.from("policy_rules").delete().in("id", createdRuleIds);
    console.log(
      error
        ? `WARNING: could not clean up ${createdRuleIds.length} benchmark draft rules: ${error.message}`
        : `cleaned up ${createdRuleIds.length} benchmark draft rules`
    );
  }

  report(results);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
