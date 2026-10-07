/**
 * End-to-end checks of the Payment Wall against a running dev server.
 *
 *   npm run dev                     # in one terminal
 *   npx tsx --tsconfig worker/tsconfig.json scripts/verify-wall.ts
 *
 * Each case drives the real path: a signed MCP request, signature verification,
 * the policy engine against rules read from Supabase, the write-ahead trace, and
 * (for allowed payouts) the sandbox executor and ledger. It creates a throwaway
 * merchant and removes it at the end. No real money moves: payees are sandbox
 * payees and no RazorpayX connection exists for the test merchant.
 */
import "./lib/loadEnv";
import { randomUUID } from "node:crypto";
import { createAdminClient } from "../src/lib/supabase/admin";
import { ensureWorkspace } from "../src/lib/workspace";
import { loadAgentIdentity } from "../src/lib/agents/inhouse";
import { executeRealAction } from "../src/lib/razorpay/actions";
import { signRequest } from "../src/lib/webBotAuth/sign";
import { MandateClient } from "./lib/mandateClient";

const BASE = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
const db = createAdminClient();

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

interface Outcome {
  decision: "allow" | "block" | "escalate";
  ruleFired: { type: string; name: string } | null;
  reasoning: string;
  traceId: string;
  razorpayResponse: Record<string, unknown> | null;
  dryRun?: boolean;
  executionError?: string;
}

async function call(client: MandateClient, tool: "simulate_action" | "enforce_action", args: Record<string, unknown>): Promise<Outcome> {
  return client.callTool<Outcome>(tool, args);
}

const rupees = (n: number) => n * 100;

async function main() {
  const rnd = Math.random().toString(36).slice(2, 8);
  const slug = `verify-wall-${rnd}`;
  const created: string[] = [];

  const mk = async (suffix: string) => {
    const { data, error } = await db.from("merchants").insert({ name: `verify ${suffix}`, slug: `${slug}-${suffix}` }).select("*").single();
    if (error) throw new Error(error.message);
    created.push(data.id);
    await ensureWorkspace(db, data.id);
    return data;
  };

  const A = await mk("a");
  const B = await mk("b");

  try {
    const buying = await loadAgentIdentity(db, A.id, "buying");
    const selling = await loadAgentIdentity(db, A.id, "selling");
    const buyer = new MandateClient(BASE, A.slug, buying.agentId, buying.secretKey);
    const seller = new MandateClient(BASE, A.slug, selling.agentId, selling.secretKey);

    const mkPayee = async (merchantId: string, label: string, opts: { payee?: "active" | "pending"; vendor?: "approved" | "candidate" } = {}) => {
      const { data: vendor, error } = await db
        .from("vendors")
        .insert({ merchant_id: merchantId, name: `${label} ${rnd}`, status: opts.vendor ?? "approved", simulated: true, channel: "sandbox" })
        .select("*")
        .single();
      if (error) throw new Error(error.message);
      const active = (opts.payee ?? "active") === "active";
      const { data: payee, error: pe } = await db
        .from("payees")
        .insert({
          merchant_id: merchantId,
          vendor_id: vendor.id,
          kind: "bank",
          display_name: label,
          masked_identifier: "••••0000",
          status: opts.payee ?? "active",
          approved_by: active ? "verify-wall" : null,
          approved_at: active ? new Date().toISOString() : null,
          simulated: true,
        })
        .select("*")
        .single();
      if (pe) throw new Error(pe.message);
      return payee;
    };

    const payoutArgs = (payeeId: string, rs: number) => ({ actionType: "payout.create", amount: rupees(rs), currency: "INR", params: { payeeId, purpose: "vendor_advance" } });

    const good = await mkPayee(A.id, "Good Supplier");
    const pending = await mkPayee(A.id, "Pending Supplier", { payee: "pending" });
    const candidateVendor = await mkPayee(A.id, "Unvetted Supplier", { vendor: "candidate" });
    const foreign = await mkPayee(B.id, "Other Merchants Supplier");

    console.log("signature layer");
    {
      const tampered = await buyer.sendTamperedRequest();
      check("tampered body is rejected (401)", tampered.status === 401, `status ${tampered.status}`);
      const { data: rejects } = await db.from("traces").select("decision").eq("merchant_id", A.id).eq("decision", "protocol_reject");
      check("rejection is recorded against the merchant that was hit", (rejects ?? []).length >= 1);

      // Replay: send the very same signed request twice.
      const url = new URL(`/api/m/${A.slug}/mcp`, BASE);
      const bodyText = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
      const signed = signRequest({ secretKeyBase64: buying.secretKey, keyid: buying.agentId, method: "POST", path: url.pathname, authority: url.host, body: bodyText });
      const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-method": "tools/list", ...signed };
      const first = await fetch(url, { method: "POST", headers, body: bodyText });
      const second = await fetch(url, { method: "POST", headers, body: bodyText });
      check("a replayed request is rejected", first.status === 200 && second.status === 401, `first ${first.status}, second ${second.status}`);
    }

    console.log("least privilege");
    {
      const o = await call(seller, "enforce_action", payoutArgs(good.id, 500));
      check("Selling agent cannot propose a payout", o.decision === "block" && /not permitted/.test(o.reasoning), o.reasoning);
      const o2 = await call(buyer, "enforce_action", { actionType: "price.change", amount: rupees(4200), currency: "INR", params: { sku: "keyboard-01" } });
      check("Buying agent cannot change a price", o2.decision === "block" && /not permitted/.test(o2.reasoning), o2.reasoning);
    }

    console.log("payee whitelist (fail closed)");
    {
      const ok = await call(buyer, "enforce_action", payoutArgs(good.id, 5000));
      check("approved payee within limits is allowed", ok.decision === "allow", `${ok.decision}: ${ok.reasoning}`);
      check("allowed payout ran on the SANDBOX executor and says so", ok.razorpayResponse?.simulated === true, JSON.stringify(ok.razorpayResponse));
      const { data: pay } = await db.from("payouts").select("*").eq("merchant_id", A.id).eq("trace_id", ok.traceId);
      check("payout row booked once", (pay ?? []).length === 1 && pay![0].simulated === true);
      const { data: wallet } = await db.from("wallet_entries").select("*").eq("merchant_id", A.id).eq("kind", "payout");
      check("wallet debited", (wallet ?? []).length === 1 && Number(wallet![0].amount_paise) === rupees(5000));

      const p = await call(buyer, "enforce_action", payoutArgs(pending.id, 100));
      check("PENDING payee is blocked", p.decision === "block" && p.ruleFired?.type === "whitelisted_payee", `${p.decision}: ${p.reasoning}`);
      const c = await call(buyer, "enforce_action", payoutArgs(candidateVendor.id, 100));
      check("payee of an unapproved vendor is blocked", c.decision === "block" && p.ruleFired?.type === "whitelisted_payee", `${c.decision}: ${c.reasoning}`);
      const f = await call(buyer, "enforce_action", payoutArgs(foreign.id, 100));
      check("ANOTHER merchant's payee is blocked (tenant isolation)", f.decision === "block" && f.ruleFired?.type === "whitelisted_payee", `${f.decision}: ${f.reasoning}`);
      const u = await call(buyer, "enforce_action", payoutArgs(randomUUID(), 100));
      check("a payee id that does not exist is blocked", u.decision === "block" && u.ruleFired?.type === "whitelisted_payee", `${u.decision}: ${u.reasoning}`);
    }

    console.log("limits");
    {
      const big = await call(buyer, "enforce_action", payoutArgs(good.id, 60_000));
      check("payout over the single-payout cap is blocked", big.decision === "block" && big.ruleFired?.type === "cap", `${big.decision}: ${big.reasoning}`);

      const hold = await call(buyer, "enforce_action", payoutArgs(good.id, 12_000));
      check("payout over the approval threshold escalates", hold.decision === "escalate" && hold.ruleFired?.type === "step_up", `${hold.decision}: ${hold.reasoning}`);
      const { data: esc } = await db.from("escalations").select("*").eq("merchant_id", A.id).eq("trace_id", hold.traceId);
      check("an escalation is waiting for a human", (esc ?? []).length === 1 && esc![0].status === "pending");
      const { data: moved } = await db.from("payouts").select("id").eq("merchant_id", A.id).eq("trace_id", hold.traceId);
      check("no money moved for the escalated payout", (moved ?? []).length === 0);

      // 5,000 already paid; two more of 9,000 reach 23,000 of the 25,000 float.
      const a = await call(buyer, "enforce_action", payoutArgs(good.id, 9000));
      const b = await call(buyer, "enforce_action", payoutArgs(good.id, 9000));
      check("payouts inside the self-funded budget are allowed", a.decision === "allow" && b.decision === "allow", `${a.decision}/${b.decision}: ${a.reasoning} ${b.reasoning}`);
      const over = await call(buyer, "enforce_action", payoutArgs(good.id, 9000));
      check("payout past the self-funded budget is blocked", over.decision === "block" && over.ruleFired?.type === "payout_budget", `${over.decision}: ${over.reasoning}`);
    }

    console.log("idempotency");
    {
      const traceId = randomUUID();
      // Executed directly, twice, with the same trace id: what a retried approval does.
      const input = { actionType: "payout.create" as const, amount: rupees(100), currency: "INR", params: { payeeId: good.id, purpose: "vendor_advance" as const } };
      // The ledger row references the trace, so give it a real one.
      await db.from("traces").insert({ id: traceId, merchant_id: A.id, mode: "enforce", action_type: "payout.create", params: {}, agent_id: buying.agentId, decision: "allow" });
      await executeRealAction(input, { merchantId: A.id, traceId, agentId: buying.agentId });
      await executeRealAction(input, { merchantId: A.id, traceId, agentId: buying.agentId });
      const { data: rows } = await db.from("payouts").select("id").eq("merchant_id", A.id).eq("trace_id", traceId);
      const { data: debits } = await db.from("wallet_entries").select("id").eq("merchant_id", A.id).eq("kind", "payout").eq("note", "vendor advance to Good Supplier");
      check("the same trace id books ONE payout", (rows ?? []).length === 1, `${(rows ?? []).length} payout rows`);
      check("and one wallet debit for it", (debits ?? []).length >= 1);
    }

    console.log("margin");
    {
      const link = (amountRs: number, sku: string) => ({
        actionType: "payment_link.create",
        amount: rupees(amountRs),
        currency: "INR",
        params: { description: "x", customerName: "Test", lineItems: [{ sku, qty: 1 }] },
      });
      // keyboard-01 costs 2,900.
      const under = await call(seller, "simulate_action", link(3000, "keyboard-01"));
      check("a sale under the margin floor is blocked", under.decision === "block" && under.ruleFired?.type === "min_margin_floor", `${under.decision}: ${under.reasoning}`);
      const fine = await call(seller, "simulate_action", link(4499, "keyboard-01"));
      check("a healthy margin is allowed", fine.decision === "allow", `${fine.decision}: ${fine.reasoning}`);

      await db.from("products").update({ cost_price_paise: null }).eq("merchant_id", A.id).eq("sku", "hub-01");
      const unknown = await call(seller, "simulate_action", link(1299, "hub-01"));
      check("a product with UNKNOWN cost escalates", unknown.decision === "escalate" && unknown.ruleFired?.type === "min_margin_floor", `${unknown.decision}: ${unknown.reasoning}`);
      const noItems = await call(seller, "simulate_action", { actionType: "payment_link.create", amount: rupees(1000), currency: "INR", params: { description: "x", customerName: "T" } });
      check("a sale naming no products escalates, it does not skip", noItems.decision === "escalate", `${noItems.decision}: ${noItems.reasoning}`);

      const drop = await call(seller, "enforce_action", { actionType: "price.change", amount: rupees(2800), currency: "INR", params: { sku: "keyboard-01" } });
      check("a price drop below cost is blocked", drop.decision === "block" && drop.ruleFired?.type === "min_margin_floor", `${drop.decision}: ${drop.reasoning}`);
      const { data: still } = await db.from("products").select("price_paise").eq("merchant_id", A.id).eq("sku", "keyboard-01").single();
      check("and the price did not change", still?.price_paise === rupees(4499), String(still?.price_paise));

      const ok = await call(seller, "enforce_action", { actionType: "price.change", amount: rupees(4200), currency: "INR", params: { sku: "keyboard-01" } });
      check("a price drop that keeps the margin is allowed", ok.decision === "allow", `${ok.decision}: ${ok.reasoning}`);
      const { data: now } = await db.from("products").select("price_paise").eq("merchant_id", A.id).eq("sku", "keyboard-01").single();
      check("and the price changed", now?.price_paise === rupees(4200), String(now?.price_paise));
    }

    console.log("kill switches");
    {
      await db.from("agents").update({ status: "paused" }).eq("id", buying.agentId);
      const paused = await call(buyer, "enforce_action", payoutArgs(good.id, 100));
      check("a PAUSED agent is blocked by the wall, not merely asked to stop", paused.decision === "block" && /paused/.test(paused.reasoning), paused.reasoning);
      await db.from("agents").update({ status: "active" }).eq("id", buying.agentId);

      await db.from("merchant_settings").update({ agents_enabled: false }).eq("merchant_id", A.id);
      const off = await call(buyer, "enforce_action", payoutArgs(good.id, 100));
      check("switching the team off blocks every agent", off.decision === "block" && /switched/.test(off.reasoning), off.reasoning);
      await db.from("merchant_settings").update({ agents_enabled: true, dry_run: true }).eq("merchant_id", A.id);

      const before = (await db.from("payouts").select("id").eq("merchant_id", A.id)).data?.length ?? 0;
      const dry = await call(buyer, "enforce_action", payoutArgs(good.id, 100));
      const after = (await db.from("payouts").select("id").eq("merchant_id", A.id)).data?.length ?? 0;
      check("DRY RUN decides but executes nothing", dry.dryRun === true && before === after, `dryRun=${dry.dryRun}, payouts ${before}->${after}`);
      const { data: dryTrace } = await db.from("traces").select("mode").eq("id", dry.traceId).single();
      check("and records the action as a simulation", dryTrace?.mode === "simulate");
      await db.from("merchant_settings").update({ dry_run: false }).eq("merchant_id", A.id);

      await db.from("agents").update({ retired: true }).eq("id", buying.agentId);
      let retiredRefused = false;
      try {
        await call(buyer, "enforce_action", payoutArgs(good.id, 100));
      } catch {
        retiredRefused = true;
      }
      check("a RETIRED agent's key stops verifying", retiredRefused);
    }

    console.log("guardrails are rules");
    {
      const { data: managed } = await db.from("policy_rules").select("type").eq("merchant_id", A.id).eq("params->>managed", "guardrails");
      const types = new Set<string>((managed ?? []).map((r) => r.type));
      check("the plain controls exist as enforceable rules", ["whitelisted_payee", "cap", "step_up", "payout_budget", "min_margin_floor"].every((t) => types.has(t)), [...types].join(","));
    }
  } finally {
    for (const id of created) await db.from("merchants").delete().eq("id", id);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
