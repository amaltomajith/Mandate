/**
 * GST-ready exports: a sales register and a purchase register an accountant can
 * use. Pure tax arithmetic and CSV safety first, then the real registers against
 * the database: which sales count (not sample data, not the cash that settles a
 * credit sale a second time), a missing rate is flagged rather than guessed, the
 * period is in India time, and nobody else's rows are included.
 *
 *   npx tsx --tsconfig worker/tsconfig.json scripts/verify-gst.ts
 */
import "./lib/loadEnv";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "../src/lib/supabase/admin";
import { ensureWorkspace } from "../src/lib/workspace";
import { csvCell, toCsv } from "../src/lib/csv";
import { buildGstExport, splitExclusive, splitInclusive, validGstin, validHsn, validRateBps } from "../src/lib/gst";

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
  console.log("tax arithmetic");
  {
    const a = splitInclusive(11800, 1800);
    check("a GST-inclusive price splits into value and tax", a.taxable === 10000 && a.tax === 1800, JSON.stringify(a));
    const b = splitInclusive(10000, 500);
    check("the two parts always add back to the price", b.taxable + b.tax === 10000, JSON.stringify(b));
    check("zero rated has no tax", splitInclusive(5000, 0).tax === 0);
    const c = splitExclusive(10000, 1800);
    check("a price before GST adds it on", c.taxable === 10000 && c.tax === 1800);
    check("rounding is to the paisa, never a fraction", Number.isInteger(splitInclusive(9999, 1800).tax) && Number.isInteger(splitExclusive(9999, 1800).tax));
    check("a rate is 0 to 40 percent", validRateBps(0) && validRateBps(1800) && validRateBps(4000) && !validRateBps(4001) && !validRateBps(-1) && !validRateBps(12.5));
    check("an HSN code is 4, 6 or 8 digits", validHsn("8471") && validHsn("847130") && validHsn("84713010") && !validHsn("847") && !validHsn("84a1") && !validHsn("123456789"));
    check("a GSTIN has the 15-character shape", validGstin("27AAPFU0939F1ZV") && !validGstin("27AAPFU0939F1Z") && !validGstin("27aapfu0939f1zv"));
  }

  console.log("csv safety");
  {
    check("a cell that could run as a formula is made inert", csvCell("=SUM(A1)") === `"'=SUM(A1)"` && csvCell("@x").startsWith(`"'`) && csvCell("-5") === `"'-5"`);
    check("quotes are doubled", csvCell('say "hi"') === `"say ""hi"""`);
    check("a row is comma-joined and the file CRLF-separated", toCsv(["a", "b"], [["1", "2"]]) === `"a","b"\r\n"1","2"`);
  }

  const rnd = Math.random().toString(36).slice(2, 8);
  const { data: A } = await db.from("merchants").insert({ name: "gstA", slug: `verify-gst-a-${rnd}` }).select("*").single();
  const { data: B } = await db.from("merchants").insert({ name: "gstB", slug: `verify-gst-b-${rnd}` }).select("*").single();
  await ensureWorkspace(db, A.id);
  await ensureWorkspace(db, B.id);
  try {
    const { data: prods } = await db.from("products").select("id, sku, name").eq("merchant_id", A.id).limit(2);
    const [p1, p2] = prods!;
    await db.from("products").update({ hsn_code: "847130", gst_rate_bps: 1800 }).eq("id", p1.id);
    await db.from("products").update({ hsn_code: null, gst_rate_bps: null }).eq("id", p2.id);
    const at = (iso: string) => iso;
    const sale = async (productId: string, amount: number, payId: string, when: string) =>
      db.from("sales").insert({ merchant_id: A.id, product_id: productId, qty: 2, amount_paise: amount, source: "manual", razorpay_payment_id: payId, captured_at: at(when) });
    await sale(p1.id, 11800, "pay_real_1", "2026-04-10T10:00:00+05:30");
    await sale(p1.id, 23600, "credit_abc", "2026-04-12T10:00:00+05:30");
    await sale(p1.id, 11800, "khatapay_abc", "2026-04-13T10:00:00+05:30");
    await sale(p1.id, 11800, "sample_xyz", "2026-04-14T10:00:00+05:30");
    await sale(p2.id, 5000, "pay_real_2", "2026-04-15T10:00:00+05:30");
    await sale(p1.id, 11800, "pay_outside", "2026-05-02T10:00:00+05:30");
    await sale(p1.id, 11800, "pay_edge_late", "2026-04-30T23:30:00+05:30");
    await db.from("sales").insert({ merchant_id: B.id, amount_paise: 99900, qty: 1, source: "manual", razorpay_payment_id: "pay_other", captured_at: "2026-04-10T10:00:00+05:30" });

    console.log("the sales register");
    const s = await buildGstExport(db, A.id, "sales", "2026-04-01", "2026-04-30");
    const refs = s.rows.map((r) => r[1]);
    check("real sales and credit sales are in", refs.includes("pay_real_1") && refs.includes("credit_abc") && refs.includes("pay_real_2"), JSON.stringify(refs));
    check("the cash that later settles a credit sale is not counted a second time", !refs.includes("khatapay_abc"));
    check("sample data is never in a tax register", !refs.includes("sample_xyz"));
    check("the period is in India time: late on the 30th is in, 2 May is out", refs.includes("pay_edge_late") && !refs.includes("pay_outside"));
    check("another merchant's sales are not here", !refs.includes("pay_other"));
    const row = s.rows.find((r) => r[1] === "pay_real_1")!;
    const col = (name: string) => s.head.indexOf(name);
    check("the tax is carved out of the inclusive price", row[col("taxable_value")] === "100.00" && row[col("tax")] === "18.00" && row[col("total")] === "118.00", JSON.stringify(row));
    check("the HSN and rate come from the product", row[col("hsn")] === "847130" && row[col("gst_rate_percent")] === "18");
    check("a credit sale is labelled as credit", s.rows.find((r) => r[1] === "credit_abc")![col("payment")] === "credit");
    const noRate = s.rows.find((r) => r[1] === "pay_real_2")!;
    check("a product with no rate is flagged, and no tax is invented", noRate[col("tax")] === "" && noRate[col("needs_attention")] !== "", JSON.stringify(noRate));
    check("the summary counts what needs a rate", s.summary.missingRate === 1 && s.summary.rows === s.rows.length, JSON.stringify(s.summary));
    check("totals add up", s.summary.totalPaise === 11800 + 23600 + 5000 + 11800, JSON.stringify(s.summary));

    console.log("the purchase register");
    const { data: vendor } = await db.from("vendors").insert({ merchant_id: A.id, name: "Acme Traders", categories: ["electronics"], channel: "email", status: "approved", gstin: "27AAPFU0939F1ZV" }).select("id").single();
    const { data: po } = await db.from("purchase_orders").insert({ merchant_id: A.id, vendor_id: vendor!.id, status: "paid", total_paise: rupees(1000), advance_paise: rupees(500) }).select("id").single();
    await db.from("po_lines").insert({ merchant_id: A.id, po_id: po!.id, product_id: p1.id, qty: 10, unit_price_paise: rupees(100) });
    const { receivePurchaseOrder } = await import("../src/lib/receiving");
    await receivePurchaseOrder(db, A.id, po!.id, [{ productId: p1.id, receivedQty: 8, unitPricePaise: rupees(105) }], "verify");
    const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    const p = await buildGstExport(db, A.id, "purchases", today, today);
    const pc = (name: string) => p.head.indexOf(name);
    check("what arrived is on the register, at the invoice price", p.rows.length === 1 && p.rows[0][pc("qty")] === "8" && p.rows[0][pc("unit_price")] === "105.00", JSON.stringify(p.rows));
    check("input tax is added to a price that excludes GST", p.rows[0][pc("taxable_value")] === "840.00" && p.rows[0][pc("tax")] === "151.20", JSON.stringify(p.rows[0]));
    check("the supplier's GSTIN is on it", p.rows[0][pc("supplier_gstin")] === "27AAPFU0939F1ZV");
    const none = await buildGstExport(db, B.id, "purchases", today, today);
    check("another merchant's register is empty", none.rows.length === 0);

    console.log("bad input");
    const bad = await buildGstExport(db, A.id, "sales", "2026-13-40", "2026-04-30").then(() => "ok", (e) => String(e.message));
    check("an impossible date is refused", /date/i.test(bad), bad);
    const back = await buildGstExport(db, A.id, "sales", "2026-05-01", "2026-04-01").then(() => "ok", (e) => String(e.message));
    check("a period that ends before it starts is refused", /before|after|end/i.test(back), back);
    const long = await buildGstExport(db, A.id, "sales", "2020-01-01", "2026-04-30").then(() => "ok", (e) => String(e.message));
    check("more than a year at once is refused", /year|366|long/i.test(long), long);
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
