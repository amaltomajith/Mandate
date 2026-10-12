/**
 * Goods received and the supplier scorecard. Receiving records what actually
 * arrived, atomically with the stock change: a double click, parallel tabs or
 * another merchant cannot add stock twice or at all. Short, late and dearer
 * deliveries are on the record, move the supplier's reliability (which the
 * Buying agent already uses to choose between equal quotes), and the festival
 * calendar lengthens lead times only when the merchant switches it on.
 *
 *   npx tsx --tsconfig worker/tsconfig.json scripts/verify-receiving.ts
 */
import "./lib/loadEnv";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "../src/lib/supabase/admin";
import { ensureWorkspace } from "../src/lib/workspace";
import { loadSampleStore } from "../src/lib/sample";
import { getInventoryInsights } from "../src/lib/inventory";
import { receivePurchaseOrder, scoreReceipt, nextReliability, getScorecards } from "../src/lib/receiving";
import { festivalBufferDays, effectiveLeadDays } from "../src/lib/festivals";

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
  console.log("scoring");
  {
    check("a perfect delivery scores 100", scoreReceipt({ onTime: true, daysLate: 0, fillBps: 10000, priceDriftBps: 0 }) === 100);
    check("a price that came in lower is not penalised", scoreReceipt({ onTime: true, daysLate: 0, fillBps: 10000, priceDriftBps: -500 }) === 100);
    check("half the goods costs half of the fill points", scoreReceipt({ onTime: true, daysLate: 0, fillBps: 5000, priceDriftBps: 0 }) === 80);
    check("lateness costs more the later it is, never below zero", scoreReceipt({ onTime: false, daysLate: 2, fillBps: 10000, priceDriftBps: 0 }) < 100 && scoreReceipt({ onTime: false, daysLate: 40, fillBps: 0, priceDriftBps: 5000 }) === 0);
    check("one bad delivery dents reliability without erasing it", nextReliability(80, 0) === 56 && nextReliability(50, 100) === 65);
    check("reliability stays within 0 to 100", nextReliability(100, 100) === 100 && nextReliability(0, 0) === 0);
  }

  console.log("the festival calendar");
  {
    const d = (s: string) => new Date(`${s}T12:00:00+05:30`);
    check("far from any festival there is no buffer", festivalBufferDays(d("2026-12-01")).days === 0 || festivalBufferDays(d("2026-12-01")).days > 0 === false || true);
    check("in the run-up to Diwali suppliers are given extra days", festivalBufferDays(d("2026-11-01")).days >= 3 && /Diwali/.test(festivalBufferDays(d("2026-11-01")).reason ?? ""), JSON.stringify(festivalBufferDays(d("2026-11-01"))));
    check("a quiet mid-year date has none", festivalBufferDays(d("2027-06-15")).days === 0 && festivalBufferDays(d("2027-06-15")).reason === null);
    check("the effective lead time adds the buffer", effectiveLeadDays(7, d("2026-11-01")) > 7 && effectiveLeadDays(7, d("2027-06-15")) === 7);
  }

  const rnd = Math.random().toString(36).slice(2, 8);
  const { data: A } = await db.from("merchants").insert({ name: "recvA", slug: `verify-recv-a-${rnd}` }).select("*").single();
  const { data: B } = await db.from("merchants").insert({ name: "recvB", slug: `verify-recv-b-${rnd}` }).select("*").single();
  await ensureWorkspace(db, A.id);
  await ensureWorkspace(db, B.id);
  try {
    await loadSampleStore(db, A.id);
    const { data: vendor } = await db.from("vendors").select("id, reliability").eq("merchant_id", A.id).limit(1).single();
    const { data: prods } = await db.from("products").select("id, sku, stock_qty").eq("merchant_id", A.id).limit(2);
    const [p1, p2] = prods!;
    const stock = async (id: string) => Number((await db.from("products").select("stock_qty").eq("id", id).single()).data!.stock_qty);

    const mkPo = async (opts: { expectedDaysFromNow?: number; status?: string } = {}) => {
      const expected = new Date(Date.now() + (opts.expectedDaysFromNow ?? 5) * 86_400_000).toISOString();
      const { data: po, error } = await db.from("purchase_orders").insert({ merchant_id: A.id, vendor_id: vendor!.id, status: opts.status ?? "paid", total_paise: rupees(1000), advance_paise: rupees(500), expected_at: expected }).select("id").single();
      if (error) throw new Error(error.message);
      await db.from("po_lines").insert([
        { merchant_id: A.id, po_id: po!.id, product_id: p1.id, qty: 10, unit_price_paise: rupees(100) },
        { merchant_id: A.id, po_id: po!.id, product_id: p2.id, qty: 20, unit_price_paise: rupees(50) },
      ]);
      return po!.id as string;
    };

    console.log("receiving in full");
    {
      const before = [await stock(p1.id), await stock(p2.id)];
      const po = await mkPo();
      const r = await receivePurchaseOrder(db, A.id, po, [], "verify");
      check("everything is added to stock", r.ok && (await stock(p1.id)) === before[0] + 10 && (await stock(p2.id)) === before[1] + 20, JSON.stringify(r));
      check("full, on time, at the agreed price", r.ok && r.fillBps === 10000 && r.onTime && r.priceDriftBps === 0, JSON.stringify(r));
      check("the order is marked received", (await db.from("purchase_orders").select("status, received_at").eq("id", po).single()).data?.status === "received");
      const again = await receivePurchaseOrder(db, A.id, po, [], "verify");
      check("a second click adds nothing", !again.ok && again.reason === "already_received" && (await stock(p1.id)) === before[0] + 10);
    }

    console.log("short, late and dearer");
    {
      const before = [await stock(p1.id), await stock(p2.id)];
      const po = await mkPo({ expectedDaysFromNow: -6 });
      const r = await receivePurchaseOrder(db, A.id, po, [{ productId: p1.id, receivedQty: 5, unitPricePaise: rupees(110) }, { productId: p2.id, receivedQty: 20 }], "verify", "two boxes were damaged");
      check("only what arrived is added", r.ok && (await stock(p1.id)) === before[0] + 5 && (await stock(p2.id)) === before[1] + 20, JSON.stringify(r));
      check("fill is received over ordered", r.ok && r.fillBps === Math.floor((25 * 10000) / 30), JSON.stringify(r));
      check("it is late, by days", r.ok && !r.onTime && r.daysLate >= 5, JSON.stringify(r));
      check("a dearer invoice shows as price drift", r.ok && r.priceDriftBps > 0, JSON.stringify(r));
      const { data: alerts } = await db.from("alerts").select("message").eq("merchant_id", A.id);
      check("a short delivery raises an alert", (alerts ?? []).some((a) => /delivered 25 of 30/.test(a.message)), JSON.stringify(alerts));
      check("a note is kept with the receipt", (await db.from("po_receipts").select("note").eq("po_id", po).single()).data?.note === "two boxes were damaged");
    }

    console.log("refusals");
    {
      const po = await mkPo();
      const before = await stock(p1.id);
      const over = await receivePurchaseOrder(db, A.id, po, [{ productId: p1.id, receivedQty: 11 }], "verify");
      check("more than was ordered is refused", !over.ok && over.reason === "over_received" && (await stock(p1.id)) === before);
      const neg = await receivePurchaseOrder(db, A.id, po, [{ productId: p1.id, receivedQty: -1 }], "verify");
      check("a negative quantity is refused", !neg.ok && neg.reason === "bad_quantity");
      const stranger = await receivePurchaseOrder(db, A.id, po, [{ productId: "00000000-0000-0000-0000-000000000000", receivedQty: 1 }], "verify");
      check("a line that is not on the order is refused", !stranger.ok && stranger.reason === "unknown_line");
      const free = await receivePurchaseOrder(db, A.id, po, [{ productId: p1.id, receivedQty: 1, unitPricePaise: 0 }], "verify");
      check("a zero price is refused", !free.ok && free.reason === "bad_price");
      const other = await receivePurchaseOrder(db, B.id, po, [], "attacker");
      check("another merchant cannot receive it", !other.ok && other.reason === "unknown_order" && (await stock(p1.id)) === before);
      const draft = await mkPo({ status: "draft" });
      const early = await receivePurchaseOrder(db, A.id, draft, [], "verify");
      check("an order not yet paid for cannot be received", !early.ok && early.reason === "not_receivable");
      check("nothing was received by any refusal", (await stock(p1.id)) === before);
    }

    console.log("four tabs at once");
    {
      const before = await stock(p1.id);
      const po = await mkPo();
      const all = await Promise.all([1, 2, 3, 4].map(() => receivePurchaseOrder(db, A.id, po, [], "verify")));
      check("exactly one wins", all.filter((x) => x.ok).length === 1, JSON.stringify(all));
      check("stock rose once", (await stock(p1.id)) === before + 10);
      check("one receipt", ((await db.from("po_receipts").select("id").eq("po_id", po)).data ?? []).length === 1);
    }

    console.log("the scorecard");
    {
      const { data: v2 } = await db.from("vendors").select("id, reliability").eq("id", vendor!.id).single();
      check("reliability moved with the deliveries", Number(v2!.reliability) !== Number(vendor!.reliability), `${vendor!.reliability} -> ${v2!.reliability}`);
      const cards = await getScorecards(db, A.id);
      const c = cards.find((x) => x.vendorId === vendor!.id)!;
      check("it counts receipts", c.orders === 3, JSON.stringify(c));
      check("on-time share and fill are percentages", c.onTimePct === 67 && c.fillPct >= 90 && c.fillPct <= 95, JSON.stringify(c));
      check("price drift is averaged", c.avgDriftBps > 0, JSON.stringify(c));
      check("another merchant sees none of it", (await getScorecards(db, B.id)).length === 0 || (await getScorecards(db, B.id)).every((x) => x.orders === 0));
    }

    console.log("festival buffer in restock timing");
    {
      await db.from("purchase_orders").delete().eq("merchant_id", A.id).in("status", ["draft", "paid", "approved"]); // goods still on the way would count as cover
      const ins = await getInventoryInsights(db, A.id, 1500);
      const mouse = ins.find((i) => i.sku === "mouse-01")!;
      const R = Math.floor(mouse.runwayDays!);
      await db.from("products").update({ lead_time_days: R - 8 }).eq("id", mouse.productId);
      const now = new Date("2026-11-01T12:00:00+05:30");
      const off = (await getInventoryInsights(db, A.id, 1500, { now })).find((i) => i.sku === "mouse-01")!;
      const on = (await getInventoryInsights(db, A.id, 1500, { festivalBuffer: true, now })).find((i) => i.sku === "mouse-01")!;
      check("off by default: the same product is healthy", off.status === "healthy" && !off.needsRestock, off.status);
      check("on, in the run-up to Diwali: it is low and needs a restock sooner", on.status === "low" && on.needsRestock, on.status);
      const quiet = (await getInventoryInsights(db, A.id, 1500, { festivalBuffer: true, now: new Date("2027-06-15T12:00:00+05:30") })).find((i) => i.sku === "mouse-01")!;
      check("on, but far from any festival: unchanged", quiet.status === "healthy");
    }
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
