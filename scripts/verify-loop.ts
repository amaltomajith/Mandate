/**
 * The closed loop, end to end: slow stock is cleared to fund restocking.
 *
 * A merchant with a small starting float cannot afford the supplier's minimum
 * order for the bestseller, so the buying agent says so and waits. Money from
 * sales then raises the self-funded budget, and on the next pass the same agent
 * can afford it, orders it, and (because it is large) asks the merchant to
 * approve the advance. Needs the dev server and the database.
 *
 *   npx tsx --tsconfig worker/tsconfig.json scripts/verify-loop.ts
 */
import "./lib/loadEnv";
import { createAdminClient } from "../src/lib/supabase/admin";
import { ensureWorkspace } from "../src/lib/workspace";
import { loadSampleStore } from "../src/lib/sample";
import { applyGuardrails } from "../src/lib/policy/guardrails";
import { getSettings } from "../src/lib/settings";
import { recordCapturedPayment } from "../src/lib/sales";
import { approveEscalationCore } from "../src/lib/approvals";
import { walletBalancePaise } from "../src/lib/ledger";
import { tickMerchant } from "../worker/src/tick";

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

async function main() {
  const rnd = Math.random().toString(36).slice(2, 8);
  const { data: m, error } = await db.from("merchants").insert({ name: "Verify loop", slug: `verify-loop-${rnd}` }).select("*").single();
  if (error) throw new Error(error.message);
  try {
    await ensureWorkspace(db, m.id);
    await loadSampleStore(db, m.id);
    // A small float: Rs 20,000 to spend before any real sales. Everything else as
    // the sample store sets it.
    await db.from("merchant_settings").update({ starting_float_paise: 2_000_000 }).eq("merchant_id", m.id);
    await applyGuardrails(db, m.id, await getSettings(db, m.id));

    console.log("pass 1: the float is too small");
    // Selling first so that dead stock is marked down and the buyers are told.
    const t1 = await tickMerchant(db, m);
    check("the buying agent ran", t1.buying.status === "ok", JSON.stringify(t1.buying));
    const { data: pos1 } = await db.from("purchase_orders").select("id").eq("merchant_id", m.id);
    check("it could not afford the minimum order, so it placed none", (pos1 ?? []).length === 0, `${(pos1 ?? []).length} orders`);
    const { data: alerts1 } = await db.from("alerts").select("message").eq("merchant_id", m.id);
    check("and it said why, pointing at slow stock", (alerts1 ?? []).some((a) => /restock budget/i.test(a.message) && /slow stock/i.test(a.message)));
    const { data: payouts1 } = await db.from("payouts").select("id").eq("merchant_id", m.id);
    check("no money moved", (payouts1 ?? []).length === 0);

    console.log("the clearance sells");
    // Run the selling side until at least one payment link exists, then have the
    // sandbox buyers pay everything outstanding, plus a large wholesale sale so
    // the revenue is material.
    for (let i = 0; i < 6; i++) await tickMerchant(db, m);
    const { data: links } = await db.from("traces").select("id").eq("merchant_id", m.id).eq("action_type", "payment_link.create").eq("decision", "allow");
    check("payment links were created for the haggled deals", (links ?? []).length > 0, String((links ?? []).length));
    const { simulateSandboxPayment } = await import("../src/lib/sales");
    for (const l of links ?? []) await simulateSandboxPayment(db, m.id, l.id);
    const { data: bulk } = await db.from("products").select("sku").eq("merchant_id", m.id).eq("sku", "hub-01").single();
    await recordCapturedPayment(db, { merchantId: m.id, paymentId: `sim_pay_bulk_${rnd}`, amountPaise: 10_000_000, source: "payment_link", items: [{ sku: bulk!.sku, qty: 80 }], simulated: true });
    const wallet = await walletBalancePaise(m.id);
    check("the wallet holds what was earned", wallet >= 10_000_000, String(wallet));

    console.log("pass 2: sales have funded it");
    // Cooldown: the earlier "cannot afford" run must not block a retry.
    const t2 = await tickMerchant(db, m);
    check("the buying agent ran again", t2.buying.status === "ok", JSON.stringify(t2.buying));
    if (t2.buying.status === "ok") console.log("       summary:", t2.buying.summary);
    const { data: pos2 } = await db.from("purchase_orders").select("*").eq("merchant_id", m.id);
    check("it now places the order", (pos2 ?? []).length === 1, `${(pos2 ?? []).length} orders`);
    const po = pos2?.[0];
    const { data: payoutTrace } = await db.from("traces").select("id").eq("merchant_id", m.id).eq("action_type", "payout.create").eq("decision", "escalate").eq("mode", "enforce").limit(1).single();
    const { data: esc } = await db.from("escalations").select("*").eq("merchant_id", m.id).eq("status", "pending").eq("trace_id", payoutTrace!.id);
    check("the advance is large, so it waits for the merchant", po?.status === "awaiting_approval" && (esc ?? []).length === 1, `${po?.status}, ${(esc ?? []).length} pending for the payout`);
    check("and the advance fits inside what sales have earned plus the float", Number(po?.advance_paise ?? 0) <= 2_000_000 + 0.7 * wallet, String(po?.advance_paise));

    const before = await walletBalancePaise(m.id);
    await approveEscalationCore(db, m.id, esc![0].id, "verify-loop");
    const after = await walletBalancePaise(m.id);
    check("approving pays the supplier out of the wallet", before - after === Number(po!.advance_paise), `${before} -> ${after}`);
    await tickMerchant(db, m);
    const { data: done } = await db.from("purchase_orders").select("*").eq("id", po!.id).single();
    check("the supplier is told, and a delivery date is set", done?.confirmed_at !== null && done?.expected_at !== null);

    // Goods arrive: stock rises, and the bestseller is no longer flagged.
    const { data: line } = await db.from("po_lines").select("*").eq("po_id", po!.id).single();
    const { data: prod } = await db.from("products").select("stock_qty").eq("id", line!.product_id).single();
    await db.from("products").update({ stock_qty: prod!.stock_qty + line!.qty }).eq("id", line!.product_id);
    await db.from("purchase_orders").update({ status: "received", received_at: new Date().toISOString() }).eq("id", po!.id);
    const { getInventoryInsights } = await import("../src/lib/inventory");
    const ins = await getInventoryInsights(db, m.id, 1500);
    const kb = ins.find((i) => i.sku === "keyboard-01")!;
    check("once the goods arrive the bestseller is no longer running low", !kb.needsRestock && kb.status !== "low", `${kb.status}, stock ${kb.stockQty}`);
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
