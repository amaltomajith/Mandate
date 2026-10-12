/**
 * Concurrency on the money path. The wall reads what has been spent, decides,
 * and records; approvals do the same for held payouts. These checks hammer both
 * in parallel against one budget and expect it never to be overspent.
 * Runs the evaluator in-process, so no dev server is needed; the database is.
 *
 *   npx tsx --tsconfig worker/tsconfig.json scripts/verify-concurrency.ts
 */
import "./lib/loadEnv";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "../src/lib/supabase/admin";
import { ensureWorkspace } from "../src/lib/workspace";
import { loadAgentIdentity } from "../src/lib/agents/inhouse";
import { runActionEvaluation } from "../src/lib/mcp/tools/actionEvaluator";
import { approveEscalationCore } from "../src/lib/approvals";
import { applyGuardrails } from "../src/lib/policy/guardrails";
import { getSettings } from "../src/lib/settings";

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

async function main() {
  const rnd = Math.random().toString(36).slice(2, 8);
  const { data: m, error } = await db.from("merchants").insert({ name: "concurrency", slug: `verify-conc-${rnd}` }).select("*").single();
  if (error) throw new Error(error.message);
  await ensureWorkspace(db, m.id);
  try {
    const buying = await loadAgentIdentity(db as never, m.id, "buying");
    const { data: vendor } = await db.from("vendors").insert({ merchant_id: m.id, name: `Conc Co ${rnd}`, status: "approved", channel: "sandbox", simulated: true }).select("*").single();
    const { data: payee } = await db
      .from("payees")
      .insert({ merchant_id: m.id, vendor_id: vendor!.id, kind: "bank", display_name: "Conc Co", masked_identifier: "••••0000", status: "active", approved_by: "v", approved_at: new Date().toISOString(), simulated: true })
      .select("id")
      .single();
    const mkPo = async () => (await db.from("purchase_orders").insert({ merchant_id: m.id, vendor_id: vendor!.id, status: "quoting", total_paise: rupees(200_000), advance_paise: rupees(100_000) }).select("id").single()).data!.id as string;
    const payout = (poId: string, rs: number) => ({ actionType: "payout.create" as const, amount: rupees(rs), currency: "INR" as const, params: { payeeId: payee!.id, poId, purpose: "vendor_advance" as const } });
    const paid = async () => {
      const { data } = await db.from("payouts").select("amount_paise").eq("merchant_id", m.id).neq("status", "failed");
      return (data ?? []).reduce((n, r) => n + Number(r.amount_paise), 0);
    };
    const { data: settings } = await db.from("merchant_settings").select("starting_float_paise, approval_threshold_paise").eq("merchant_id", m.id).single();
    const budget = Number(settings!.starting_float_paise);
    console.log(`budget ${budget / 100}, approval threshold ${Number(settings!.approval_threshold_paise) / 100}`);

    console.log("the merchant lock holds across instances");
    {
      const tryLock = async (owner: string, ttl = 30) => (await db.rpc("acquire_merchant_lock", { p_merchant: m.id, p_owner: owner, p_ttl_seconds: ttl })).data === true;
      const release = (owner: string) => db.rpc("release_merchant_lock", { p_merchant: m.id, p_owner: owner });
      check("the first instance takes the lock", await tryLock("instance-a"));
      check("a second instance cannot while it is held", !(await tryLock("instance-b")));
      const racers = await Promise.all(Array.from({ length: 6 }, (_, i) => tryLock(`racer-${i}`)));
      check("six racing instances all fail while it is held", racers.every((r) => !r));
      await release("instance-b");
      check("a non-owner cannot release it", !(await tryLock("instance-c")));
      await release("instance-a");
      check("once released, another instance can take it", await tryLock("instance-b"));
      await release("instance-b");
      check("an expired lease (a crashed holder) can be taken over", (await tryLock("dead", 1)) && (await new Promise((r) => setTimeout(r, 1500)), await tryLock("instance-d")));
      await release("instance-d");
      const winners = await Promise.all(Array.from({ length: 8 }, (_, i) => tryLock(`w-${i}`)));
      check("of eight simultaneous attempts exactly one wins", winners.filter(Boolean).length === 1, winners.join(","));
    }

    console.log("parallel enforce against one budget");
    {
      const pos = await Promise.all(Array.from({ length: 6 }, () => mkPo()));
      // Each below the approval threshold, so they execute straight away; together they exceed the budget.
      const each = Math.floor(Number(settings!.approval_threshold_paise) / 100) - 500;
      const out = await Promise.all(pos.map((po) => runActionEvaluation(buying.agentId, payout(po, each), "enforce")));
      const allowed = out.filter((o) => o.decision === "allow").length;
      check("some are allowed and the rest are refused", allowed > 0 && allowed < 6, out.map((o) => o.decision).join(","));
      check("the total paid never exceeds the budget", (await paid()) <= budget, `${(await paid()) / 100} of ${budget / 100}`);
    }

    console.log("parallel approvals against one budget");
    {
      // Fresh merchant state: new payouts of 12,000 each escalate, none executes until approved.
      const { data: m2 } = await db.from("merchants").insert({ name: "concurrency 2", slug: `verify-conc2-${rnd}` }).select("*").single();
      await ensureWorkspace(db, m2.id);
      try {
        const buy2 = await loadAgentIdentity(db as never, m2.id, "buying");
        const { data: v2 } = await db.from("vendors").insert({ merchant_id: m2.id, name: `Conc2 ${rnd}`, status: "approved", channel: "sandbox", simulated: true }).select("*").single();
        const { data: p2 } = await db
          .from("payees")
          .insert({ merchant_id: m2.id, vendor_id: v2!.id, kind: "bank", display_name: "Conc2", masked_identifier: "••••0001", status: "active", approved_by: "v", approved_at: new Date().toISOString(), simulated: true })
          .select("id")
          .single();
        const budget2 = Number((await db.from("merchant_settings").select("starting_float_paise").eq("merchant_id", m2.id).single()).data!.starting_float_paise);
        const each = Math.floor(budget2 / 100 / 2) - 500; // two fit, three do not
        const poIds = await Promise.all(
          Array.from({ length: 4 }, async () => (await db.from("purchase_orders").insert({ merchant_id: m2.id, vendor_id: v2!.id, status: "quoting", total_paise: rupees(200_000), advance_paise: rupees(100_000) }).select("id").single()).data!.id as string)
        );
        // Lower the approval threshold so each of these is held for a person, not paid.
        await db.from("merchant_settings").update({ approval_threshold_paise: rupees(1000) }).eq("merchant_id", m2.id);
        await applyGuardrails(db, m2.id, await getSettings(db, m2.id));
        const held = [];
        for (const po of poIds) {
          const o = await runActionEvaluation(buy2.agentId, { actionType: "payout.create", amount: rupees(each), currency: "INR", params: { payeeId: p2!.id, poId: po, purpose: "vendor_advance" } }, "enforce");
          held.push(o);
        }
        const escalated = held.filter((o) => o.decision === "escalate");
        console.log(`  (${escalated.length} of ${held.length} payouts of ${each} were held; the rest: ${held.map((o) => o.decision).join(",")})`);
        if (escalated.length >= 3) {
          const escRows = await Promise.all(escalated.map(async (o) => (await db.from("escalations").select("id").eq("merchant_id", m2.id).eq("trace_id", o.traceId).single()).data!.id as string));
          const results = await Promise.allSettled(escRows.map((id) => approveEscalationCore(db, m2.id, id, "verify")));
          const ok = results.filter((r) => r.status === "fulfilled").length;
          const { data: rows } = await db.from("payouts").select("amount_paise").eq("merchant_id", m2.id);
          const total = (rows ?? []).reduce((n, r) => n + Number(r.amount_paise), 0);
          check("approving them all at once never exceeds the budget", total <= budget2, `paid ${total / 100} of ${budget2 / 100} (${ok} approvals went through)`);
        } else {
          check("the setup produced enough held payouts to test with", false, held.map((o) => `${o.decision}: ${o.reasoning}`).join(" | "));
        }
      } finally {
        await db.from("merchants").delete().eq("id", m2.id);
      }
    }
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
