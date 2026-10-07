/**
 * Manual payout mode: the merchant pays suppliers from their own bank. Needs the
 * dev server (the payout really goes through the Payment Wall) and the database.
 *
 *   npx tsx --tsconfig worker/tsconfig.json scripts/verify-manual.ts
 */
import "./lib/loadEnv";
import { createAdminClient } from "../src/lib/supabase/admin";
import { ensureWorkspace } from "../src/lib/workspace";
import { loadAgentIdentity } from "../src/lib/agents/inhouse";
import { encryptJson } from "../src/lib/secrets";
import { walletBalancePaise } from "../src/lib/ledger";
import { getCooData } from "../src/lib/cooData";
import { cancelManualPayout, confirmManualPayout, getPayoutInstructions } from "../src/lib/manualPayouts";
import { MandateClient } from "./lib/mandateClient";
import { runAgent } from "../worker/src/runner";
import { runBuyingAgent } from "../worker/src/agents/buying";

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
const rupees = (n: number) => n * 100;

interface Outcome {
  decision: string;
  reasoning: string;
  razorpayResponse: { manual?: boolean; simulated?: boolean; status?: string } | null;
}

async function main() {
  const rnd = Math.random().toString(36).slice(2, 8);
  const mk = async (t: string) => {
    const { data, error } = await db.from("merchants").insert({ name: `manual ${t}`, slug: `verify-man-${t}-${rnd}` }).select("*").single();
    if (error) throw new Error(error.message);
    await ensureWorkspace(db, data.id);
    return data;
  };
  const A = await mk("a");
  const B = await mk("b");
  try {
    await db.from("merchant_settings").update({ payout_mode: "manual" }).eq("merchant_id", A.id);
    const buying = await loadAgentIdentity(db, A.id, "buying");
    const client = new MandateClient(BASE, A.slug, buying.agentId, buying.secretKey);
    const enforce = (args: Record<string, unknown>) => client.callTool<Outcome>("enforce_action", args);

    // A real supplier we message only through the sandbox, paid by hand by UPI.
    const { data: vendor } = await db
      .from("vendors")
      .insert({ merchant_id: A.id, name: `Hand Pay Co ${rnd}`, status: "approved", channel: "sandbox", simulated: true, email: "x@hand.sandbox.test" })
      .select("*")
      .single();
    const { data: payee } = await db
      .from("payees")
      .insert({
        merchant_id: A.id,
        vendor_id: vendor!.id,
        kind: "upi",
        display_name: "Hand Pay Co",
        masked_identifier: "su••@okhdfc",
        details_enc: encryptJson({ kind: "upi", vpa: "supplier@okhdfc" }),
        status: "active",
        approved_by: "verify",
        approved_at: new Date().toISOString(),
        simulated: false,
      })
      .select("*")
      .single();
    const { data: anyProduct } = await db.from("products").select("id").eq("merchant_id", A.id).limit(1).single();
    const mkPo = async (advanceRs: number) => {
      const po = (await db.from("purchase_orders").insert({ merchant_id: A.id, vendor_id: vendor!.id, status: "quoting", total_paise: rupees(advanceRs * 2), advance_paise: rupees(advanceRs) }).select("*").single()).data!;
      await db.from("po_lines").insert({ merchant_id: A.id, po_id: po.id, product_id: anyProduct!.id, qty: 10, unit_price_paise: rupees(advanceRs * 2) / 10 });
      return po;
    };
    const payout = (poId: string, rs: number) => ({ actionType: "payout.create", amount: rupees(rs), currency: "INR", params: { payeeId: payee!.id, poId, purpose: "vendor_advance" } });

    console.log("queueing");
    const po1 = await mkPo(8000);
    const out = await enforce(payout(po1.id, 8000));
    check("the wall clears the payout", out.decision === "allow", `${out.decision}: ${out.reasoning}`);
    check("but it is queued for the merchant, not sent", out.razorpayResponse?.manual === true && out.razorpayResponse?.status === "queued", JSON.stringify(out.razorpayResponse));
    const { data: rows } = await db.from("payouts").select("*").eq("merchant_id", A.id);
    check("one manual payout is waiting", rows?.length === 1 && rows[0].manual === true && rows[0].status === "queued" && rows[0].simulated === false);
    check("the wallet has NOT moved: no money has left", (await walletBalancePaise(A.id)) === 0);
    const { data: poNow } = await db.from("purchase_orders").select("status").eq("id", po1.id).single();
    check("the order is approved but not paid", poNow?.status === "approved", poNow?.status);
    const dup = await enforce(payout(po1.id, 8000));
    check("the same order cannot be queued twice", dup.decision === "block", `${dup.decision}: ${dup.reasoning}`);
    const coo = await getCooData(db, A.id);
    check("a queued payment already counts against the weekly budget", coo.kpis.paidOut7dPaise === rupees(8000), String(coo.kpis.paidOut7dPaise));

    console.log("the buying agent");
    const run = await runAgent(db, A, "buying", runBuyingAgent);
    check("the run completes", run.status === "ok", JSON.stringify(run));
    const { data: told } = await db.from("messages").select("id").eq("merchant_id", A.id).eq("direction", "out");
    check("the supplier is NOT told it was paid while the merchant has not paid", (told ?? []).length === 0);

    console.log("paying by hand");
    const ins = await getPayoutInstructions(db, A.id, rows![0].id);
    check("the merchant gets the details", ins.details?.vpa === "supplier@okhdfc" && ins.amountPaise === rupees(8000));
    check("with a UPI link carrying the amount and payee", !!ins.upiLink && ins.upiLink.startsWith("upi://pay?pa=supplier%40okhdfc") && ins.upiLink.includes("am=8000.00"), ins.upiLink ?? "");
    check("and a QR code for it", !!ins.qrDataUrl && ins.qrDataUrl.startsWith("data:image/png"));
    let crossTenant = false;
    try {
      await getPayoutInstructions(db, B.id, rows![0].id);
    } catch {
      crossTenant = true;
    }
    check("another merchant cannot read those details", crossTenant);
    await db.from("payees").update({ status: "revoked" }).eq("id", payee!.id);
    let revoked = false;
    try {
      await getPayoutInstructions(db, A.id, rows![0].id);
    } catch (e) {
      revoked = /revoked/.test(String(e));
    }
    check("a payee revoked since is not shown as one to pay", revoked);
    await db.from("payees").update({ status: "active" }).eq("id", payee!.id);

    let badRef = false;
    try {
      await confirmManualPayout(db, A.id, rows![0].id, "verify", "<script>alert(1)</script>");
    } catch {
      badRef = true;
    }
    check("a payment reference cannot carry markup", badRef);
    const wrongTenant = await confirmManualPayout(db, B.id, rows![0].id, "attacker");
    check("another merchant cannot confirm it", wrongTenant.confirmed === false);

    const done = await confirmManualPayout(db, A.id, rows![0].id, "verify", "UTR 4281 9921");
    check("the merchant confirms they paid", done.confirmed === true);
    const again = await confirmManualPayout(db, A.id, rows![0].id, "verify", "UTR 4281 9921");
    check("confirming twice does nothing the second time", again.confirmed === false);
    check("the wallet is debited exactly once", (await walletBalancePaise(A.id)) === -rupees(8000), String(await walletBalancePaise(A.id)));
    const { data: after } = await db.from("payouts").select("*").eq("id", rows![0].id).single();
    check("the payout records who, when and the reference", after?.status === "processed" && after.paid_ref === "UTR 4281 9921" && after.confirmed_by === "verify" && !!after.paid_at);
    const { data: poPaid } = await db.from("purchase_orders").select("status").eq("id", po1.id).single();
    check("the order is now paid", poPaid?.status === "paid");

    await runAgent(db, A, "buying", runBuyingAgent);
    const { data: told2 } = await db.from("messages").select("body").eq("merchant_id", A.id).eq("direction", "out");
    check("only now is the supplier told", (told2 ?? []).length >= 1);
    const { data: poDone } = await db.from("purchase_orders").select("confirmed_at").eq("id", po1.id).single();
    check("and the order is marked confirmed", poDone?.confirmed_at !== null);

    console.log("cancelling");
    const po2 = await mkPo(5000);
    const out2 = await enforce(payout(po2.id, 5000));
    check("another payout is queued", out2.razorpayResponse?.manual === true);
    const { data: q2 } = await db.from("payouts").select("id").eq("merchant_id", A.id).eq("status", "queued").single();
    const walletBefore = await walletBalancePaise(A.id);
    const cancelled = await cancelManualPayout(db, A.id, q2!.id, "verify");
    check("the merchant cancels it", cancelled.confirmed === true);
    check("nothing is booked", (await walletBalancePaise(A.id)) === walletBefore);
    const { data: po2Now } = await db.from("purchase_orders").select("status").eq("id", po2.id).single();
    check("the order goes back to draft", po2Now?.status === "draft", po2Now?.status);
    const cooAfter = await getCooData(db, A.id);
    check("the budget reservation is released", cooAfter.kpis.paidOut7dPaise === rupees(8000), String(cooAfter.kpis.paidOut7dPaise));
    const retry = await enforce(payout(po2.id, 5000));
    check("the order can be paid again afterwards", retry.decision === "allow" && retry.razorpayResponse?.manual === true, `${retry.decision}: ${retry.reasoning}`);

    console.log("sandbox payees stay sandbox");
    const { data: simVendor } = await db.from("vendors").insert({ merchant_id: A.id, name: `Sim ${rnd}`, status: "approved", channel: "sandbox", simulated: true }).select("*").single();
    const { data: simPayee } = await db
      .from("payees")
      .insert({ merchant_id: A.id, vendor_id: simVendor!.id, kind: "bank", display_name: "Sim", masked_identifier: "••••0000", status: "active", approved_by: "v", approved_at: new Date().toISOString(), simulated: true })
      .select("id")
      .single();
    const { data: simPo } = await db.from("purchase_orders").insert({ merchant_id: A.id, vendor_id: simVendor!.id, status: "quoting", total_paise: rupees(2000), advance_paise: rupees(1000) }).select("id").single();
    const sim = await enforce({ actionType: "payout.create", amount: rupees(1000), currency: "INR", params: { payeeId: simPayee!.id, poId: simPo!.id, purpose: "vendor_advance" } });
    check("a sandbox payee is never turned into a real task", sim.razorpayResponse?.simulated === true && !sim.razorpayResponse?.manual, JSON.stringify(sim.razorpayResponse));
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
