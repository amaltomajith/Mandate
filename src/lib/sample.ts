import type { SupabaseClient } from "@supabase/supabase-js";
import { applyGuardrails } from "@/lib/policy/guardrails";
import { getSettings } from "@/lib/settings";

/**
 * A sample store, for trying the COO before connecting a real one.
 *
 * Everything it writes is marked: sales carry a `sample_` payment id, vendors and
 * payees are `simulated`, and the vendors use the sandbox channel, so nothing
 * here can message a real person or move real money. {@link clearSampleStore}
 * removes it again. Sample sales are excluded from the payout budget (see
 * getAggregates), so loading them never gives the business money it did not earn.
 */

/** Average units sold per day, over the last 45 days, for each sample SKU. */
const DAILY_RATE: Record<string, number> = {
  "mouse-01": 3.2, // bestseller, healthy stock
  "keyboard-01": 2.0, // bestseller about to run out
  "stand-01": 0.35, // slow
  "yogamat-01": 0.9, // steady
  // hub-01 and desk-01 sold nothing recently: dead stock. They get one old sale
  // each, below, so "last sold" is a real date rather than "never".
};
const OLD_SALES: Record<string, number> = { "hub-01": 70, "desk-01": 62 };

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

export const SAMPLE_VENDORS = [
  { name: "Shenzhen Peripherals Co", categories: ["electronics"], reliability: 82, email: "sales@shenzhen-peripherals.sandbox.test" },
  { name: "Bharat Office Supplies", categories: ["office", "fitness"], reliability: 74, email: "orders@bharat-office.sandbox.test" },
] as const;

export async function loadSampleStore(db: SupabaseClient, merchantId: string): Promise<{ sales: number; vendors: number }> {
  const { data: real } = await db
    .from("sales")
    .select("id")
    .eq("merchant_id", merchantId)
    .not("razorpay_payment_id", "like", "sample_%")
    .limit(1);
  if ((real ?? []).length > 0) throw new Error("This store already has real sales, so the sample data was not loaded.");

  await clearSampleStore(db, merchantId);

  const { data: products, error } = await db.from("products").select("id, sku, price_paise").eq("merchant_id", merchantId);
  if (error) throw new Error(error.message);
  const bySku = new Map((products ?? []).map((p) => [p.sku as string, p]));

  const rows: Record<string, unknown>[] = [];
  const lastSold = new Map<string, string>();
  const now = Date.now();
  for (const [sku, rate] of Object.entries(DAILY_RATE)) {
    const product = bySku.get(sku);
    if (!product) continue;
    const rand = lcg(sku.split("").reduce((n, c) => n + c.charCodeAt(0), 7));
    for (let day = 0; day < 45; day++) {
      // A little noise around the average, never negative.
      const qty = Math.max(0, Math.round(rate + (rand() - 0.5) * rate * 1.2));
      if (qty === 0) continue;
      const at = new Date(now - day * 86_400_000 - Math.floor(rand() * 40_000_000)).toISOString();
      rows.push({
        merchant_id: merchantId,
        product_id: product.id,
        qty,
        amount_paise: qty * product.price_paise,
        source: "manual",
        razorpay_payment_id: `sample_${sku}_${day}`,
        captured_at: at,
      });
      if (!lastSold.has(sku)) lastSold.set(sku, at);
    }
  }
  for (const [sku, daysAgo] of Object.entries(OLD_SALES)) {
    const product = bySku.get(sku);
    if (!product) continue;
    const at = new Date(now - daysAgo * 86_400_000).toISOString();
    rows.push({
      merchant_id: merchantId,
      product_id: product.id,
      qty: 1,
      amount_paise: product.price_paise,
      source: "manual",
      razorpay_payment_id: `sample_${sku}_old`,
      captured_at: at,
    });
    lastSold.set(sku, at);
  }
  if (rows.length) {
    const { error: salesError } = await db.from("sales").insert(rows);
    if (salesError) throw new Error(salesError.message);
  }
  for (const [sku, at] of lastSold) {
    await db.from("products").update({ last_sold_at: at }).eq("merchant_id", merchantId).eq("sku", sku);
  }

  let vendors = 0;
  for (const v of SAMPLE_VENDORS) {
    const { data: existing } = await db.from("vendors").select("id").eq("merchant_id", merchantId).ilike("name", v.name).maybeSingle();
    if (existing) continue;
    const { data: vendor, error: vendorError } = await db
      .from("vendors")
      .insert({
        merchant_id: merchantId,
        name: v.name,
        channel: "sandbox",
        email: v.email,
        status: "approved",
        source: "manual",
        categories: [...v.categories],
        reliability: v.reliability,
        notes: "Sample supplier on the sandbox channel. No real message is ever sent to it.",
        simulated: true,
      })
      .select("id")
      .single();
    if (vendorError) throw new Error(vendorError.message);
    const { error: payeeError } = await db.from("payees").insert({
      merchant_id: merchantId,
      vendor_id: vendor.id,
      kind: "bank",
      display_name: v.name,
      masked_identifier: "••••0000",
      status: "active",
      approved_by: "sample-data",
      approved_at: new Date().toISOString(),
      simulated: true,
    });
    if (payeeError) throw new Error(payeeError.message);
    vendors++;
  }

  // Opted-in sample buyers, so the Selling agent has someone to offer clearance to.
  for (const c of [
    { name: "Asha (sample buyer)", email: "asha@buyer.sandbox.test", phone: "+910000000001" },
    { name: "Ravi (sample buyer)", email: "ravi@buyer.sandbox.test", phone: "+910000000002" },
  ]) {
    const { data: existing } = await db.from("customers").select("id").eq("merchant_id", merchantId).eq("email", c.email).maybeSingle();
    if (!existing) await db.from("customers").insert({ merchant_id: merchantId, ...c, marketing_opt_in: true });
  }

  // The default limits are sized for a small shop. The sample catalog's
  // restocking runs into the tens of thousands, so give it limits in proportion;
  // approval is still required from ten thousand rupees up, so a human is in the
  // loop for the bigger orders.
  const { error: settingsError } = await db
    .from("merchant_settings")
    .update({
      starting_float_paise: 20_000_000,
      weekly_payout_budget_paise: 30_000_000,
      max_single_payout_paise: 15_000_000,
      updated_at: new Date().toISOString(),
    })
    .eq("merchant_id", merchantId);
  if (settingsError) throw new Error(settingsError.message);
  await applyGuardrails(db, merchantId, await getSettings(db, merchantId));

  return { sales: rows.length, vendors };
}

/** Removes everything {@link loadSampleStore} wrote. Real records are untouched. */
export async function clearSampleStore(db: SupabaseClient, merchantId: string): Promise<void> {
  await db.from("sales").delete().eq("merchant_id", merchantId).like("razorpay_payment_id", "sample_%");
  // Vendors cascade to their payees, threads' vendor link nulls out, quotes cascade.
  await db.from("vendors").delete().eq("merchant_id", merchantId).eq("simulated", true).eq("channel", "sandbox").in("name", SAMPLE_VENDORS.map((v) => v.name));
  await db.from("customers").delete().eq("merchant_id", merchantId).like("email", "%@buyer.sandbox.test");
}
