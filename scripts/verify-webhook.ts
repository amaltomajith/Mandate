/**
 * The Razorpay webhook: signature, idempotency, sales, and payout failures.
 * Needs the dev server.
 *
 *   npx tsx --tsconfig worker/tsconfig.json scripts/verify-webhook.ts
 */
import "./lib/loadEnv";
import { createHmac, randomUUID } from "node:crypto";
import { createAdminClient } from "../src/lib/supabase/admin";
import { ensureWorkspace } from "../src/lib/workspace";
import { encryptJson } from "../src/lib/secrets";
import { walletBalancePaise } from "../src/lib/ledger";

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

const SECRET = "whsec_test_" + randomUUID();
const sign = (body: string, secret = SECRET) => createHmac("sha256", secret).update(body).digest("hex");

async function post(slug: string, payload: unknown, opts: { secret?: string; eventId?: string; skipSig?: boolean } = {}) {
  const body = JSON.stringify(payload);
  const res = await fetch(`${BASE}/api/webhooks/razorpay/${slug}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(opts.skipSig ? {} : { "x-razorpay-signature": sign(body, opts.secret) }),
      "x-razorpay-event-id": opts.eventId ?? randomUUID(),
    },
    body,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function main() {
  const rnd = Math.random().toString(36).slice(2, 8);
  const { data: m, error } = await db.from("merchants").insert({ name: "Verify hook", slug: `verify-hook-${rnd}` }).select("*").single();
  if (error) throw new Error(error.message);
  try {
    await ensureWorkspace(db, m.id);
    await db.from("connections").insert({
      merchant_id: m.id,
      kind: "razorpay",
      status: "connected",
      secret_enc: encryptJson({ key_id: "rzp_test_x", key_secret: "x", webhook_secret: SECRET }),
    });

    const captured = (paymentId: string) => ({
      event: "payment.captured",
      payload: { payment: { entity: { id: paymentId, order_id: "order_1", amount: 179800, notes: { items: "mouse-01x2" } } } },
    });

    console.log("authentication");
    const bad = await post(m.slug, captured("pay_bad"), { secret: "wrong" });
    check("a wrong signature is rejected", bad.status === 401);
    const none = await post(m.slug, captured("pay_none"), { skipSig: true });
    check("a missing signature is rejected", none.status === 401);
    const ghost = await post("no-such-merchant", captured("pay_ghost"));
    check("an unknown merchant gets the same answer", ghost.status === 401);
    const { data: nothing } = await db.from("sales").select("id").eq("merchant_id", m.id);
    check("nothing was booked by any of those", (nothing ?? []).length === 0);

    console.log("a captured payment");
    const before = (await db.from("products").select("stock_qty").eq("merchant_id", m.id).eq("sku", "mouse-01").single()).data!.stock_qty;
    const eventId = randomUUID();
    const ok = await post(m.slug, captured("pay_one"), { eventId });
    check("a valid capture is accepted and booked", ok.status === 200 && ok.json.booked === true, JSON.stringify(ok.json));
    const { data: sales } = await db.from("sales").select("*").eq("merchant_id", m.id);
    check("one sale for the right product and amount", (sales ?? []).length === 1 && sales![0].qty === 2 && Number(sales![0].amount_paise) === 179800);
    const after = (await db.from("products").select("stock_qty").eq("merchant_id", m.id).eq("sku", "mouse-01").single()).data!.stock_qty;
    check("stock came off the shelf", after === before - 2, `${before} -> ${after}`);
    check("the wallet was credited", (await walletBalancePaise(m.id)) === 179800);

    const dup = await post(m.slug, captured("pay_one"), { eventId });
    check("the same event delivered again is acknowledged and ignored", dup.status === 200 && dup.json.duplicate === true);
    const other = await post(m.slug, captured("pay_one"));
    check("the same payment under a new event id is still booked once", other.status === 200 && other.json.booked === false);
    check("so the wallet is unchanged", (await walletBalancePaise(m.id)) === 179800);

    console.log("payouts");
    const { data: vendor } = await db.from("vendors").insert({ merchant_id: m.id, name: "V", status: "approved" }).select("id").single();
    const { data: payee } = await db.from("payees").insert({ merchant_id: m.id, vendor_id: vendor!.id, kind: "bank", display_name: "V", masked_identifier: "••••0001", status: "active", approved_by: "t", approved_at: new Date().toISOString() }).select("id").single();
    const { data: po } = await db.from("purchase_orders").insert({ merchant_id: m.id, vendor_id: vendor!.id, status: "paid", total_paise: 100000, advance_paise: 50000 }).select("id").single();
    await db.from("payouts").insert({ merchant_id: m.id, payee_id: payee!.id, po_id: po!.id, amount_paise: 50000, status: "processing", razorpay_payout_id: "pout_live_1" });
    await db.from("wallet_entries").insert({ merchant_id: m.id, direction: "debit", amount_paise: 50000, kind: "payout", note: "t" });
    const balanceBefore = await walletBalancePaise(m.id);
    const failedPayout = await post(m.slug, { event: "payout.failed", payload: { payout: { entity: { id: "pout_live_1", status: "failed" } } } });
    check("a failed payout is accepted", failedPayout.status === 200);
    check("the money is returned to the wallet", (await walletBalancePaise(m.id)) === balanceBefore + 50000);
    const { data: poAfter } = await db.from("purchase_orders").select("status").eq("id", po!.id).single();
    check("the order goes back to draft", poAfter?.status === "draft", poAfter?.status);
    const { data: alerts } = await db.from("alerts").select("severity, message").eq("merchant_id", m.id);
    check("the merchant is alerted", (alerts ?? []).some((a) => a.severity === "high" && /payout/i.test(a.message)));
    const repeat = await post(m.slug, { event: "payout.failed", payload: { payout: { entity: { id: "pout_live_1", status: "failed" } } } });
    check("a repeat of the failure does not credit twice", repeat.status === 200 && (await walletBalancePaise(m.id)) === balanceBefore + 50000);
  } finally {
    await db.from("merchants").delete().eq("id", m.id);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
