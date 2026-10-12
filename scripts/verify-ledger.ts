/**
 * Ledger atomicity and concurrency. Each money movement that used to be several
 * separate writes (so a failure part-way lost or doubled money) is now one SQL
 * function, and these checks prove it: all-or-nothing, and exactly-once under
 * parallel calls. Database only.
 *
 *   npx tsx --tsconfig worker/tsconfig.json scripts/verify-ledger.ts
 */
import "./lib/loadEnv";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "../src/lib/supabase/admin";
import { ensureWorkspace } from "../src/lib/workspace";
import { walletBalancePaise } from "../src/lib/ledger";
import { recordCapturedPayment } from "../src/lib/sales";
import { getCooData } from "../src/lib/cooData";
import { cancelManualPayout, confirmManualPayout } from "../src/lib/manualPayouts";

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

async function count(table: string, merchantId: string, extra: Record<string, string> = {}) {
  let q = db.from(table).select("id", { count: "exact", head: true }).eq("merchant_id", merchantId);
  for (const [k, v] of Object.entries(extra)) q = q.eq(k, v);
  const { count: n } = await q;
  return n ?? 0;
}

async function main() {
  const rnd = Math.random().toString(36).slice(2, 8);
  const { data: m, error } = await db.from("merchants").insert({ name: "ledger", slug: `verify-ledger-${rnd}` }).select("*").single();
  if (error) throw new Error(error.message);
  const { data: other } = await db.from("merchants").insert({ name: "ledger other", slug: `verify-ledger-o-${rnd}` }).select("*").single();
  await ensureWorkspace(db, m.id);
  try {
    const { data: product } = await db.from("products").select("id, sku").eq("merchant_id", m.id).limit(1).single();
    const setStock = (n: number) => db.from("products").update({ stock_qty: n }).eq("id", product!.id);
    const stock = async () => Number((await db.from("products").select("stock_qty").eq("id", product!.id).single()).data!.stock_qty);
    const pay = (id: string, amount: number, qty = 1) =>
      recordCapturedPayment(db, { merchantId: m.id, paymentId: id, amountPaise: amount, source: "payment_link", items: [{ sku: product!.sku as string, qty }], simulated: true });

    console.log("booking a sale is all or nothing");
    await setStock(10);
    const bad = await db.rpc("book_captured_payment", {
      p_merchant: m.id,
      p_payment_id: `pay_bad_${rnd}`,
      p_order_id: null,
      p_source: "payment_link",
      p_amount: rupees(100),
      p_simulated: true,
      p_note: "x",
      p_rows: [{ product_id: product!.id, qty: 2, amount_paise: rupees(40) }],
    });
    check("lines that do not add up to the payment are refused", !!bad.error, JSON.stringify(bad.data));
    check("and leave no sale, no wallet credit, and the stock untouched", (await count("sales", m.id)) === 0 && (await walletBalancePaise(m.id)) === 0 && (await stock()) === 10);

    const ok = await pay(`pay_ok_${rnd}`, rupees(250), 3);
    check("a good payment is booked", ok.booked === true, JSON.stringify(ok));
    check("with the wallet credited once", (await walletBalancePaise(m.id)) === rupees(250));
    check("and the stock taken off the shelf", (await stock()) === 7, String(await stock()));
    const again = await pay(`pay_ok_${rnd}`, rupees(250), 3);
    check("the same payment again books nothing", again.booked === false);
    check("no second credit and no second decrement", (await walletBalancePaise(m.id)) === rupees(250) && (await stock()) === 7);

    console.log("booking in parallel");
    const same = await Promise.all(Array.from({ length: 6 }, () => pay(`pay_par_${rnd}`, rupees(100), 1)));
    check("six deliveries of one payment book it exactly once", same.filter((r) => r.booked).length === 1, JSON.stringify(same));
    check("one credit for it", (await walletBalancePaise(m.id)) === rupees(350), String(await walletBalancePaise(m.id)));
    await setStock(10);
    await Promise.all([pay(`pay_a_${rnd}`, rupees(10), 3), pay(`pay_b_${rnd}`, rupees(10), 3), pay(`pay_c_${rnd}`, rupees(10), 3)]);
    check("three parallel sales of 3 take 9 off a stock of 10, none lost", (await stock()) === 1, String(await stock()));
    await Promise.all([pay(`pay_d_${rnd}`, rupees(10), 5), pay(`pay_e_${rnd}`, rupees(10), 5)]);
    check("stock never goes below zero", (await stock()) === 0, String(await stock()));

    console.log("a payout that failed or came back");
    const mkPayout = async (status: string) => {
      const { data } = await db.from("payouts").insert({ merchant_id: m.id, amount_paise: rupees(500), status, razorpay_payout_id: `pout_${Math.random().toString(36).slice(2, 9)}` }).select("*").single();
      return data!;
    };
    const apply = (payoutId: string, status: string, merchantId = m.id) => db.rpc("apply_payout_status", { p_merchant: merchantId, p_razorpay_payout_id: payoutId, p_status: status });
    const before = await walletBalancePaise(m.id);
    const p1 = await mkPayout("processing");
    const r1 = await apply(p1.razorpay_payout_id, "failed");
    check("a failed payout is credited back to the wallet", !r1.error && (await walletBalancePaise(m.id)) === before + rupees(500), JSON.stringify(r1.error ?? r1.data));
    const r2 = await apply(p1.razorpay_payout_id, "reversed");
    check("a later reversal does not credit it again", (await walletBalancePaise(m.id)) === before + rupees(500), JSON.stringify(r2.data));
    const r3 = await apply(p1.razorpay_payout_id, "processed");
    check("a late 'processed' cannot undo it", (r3.data as { stale?: boolean })?.stale === true && (await walletBalancePaise(m.id)) === before + rupees(500));

    const p2 = await mkPayout("processing");
    await Promise.all([apply(p2.razorpay_payout_id, "failed"), apply(p2.razorpay_payout_id, "reversed"), apply(p2.razorpay_payout_id, "failed")]);
    check("failed and reversed arriving together credit exactly once", (await walletBalancePaise(m.id)) === before + rupees(1000), String(await walletBalancePaise(m.id)));
    const foreign = await apply(p2.razorpay_payout_id, "failed", other!.id);
    check("another merchant cannot touch it", (foreign.data as { found?: boolean })?.found === false);

    console.log("booking a payout that really went out");
    {
      const { data: v3 } = await db.from("vendors").insert({ merchant_id: m.id, name: `Rec Co ${rnd}`, status: "approved", channel: "sandbox", simulated: true }).select("id").single();
      const { data: pe3 } = await db.from("payees").insert({ merchant_id: m.id, vendor_id: v3!.id, kind: "bank", display_name: "Rec Co", masked_identifier: "••••0002", status: "active", approved_by: "v", approved_at: new Date().toISOString(), simulated: true }).select("id").single();
      const { data: po3 } = await db.from("purchase_orders").insert({ merchant_id: m.id, vendor_id: v3!.id, status: "approved", total_paise: rupees(900), advance_paise: rupees(400) }).select("id").single();
      const { data: tr } = await db.from("traces").insert({ merchant_id: m.id, mode: "enforce", action_type: "payout.create", params: {}, decision: "allow" }).select("id").single();
      const rec = () =>
        db.rpc("record_payout", { p_merchant: m.id, p_trace: tr!.id, p_payee: pe3!.id, p_po: po3!.id, p_amount: rupees(400), p_status: "processing", p_razorpay_payout_id: `pout_rec_${rnd}`, p_simulated: false, p_note: "advance to Rec Co" });
      const w1 = await walletBalancePaise(m.id);
      const results = await Promise.all([rec(), rec(), rec(), rec(), rec()]);
      check("five parallel bookings of one payout succeed without error", results.every((r) => !r.error), JSON.stringify(results.find((r) => r.error)?.error));
      check("exactly one reports it booked it", results.filter((r) => r.data === true).length === 1, results.map((r) => r.data).join(","));
      check("one payout row", (await count("payouts", m.id, { trace_id: tr!.id })) === 1);
      check("one wallet debit", (await walletBalancePaise(m.id)) === w1 - rupees(400), String((await walletBalancePaise(m.id)) - w1));
      const noWallet = await db.rpc("record_payout", { p_merchant: m.id, p_trace: null, p_payee: pe3!.id, p_po: po3!.id, p_amount: 0, p_status: "processing", p_razorpay_payout_id: "x", p_simulated: false, p_note: "bad" });
      check("a booking that cannot be completed leaves no payout row behind", !!noWallet.error && (await count("payouts", m.id, { razorpay_payout_id: "x" })) === 0, JSON.stringify(noWallet.error));
    }

    console.log("what is sent to the browser");
    {
      const { data: v4 } = await db.from("vendors").insert({ merchant_id: m.id, name: `Leak Co ${rnd}`, status: "approved", channel: "sandbox", simulated: true }).select("id").single();
      await db.from("payees").insert({ merchant_id: m.id, vendor_id: v4!.id, kind: "upi", display_name: "Leak Co", masked_identifier: "le••@okhdfc", details_enc: "CIPHERTEXT-MUST-NOT-LEAVE-THE-SERVER", status: "active", approved_by: "v", approved_at: new Date().toISOString(), simulated: false });
      const coo = await getCooData(db, m.id);
      const mine = coo.payees.filter((p) => p.display_name === "Leak Co");
      check("the payee is there for the dashboard", mine.length === 1);
      check("but its encrypted payment details are not", JSON.stringify(coo).includes("CIPHERTEXT-MUST-NOT-LEAVE-THE-SERVER") === false);
    }

    console.log("paying by hand, confirmed twice at once");
    const { data: vendor } = await db.from("vendors").insert({ merchant_id: m.id, name: `Ledger Co ${rnd}`, status: "approved", channel: "sandbox", simulated: true }).select("*").single();
    const { data: payee } = await db
      .from("payees")
      .insert({ merchant_id: m.id, vendor_id: vendor!.id, kind: "upi", display_name: "Ledger Co", masked_identifier: "le••@okhdfc", status: "active", approved_by: "v", approved_at: new Date().toISOString(), simulated: false })
      .select("id")
      .single();
    const { data: po } = await db.from("purchase_orders").insert({ merchant_id: m.id, vendor_id: vendor!.id, status: "approved", total_paise: rupees(2000), advance_paise: rupees(800) }).select("id").single();
    const { data: q } = await db
      .from("payouts")
      .insert({ merchant_id: m.id, po_id: po!.id, payee_id: payee!.id, amount_paise: rupees(800), status: "queued", manual: true, razorpay_payout_id: `manual_${rnd}` })
      .select("id")
      .single();
    const w0 = await walletBalancePaise(m.id);
    const confirms = await Promise.all([1, 2, 3, 4].map(() => confirmManualPayout(db, m.id, q!.id, "verify", "UTR 1")));
    check("four simultaneous confirmations succeed exactly once", confirms.filter((c) => c.confirmed).length === 1, JSON.stringify(confirms));
    check("the wallet is debited exactly once", (await walletBalancePaise(m.id)) === w0 - rupees(800), String(await walletBalancePaise(m.id)));
    const { data: poNow } = await db.from("purchase_orders").select("status").eq("id", po!.id).single();
    check("the order is paid", poNow?.status === "paid", poNow?.status);
    const { data: row } = await db.from("payouts").select("*").eq("id", q!.id).single();
    check("the payout records who, when and the reference", row?.status === "processed" && row.paid_ref === "UTR 1" && row.confirmed_by === "verify" && !!row.paid_at);
    const wrong = await confirmManualPayout(db, other!.id, q!.id, "attacker");
    check("another merchant cannot confirm it", wrong.confirmed === false);

    const { data: q2 } = await db.from("payouts").insert({ merchant_id: m.id, payee_id: payee!.id, amount_paise: rupees(100), status: "queued", manual: true, razorpay_payout_id: `manual2_${rnd}` }).select("id").single();
    const c1 = await Promise.all([confirmManualPayout(db, m.id, q2!.id, "verify"), cancelManualPayout(db, m.id, q2!.id, "verify")]);
    check("confirming and cancelling at once settles one way only", c1.filter((c) => c.confirmed).length === 1, JSON.stringify(c1));
  } finally {
    await db.from("merchants").delete().in("id", [m.id, other!.id]);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
