import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Money coming in. One function turns "a payment was captured" into the four
 * things that must happen together: a sale record per product, stock taken off
 * the shelf, the product's last-sold date, and a wallet credit.
 *
 * It is idempotent on the payment id. Razorpay delivers webhooks at least once,
 * and the sandbox "customer pays" button can be pressed twice; either way the
 * same payment is booked once.
 */

export interface CapturedPayment {
  merchantId: string;
  /** Razorpay's payment id, or a `sim_pay_` id for the sandbox. */
  paymentId: string;
  orderId?: string | null;
  amountPaise: number;
  source: "payment_link" | "order";
  /** What was bought: [{ sku, qty }]. */
  items: { sku: string; qty: number }[];
  simulated: boolean;
}

export type RecordResult = { booked: boolean; reason?: string };

/** Parses the compact `sku x qty,sku x qty` note written onto links and orders. */
export function parseItemsNote(note: string | undefined): { sku: string; qty: number }[] {
  if (!note) return [];
  return note
    .split(",")
    .map((part) => /^(.+)x(\d+)$/.exec(part.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ sku: m[1], qty: parseInt(m[2], 10) }));
}

export async function recordCapturedPayment(db: SupabaseClient, p: CapturedPayment): Promise<RecordResult> {
  const { data: existing } = await db
    .from("sales")
    .select("id")
    .eq("merchant_id", p.merchantId)
    .eq("razorpay_payment_id", p.paymentId)
    .limit(1);
  if ((existing ?? []).length > 0) return { booked: false, reason: "already recorded" };

  const skus = [...new Set(p.items.map((i) => i.sku))];
  const { data: products } = skus.length
    ? await db.from("products").select("id, sku, price_paise, stock_qty").eq("merchant_id", p.merchantId).in("sku", skus)
    : { data: [] };
  const bySku = new Map((products ?? []).map((x) => [x.sku as string, x]));

  // Split the amount across lines in proportion to list value, so a basket's
  // revenue lands on the products that earned it. A payment with no known items
  // is still real money and is booked against no product.
  const lines = p.items.filter((i) => bySku.has(i.sku));
  const weights = lines.map((i) => bySku.get(i.sku)!.price_paise * i.qty);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let remaining = p.amountPaise;

  const rows =
    lines.length === 0
      ? [{ product_id: null as string | null, qty: 1, amount_paise: p.amountPaise }]
      : lines.map((i, idx) => {
          const share = idx === lines.length - 1 ? remaining : Math.round((p.amountPaise * weights[idx]) / (totalWeight || 1));
          remaining -= share;
          return { product_id: bySku.get(i.sku)!.id as string | null, qty: i.qty, amount_paise: share };
        });

  const now = new Date().toISOString();
  for (const [idx, row] of rows.entries()) {
    const { error } = await db.from("sales").insert({
      merchant_id: p.merchantId,
      product_id: row.product_id,
      qty: row.qty,
      amount_paise: row.amount_paise,
      source: p.source,
      // One payment id per payment; extra lines get a suffix so the unique key holds.
      razorpay_payment_id: idx === 0 ? p.paymentId : `${p.paymentId}#${idx}`,
      razorpay_order_id: p.orderId ?? null,
      captured_at: now,
    });
    if (error) {
      if (error.code === "23505") return { booked: false, reason: "already recorded" };
      throw new Error(error.message);
    }
  }

  for (const i of lines) {
    const product = bySku.get(i.sku)!;
    await db
      .from("products")
      .update({ stock_qty: Math.max(0, product.stock_qty - i.qty), last_sold_at: now })
      .eq("id", product.id)
      .eq("merchant_id", p.merchantId);
  }

  if (p.amountPaise > 0) {
    const { error } = await db.from("wallet_entries").insert({
      merchant_id: p.merchantId,
      direction: "credit",
      amount_paise: p.amountPaise,
      kind: "sale",
      ref_type: "payment",
      note: p.items.length ? `Sale: ${p.items.map((i) => `${i.qty} x ${i.sku}`).join(", ")}` : "Payment received",
      simulated: p.simulated,
    });
    if (error) throw new Error(error.message);
  }
  return { booked: true };
}

/**
 * The sandbox's "customer pays": settles a simulated payment link or order as if
 * the buyer had paid it. Refuses anything that is not a sandbox object, so it can
 * never be used to credit a real wallet with money that did not arrive.
 */
export async function simulateSandboxPayment(db: SupabaseClient, merchantId: string, traceId: string): Promise<RecordResult> {
  const { data: trace, error } = await db.from("traces").select("*").eq("id", traceId).eq("merchant_id", merchantId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!trace) throw new Error("Unknown trace.");
  const response = trace.razorpay_response as { simulated?: boolean; id?: string } | null;
  if (!response?.simulated || !response.id) throw new Error("Only a sandbox payment link or order can be settled this way.");
  if (trace.action_type !== "payment_link.create" && trace.action_type !== "order.create") throw new Error("That action is not a sale.");

  const params = trace.params as { amount?: number; lineItems?: { sku: string; qty: number }[] };
  return recordCapturedPayment(db, {
    merchantId,
    paymentId: `sim_pay_${response.id.replace(/^sim_(plink|order)_/, "")}`,
    orderId: trace.action_type === "order.create" ? response.id : null,
    amountPaise: Number(params.amount ?? 0),
    source: trace.action_type === "payment_link.create" ? "payment_link" : "order",
    items: params.lineItems ?? [],
    simulated: true,
  });
}
