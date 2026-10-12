import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Receiving goods and keeping score of suppliers.
 *
 * The receipt, the stock change, the order's status and any alert are one
 * transaction in the database (receive_purchase_order, migration 0035), so a double
 * click, two tabs or another merchant cannot add stock twice. What arrived, when
 * and at what price is then turned into a 0 to 100 score for that delivery, which
 * moves the supplier's reliability. The Buying agent already uses reliability to
 * choose between otherwise equal quotes, so a supplier who delivers short or late
 * loses those ties.
 */

export type ReceiveRefusal = "unknown_order" | "already_received" | "not_receivable" | "unknown_line" | "bad_quantity" | "over_received" | "bad_price" | "empty_order";

const MESSAGES: Record<ReceiveRefusal, string> = {
  unknown_order: "That order was not found.",
  already_received: "That order has already been marked received.",
  not_receivable: "Only an order that has been paid for can be marked received.",
  unknown_line: "One of those items is not on this order.",
  bad_quantity: "A quantity cannot be negative.",
  over_received: "You cannot receive more than was ordered.",
  bad_price: "A price has to be more than zero.",
  empty_order: "That order has nothing on it.",
};

export interface ReceivedLine {
  productId: string;
  receivedQty: number;
  /** What the supplier invoiced, if different from the agreed price. */
  unitPricePaise?: number;
}

export type ReceiveResult =
  | { ok: true; fillBps: number; priceDriftBps: number; onTime: boolean; daysLate: number; reliability: number }
  | { ok: false; reason: ReceiveRefusal; message: string };

export interface ReceiptFacts {
  onTime: boolean;
  daysLate: number;
  fillBps: number;
  priceDriftBps: number;
}

/** 0 to 100: 40 for arriving on time, 40 for all of it arriving, 20 for the agreed price. */
export function scoreReceipt(f: ReceiptFacts): number {
  const timing = f.onTime ? 40 : Math.max(0, 40 - 5 * Math.max(1, f.daysLate));
  const fill = (40 * Math.min(10000, Math.max(0, f.fillBps))) / 10000;
  const price = f.priceDriftBps <= 0 ? 20 : Math.max(0, 20 - (f.priceDriftBps / 100) * 2);
  return Math.round(timing + fill + price);
}

/** One delivery moves reliability by 30%: a bad day dents it, a habit changes it. */
export const nextReliability = (current: number, score: number) => Math.min(100, Math.max(0, Math.round(0.7 * current + 0.3 * score)));

export async function receivePurchaseOrder(db: SupabaseClient, merchantId: string, poId: string, lines: ReceivedLine[], by: string, note?: string): Promise<ReceiveResult> {
  const { data, error } = await db.rpc("receive_purchase_order", {
    p_merchant: merchantId,
    p_po: poId,
    p_lines: lines.map((l) => ({ product_id: l.productId, received_qty: l.receivedQty, unit_price_paise: l.unitPricePaise ?? null })),
    p_by: by,
    p_note: note ?? null,
  });
  if (error) throw new Error(error.message);
  const r = data as { ok: boolean; reason?: ReceiveRefusal; vendor_id?: string; fill_bps?: number; price_drift_bps?: number; on_time?: boolean; days_late?: number };
  if (!r.ok) {
    const reason = r.reason ?? "unknown_order";
    return { ok: false, reason, message: MESSAGES[reason] ?? "That could not be received." };
  }
  const facts = { onTime: !!r.on_time, daysLate: r.days_late ?? 0, fillBps: r.fill_bps ?? 0, priceDriftBps: r.price_drift_bps ?? 0 };
  // Only the call that won the receipt gets here, so each delivery is scored once.
  const { data: vendor } = await db.from("vendors").select("reliability").eq("id", r.vendor_id).eq("merchant_id", merchantId).maybeSingle();
  const reliability = nextReliability(Number(vendor?.reliability ?? 50), scoreReceipt(facts));
  await db.from("vendors").update({ reliability }).eq("id", r.vendor_id).eq("merchant_id", merchantId);
  return { ok: true, ...facts, reliability };
}

export interface Scorecard {
  vendorId: string;
  name: string;
  orders: number;
  onTimePct: number;
  fillPct: number;
  avgDriftBps: number;
  reliability: number;
}

export async function getScorecards(db: SupabaseClient, merchantId: string): Promise<Scorecard[]> {
  const [{ data: vendors, error: ve }, { data: receipts, error: re }] = await Promise.all([
    db.from("vendors").select("id, name, reliability").eq("merchant_id", merchantId),
    db.from("po_receipts").select("vendor_id, fill_bps, price_drift_bps, on_time").eq("merchant_id", merchantId),
  ]);
  if (ve) throw new Error(ve.message);
  if (re) throw new Error(re.message);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  return (vendors ?? [])
    .map((v) => {
      const mine = (receipts ?? []).filter((r) => r.vendor_id === v.id);
      return {
        vendorId: v.id as string,
        name: v.name as string,
        orders: mine.length,
        onTimePct: Math.round(mean(mine.map((r) => (r.on_time ? 100 : 0)))),
        fillPct: Math.round(mean(mine.map((r) => Number(r.fill_bps) / 100))),
        avgDriftBps: Math.round(mean(mine.map((r) => Number(r.price_drift_bps)))),
        reliability: Math.round(Number(v.reliability)),
      };
    })
    .filter((c) => c.orders > 0);
}
