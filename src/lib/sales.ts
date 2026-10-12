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

  // Sale lines, stock and the wallet credit are one transaction in the database
  // (book_captured_payment, migration 0026). They used to be separate writes, so a
  // failure after the first left a sale with no credit, and Razorpay's retry then
  // saw the sale and stopped. Now it is all booked or none of it is, and a retry
  // simply tries again.
  const { data: booked, error } = await db.rpc("book_captured_payment", {
    p_merchant: p.merchantId,
    p_payment_id: p.paymentId,
    p_order_id: p.orderId ?? null,
    p_source: p.source,
    p_amount: p.amountPaise,
    p_simulated: p.simulated,
    p_note: p.items.length ? `Sale: ${p.items.map((i) => `${i.qty} x ${i.sku}`).join(", ")}` : "Payment received",
    p_rows: rows,
  });
  if (error) {
    // A concurrent delivery of the same payment lost the race on the unique key.
    if (error.code === "23505") return { booked: false, reason: "already recorded" };
    throw new Error(error.message);
  }
  if (booked === false) return { booked: false, reason: "already recorded" };
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
