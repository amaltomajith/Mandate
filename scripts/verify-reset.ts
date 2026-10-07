/**
 * The Settings reset against two throwaway merchants: it must clear exactly one
 * tenant's data and keep what it promises to keep. Needs the database only.
 *
 *   npx tsx --tsconfig worker/tsconfig.json scripts/verify-reset.ts
 */
import "./lib/loadEnv";
import { createAdminClient } from "../src/lib/supabase/admin";
import { ensureWorkspace } from "../src/lib/workspace";
import { loadSampleStore } from "../src/lib/sample";
import { encryptJson } from "../src/lib/secrets";
import { countResettableRows, resetEverythingFor, resetTransactionsFor } from "../src/lib/reset";

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

async function seed(merchantId: string) {
  await ensureWorkspace(db, merchantId);
  await loadSampleStore(db, merchantId);
  const { data: vendor } = await db.from("vendors").select("id").eq("merchant_id", merchantId).limit(1).single();
  const { data: product } = await db.from("products").select("id").eq("merchant_id", merchantId).limit(1).single();
  const { data: agent } = await db.from("agents").select("id").eq("merchant_id", merchantId).eq("kind", "buying").single();
  await db.from("agent_runs").insert({ merchant_id: merchantId, agent_id: agent!.id, kind: "buying", status: "ok", summary: "x" });
  const { data: thread } = await db.from("threads").insert({ merchant_id: merchantId, channel: "sandbox", kind: "vendor", counterparty: "x", vendor_id: vendor!.id }).select("id").single();
  await db.from("messages").insert({ merchant_id: merchantId, thread_id: thread!.id, direction: "in", body: "hi" });
  const { data: quote } = await db.from("quotes").insert({ merchant_id: merchantId, vendor_id: vendor!.id, product_id: product!.id, unit_price_paise: 100 }).select("id").single();
  const { data: po } = await db.from("purchase_orders").insert({ merchant_id: merchantId, vendor_id: vendor!.id, quote_id: quote!.id, total_paise: 100, advance_paise: 50 }).select("id").single();
  await db.from("po_lines").insert({ merchant_id: merchantId, po_id: po!.id, product_id: product!.id, qty: 1, unit_price_paise: 100 });
  await db.from("wallet_entries").insert({ merchant_id: merchantId, direction: "credit", amount_paise: 500, kind: "sale" });
  await db.from("alerts").insert({ merchant_id: merchantId, severity: "info", message: "x" });
  await db.from("connections").insert({ merchant_id: merchantId, kind: "gmail", status: "connected", account_label: "a@b.c", secret_enc: encryptJson({ refresh_token: "r", email: "a@b.c" }) });
  // Make the clearance state visible so a history reset has something to undo.
  await db.from("products").update({ compare_at_price_paise: 999999, last_sold_at: new Date().toISOString() }).eq("id", product!.id);
}

async function snapshot(merchantId: string) {
  const c = await countResettableRows(db, merchantId);
  return { ...c.transactions, ...c.preserved };
}

async function main() {
  const rnd = Math.random().toString(36).slice(2, 8);
  const mk = async (t: string) => (await db.from("merchants").insert({ name: `reset ${t}`, slug: `verify-reset-${t}-${rnd}` }).select("*").single()).data!;
  const A = await mk("a");
  const B = await mk("b");
  try {
    await seed(A.id);
    await seed(B.id);
    const bBefore = await snapshot(B.id);
    const aBefore = await snapshot(A.id);
    check("the setup has history to clear", aBefore.sales > 0 && aBefore.messages > 0 && aBefore.purchase_orders > 0 && aBefore.wallet_entries > 0);

    console.log("clear history");
    const preview = await countResettableRows(db, A.id);
    const counts = await resetTransactionsFor(db, A.id);
    check("the preview is the number that goes", counts.transactionsTotal === preview.transactionsTotal);
    const a1 = await snapshot(A.id);
    for (const t of ["messages", "threads", "agent_runs", "payouts", "wallet_entries", "sales", "po_lines", "purchase_orders", "quotes", "alerts", "traces"]) {
      check(`${t} is cleared`, a1[t] === 0, String(a1[t]));
    }
    for (const t of ["agents", "policy_rules", "products", "vendors", "payees", "customers", "connections"]) {
      check(`${t} survive`, a1[t] === aBefore[t], `${aBefore[t]} -> ${a1[t]}`);
    }
    const { data: prod } = await db.from("products").select("compare_at_price_paise, last_sold_at").eq("merchant_id", A.id);
    check("clearance prices and last-sold dates are reset with the history", (prod ?? []).every((p) => p.compare_at_price_paise === null && p.last_sold_at === null));
    const { data: agents } = await db.from("agents").select("trust_score").eq("merchant_id", A.id);
    check("trust returns to the baseline", (agents ?? []).every((a) => Number(a.trust_score) === 50));
    const b1 = await snapshot(B.id);
    check("the OTHER merchant is untouched", JSON.stringify(b1) === JSON.stringify(bBefore), JSON.stringify(b1));

    console.log("reset everything");
    await seed(A.id);
    await db.from("merchant_settings").update({ max_single_payout_paise: 123_00 }).eq("merchant_id", A.id);
    await db.from("agents").insert({ merchant_id: A.id, name: "Outside agent", public_key: "k", kind: "external" });
    await resetEverythingFor(db, A.id);
    const a2 = await snapshot(A.id);
    check("history is gone", a2.sales === 0 && a2.messages === 0 && a2.purchase_orders === 0);
    check("suppliers, payees and customers are gone", a2.vendors === 0 && a2.payees === 0 && a2.customers === 0);
    check("the starting catalog and rules are back", a2.products === 6 && a2.policy_rules >= 5, `${a2.products} products, ${a2.policy_rules} rules`);
    check("the connection survived", a2.connections === 1);
    const { data: kinds } = await db.from("agents").select("kind").eq("merchant_id", A.id);
    check("the two in-house agents survived and the outside one is gone", (kinds ?? []).length === 2 && !(kinds ?? []).some((k) => k.kind === "external"));
    const { data: st } = await db.from("merchant_settings").select("max_single_payout_paise").eq("merchant_id", A.id).single();
    check("settings are back to their defaults", Number(st?.max_single_payout_paise) === 5_000_000);
    const { data: managed } = await db.from("policy_rules").select("id").eq("merchant_id", A.id).eq("params->>managed", "guardrails");
    check("the guardrail rules were rebuilt", (managed ?? []).length === 6, String((managed ?? []).length));
    const b2 = await snapshot(B.id);
    check("the OTHER merchant is still untouched", JSON.stringify(b2) === JSON.stringify(bBefore));
  } finally {
    await db.from("merchants").delete().in("id", [A.id, B.id]);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
