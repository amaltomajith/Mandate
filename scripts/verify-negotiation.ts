/**
 * No-lie negotiation. Every message to a supplier is checked against the
 * merchant's records before it can leave: a claim of a better offer must be
 * backed by a real, lower quote; amounts and percentages must match; another
 * supplier is never named; pressure that cannot be backed up is refused.
 * Checked at the claim checker, and through the real channels tool (the one door
 * an agent has to a supplier). Database only; nothing is sent anywhere real.
 *
 *   npx tsx --tsconfig worker/tsconfig.json scripts/verify-negotiation.ts
 */
import "./lib/loadEnv";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "../src/lib/supabase/admin";
import { ensureWorkspace } from "../src/lib/workspace";
import { ToolHub } from "../worker/src/lib/hub";
import { createChannelsServer } from "../worker/src/mcp/channels";
import { ChannelService } from "../worker/src/channels/service";
import { SandboxDriver } from "../worker/src/channels/sandbox";
import type { Channel } from "../src/types/db";
import type { ChannelDriver } from "../worker/src/channels/types";
import { amountsPaise, checkClaims, checkOutgoingClaims, type ClaimTruth } from "../worker/src/agents/claims";
import { bestAndFinalMessage, rfqMessage } from "../worker/src/agents/messages";
import { simulateReplies } from "../worker/src/sandbox/counterparties";

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
  console.log("amounts");
  {
    check("rupee amounts are read in the usual forms", JSON.stringify(amountsPaise("₹2,600 and Rs 1900 and Rs. 1,250.50 and INR 300")) === JSON.stringify([260000, 190000, 125050, 30000]));
    check("a quantity is not an amount", amountsPaise("order 2600 units").length === 0);
  }

  console.log("the claim checker");
  {
    const truth: ClaimTruth = { ownQuotePaise: rupees(2600), competitorLowestPaise: rupees(2300), otherVendorNames: ["Bharat Office Supplies", "Delhi Gadget Wholesale"], ownName: "Kumar Traders" };
    const honest = "We have received a lower quote of ₹2,300 per unit for the same product. Can you match it?";
    check("a true claim of a lower quote passes", checkClaims(honest, truth).ok);
    check("with no competing quote at all, the same claim is refused", !checkClaims(honest, { ...truth, competitorLowestPaise: null }).ok);
    const bluff = "Another supplier offered us ₹1,800 per unit.";
    const r = checkClaims(bluff, truth);
    check("a made-up lower price is refused", !r.ok && r.problems.some((p) => /not a price on record/.test(p)), JSON.stringify(r));
    check("a claim of a better offer is refused when the real quote is not lower than theirs", !checkClaims(honest, { ...truth, competitorLowestPaise: rupees(2700) }).ok);
    check("a true percentage passes", checkClaims("We have a cheaper quote, about 12% lower: ₹2,300 against your ₹2,600.", truth).ok);
    const wrongPct = checkClaims("We have a cheaper quote, 30% lower: ₹2,300 against your ₹2,600.", truth);
    check("an inflated percentage is refused", !wrongPct.ok && wrongPct.problems.some((p) => /30%/.test(p)), JSON.stringify(wrongPct));
    check("naming another supplier is refused", !checkClaims("Bharat Office Supplies quoted lower, match ₹2,300?", truth).ok);
    check("naming the supplier's own name is fine", checkClaims("Hello Kumar Traders, please quote 40 units.", truth).ok);
    check("a supplier whose name contains the other's is not mistaken for naming it", checkClaims("Hello Kumar Traders Delhi, please quote.", { ...truth, ownName: "Kumar Traders Delhi", otherVendorNames: ["Kumar Traders"] }).ok);
    for (const p of ["We have already ordered from someone else.", "This is today only.", "Last chance to match.", "Our offer expires tonight."]) check(`pressure is refused: "${p}"`, !checkClaims(p, truth).ok);
    check("an ordinary quote request passes", checkClaims("Could you tell us your price per unit, minimum order and delivery time?", truth).ok);
    check("our own offer is not a claim about anyone else", checkClaims("We can pay ₹2,000 per unit if you can do 50 units.", truth).ok);
    check("a past accepted price may be mentioned when it is on record", checkClaims("We have a lower quote of ₹2,300. We last bought at ₹2,100.", { ...truth, knownAmountsPaise: [rupees(2100)] }).ok);
    check("but not when it is not", !checkClaims("We have a lower quote of ₹2,300. We last bought at ₹2,100.", truth).ok);
  }

  console.log("the messages the agent writes pass their own check");
  {
    const truth: ClaimTruth = { ownQuotePaise: rupees(2600), competitorLowestPaise: rupees(2300), otherVendorNames: ["Bharat Office Supplies"], ownName: "Kumar Traders" };
    const bafo = bestAndFinalMessage({ vendor: "Kumar Traders", store: "Demo Store", name: "Keyboard", ownPaise: rupees(2600), bestPaise: rupees(2300) });
    check("the best-and-final template is true and passes", checkClaims(bafo.text, truth).ok, bafo.text);
    check("it names no one", !/Bharat/.test(bafo.text) && /do not share who/.test(bafo.text));
    check("and carries the real figure", bafo.text.includes("₹2,300") && bafo.text.includes("₹2,600"));
    check("the same template is refused when there is no such quote", !checkClaims(bafo.text, { ...truth, competitorLowestPaise: null }).ok);
    const rfq = rfqMessage({ vendor: "Kumar Traders", store: "Demo Store", name: "Keyboard", sku: "keyboard-01", qty: 40 });
    check("a quote request passes", checkClaims(rfq.text, truth).ok);
  }

  console.log("the sandbox supplier answers a real benchmark");
  {
    const base = { kind: "rfq" as const, sku: "k", name: "Keyboard", qty: 40, listPricePaise: rupees(4499), counterparty: "Kumar Traders", round: 0 };
    const price = (txt: string) => Number((txt.match(/at ₹([\d,]+)/) ?? [])[1]?.replace(/,/g, "")) * 100;
    const first = price(simulateReplies(base)[0]);
    const after = price(simulateReplies({ ...base, benchmarkPaise: Math.round(first * 0.9) })[0]);
    check("asked to beat a lower real price, it comes in just under it", after < first && after >= Math.round(first * 0.9 * 0.99) - 100, `${first} -> ${after}`);
    const floor = price(simulateReplies({ ...base, benchmarkPaise: 100 })[0]);
    check("but never below half of retail", floor >= Math.round((rupees(4499) * 0.5) / 100) * 100 - 100, String(floor));
    const stubborn = price(simulateReplies({ ...base, counterparty: "Greedy", notes: "[sandbox:expensive]", benchmarkPaise: 1000 })[0]);
    check("a deliberately expensive supplier does not budge", stubborn > rupees(4000), String(stubborn));
  }

  const rnd = Math.random().toString(36).slice(2, 8);
  const { data: m } = await db.from("merchants").insert({ name: "negotiation", slug: `verify-neg-${rnd}` }).select("*").single();
  await ensureWorkspace(db, m.id);
  try {
    const { data: product } = await db.from("products").select("id, sku, name").eq("merchant_id", m.id).limit(1).single();
    await db.from("products").update({ price_paise: rupees(4000) }).eq("id", product!.id);
    const mkVendor = async (name: string) => (await db.from("vendors").insert({ merchant_id: m.id, name: `${name} ${rnd}`, status: "approved", channel: "sandbox", simulated: true, email: `${name.split(" ")[0].toLowerCase()}@${rnd}.sandbox.test` }).select("*").single()).data!;
    const A = await mkVendor("Alpha Traders");
    const B = await mkVendor("Beta Wholesale");
    const C = await mkVendor("Gamma Supplies");
    const quote = (vendor: string, paise: number, extra: Record<string, unknown> = {}) =>
      db.from("quotes").insert({ merchant_id: m.id, vendor_id: vendor, product_id: product!.id, unit_price_paise: paise, moq: 20, valid_until: new Date(Date.now() + 7 * 86_400_000).toISOString(), status: "open", ...extra });
    await quote(A.id, rupees(2600));
    await quote(B.id, rupees(2300));

    console.log("the truth is read from the records");
    {
      const t = await checkOutgoingClaims(db, m.id, A.id, product!.sku, "hello");
      check("this supplier's own quote and the lowest other quote are found", t.truth.ownQuotePaise === rupees(2600) && t.truth.competitorLowestPaise === rupees(2300), JSON.stringify(t.truth));
      check("other suppliers' names are known, its own is not among them", t.truth.otherVendorNames.length === 2 && !t.truth.otherVendorNames.includes(A.name));
      const none = await checkOutgoingClaims(db, m.id, A.id, undefined, "We have a lower quote of ₹2,300.");
      check("with no product to anchor it, a competitor claim is refused", !none.ok);
      await quote(C.id, rupees(1500), { via_voice: true, voice_confirmed_at: null });
      const draft = await checkOutgoingClaims(db, m.id, A.id, product!.sku, "x");
      check("an unconfirmed voice-note quote is not a real competing price", draft.truth.competitorLowestPaise === rupees(2300), String(draft.truth.competitorLowestPaise));
      await db.from("quotes").update({ voice_confirmed_at: new Date().toISOString() }).eq("vendor_id", C.id);
      const real = await checkOutgoingClaims(db, m.id, A.id, product!.sku, "x");
      check("once confirmed in writing, it is", real.truth.competitorLowestPaise === rupees(1500));
      await db.from("quotes").delete().eq("vendor_id", C.id);
      await db.from("quotes").update({ valid_until: new Date(Date.now() - 1000).toISOString() }).eq("vendor_id", B.id);
      const expired = await checkOutgoingClaims(db, m.id, A.id, product!.sku, "x");
      check("an expired quote is not a real competing price", expired.truth.competitorLowestPaise === null);
      await db.from("quotes").update({ valid_until: new Date(Date.now() + 7 * 86_400_000).toISOString() }).eq("vendor_id", B.id);
    }

    console.log("through the real channels tool");
    {
      const channels = new ChannelService(db, m.id, "sandbox", new Map<Channel, ChannelDriver>([["sandbox", new SandboxDriver()]]));
      const hub = new ToolHub();
      await hub.mountServer("channels", createChannelsServer({ db, merchantId: m.id }, channels));
      const send = (vendor_id: string, body: string, extra: Record<string, unknown> = {}) => hub.call("channels_send_message_to_vendor", { vendor_id, body, ...extra });
      const sentCount = async () => ((await db.from("messages").select("id").eq("merchant_id", m.id).eq("direction", "out")).data ?? []).length;

      const before = await sentCount();
      const bluff = await send(A.id, "Another supplier offered us ₹1,800 per unit. Beat it.", { sku: product!.sku, qty: 40 });
      check("a bluff is refused by the tool and nothing is sent", bluff.isError && /Not sent/.test(bluff.text) && (await sentCount()) === before, bluff.text);
      const named = await send(A.id, `${B.name} quoted ₹2,300, can you beat it?`, { sku: product!.sku, qty: 40 });
      check("naming the other supplier is refused", named.isError && (await sentCount()) === before, named.text);
      const noSku = await send(A.id, "We have a lower quote of ₹2,300. Beat it.");
      check("a competitor claim with no product is refused", noSku.isError && (await sentCount()) === before, noSku.text);

      const truthful = await send(A.id, "We have received a lower quote of ₹2,300 per unit for the same product. Can you match or beat it?", { sku: product!.sku, qty: 40 });
      check("the true version goes through", !truthful.isError && (await sentCount()) === before + 1, truthful.text);
      const parsed = JSON.parse(truthful.text) as { replies_received: number };
      check("and the sandbox supplier answers it", parsed.replies_received === 1);
      const { data: replies } = await db.from("messages").select("body").eq("merchant_id", m.id).eq("direction", "in").order("created_at", { ascending: false }).limit(1);
      const newPrice = Number((replies?.[0]?.body.match(/at ₹([\d,]+)/) ?? [])[1]?.replace(/,/g, ""));
      check("its answer beats the real benchmark, not a made-up one", newPrice > 0 && newPrice * 100 < rupees(2600) && newPrice * 100 <= rupees(2300), String(newPrice));

      const plain = await send(A.id, "Could you tell us your price per unit, minimum order and delivery time?", { sku: product!.sku, qty: 40 });
      check("an ordinary quote request is untouched", !plain.isError, plain.text);
      const offer = await send(A.id, "We can pay ₹2,000 per unit for 50 units.", { sku: product!.sku, qty: 50 });
      check("our own offer is untouched", !offer.isError, offer.text);
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
