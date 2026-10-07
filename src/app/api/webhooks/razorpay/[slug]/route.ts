import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getMerchantBySlug } from "@/lib/merchant";
import { decryptJson } from "@/lib/secrets";
import { parseItemsNote, recordCapturedPayment } from "@/lib/sales";

/**
 * Razorpay's webhook for one merchant: `POST /api/webhooks/razorpay/<slug>`.
 *
 * Public by necessity (Razorpay cannot sign in), so it authenticates the way
 * Razorpay intends: an HMAC-SHA256 of the raw body, keyed by a secret only the
 * merchant and Razorpay know, in `x-razorpay-signature`. Nothing is read from the
 * body until that verifies. Delivery is at-least-once, so every event is recorded
 * by id first and a repeat is acknowledged and ignored.
 *
 * What it books: captured payments (a sale, stock, a wallet credit) and the
 * lifecycle of payouts. A failed or reversed payout puts the money back in the
 * wallet and tells the merchant.
 */

export const runtime = "nodejs";

async function webhookSecret(merchantId: string): Promise<string | null> {
  const { data } = await createAdminClient()
    .from("connections")
    .select("secret_enc, meta, status")
    .eq("merchant_id", merchantId)
    .eq("kind", "razorpay")
    .maybeSingle();
  if (!data || data.status !== "connected") return null;
  if ((data.meta as { source?: string } | null)?.source === "env") return process.env.RAZORPAY_WEBHOOK_SECRET ?? null;
  if (!data.secret_enc) return null;
  return decryptJson<{ webhook_secret?: string }>(data.secret_enc).webhook_secret ?? null;
}

function validSignature(body: string, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface Entity {
  id?: string;
  order_id?: string | null;
  amount?: number;
  amount_paid?: number;
  status?: string;
  notes?: Record<string, string> | unknown[];
  reference_id?: string | null;
}

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const db = createAdminClient();
  const merchant = await getMerchantBySlug(db, slug);
  // The same answer for "no such merchant" and "bad signature": a caller probing
  // slugs learns nothing about which exist.
  if (!merchant) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const raw = await req.text();
  const signature = req.headers.get("x-razorpay-signature") ?? "";
  const secret = await webhookSecret(merchant.id);
  if (!secret || !signature || !validSignature(raw, signature, secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let event: { event?: string; payload?: Record<string, { entity?: Entity }> };
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const eventId = req.headers.get("x-razorpay-event-id") ?? createHmac("sha256", "id").update(raw).digest("hex");
  const { error: dupError } = await db.from("webhook_events").insert({ id: `${merchant.id}:${eventId}`, merchant_id: merchant.id, event: event.event ?? "unknown" });
  if (dupError) {
    if (dupError.code === "23505") return NextResponse.json({ ok: true, duplicate: true });
    throw new Error(dupError.message);
  }

  const payment = event.payload?.payment?.entity;
  const link = event.payload?.payment_link?.entity;
  const payout = event.payload?.payout?.entity;

  if ((event.event === "payment.captured" || event.event === "payment_link.paid") && payment?.id) {
    const notes = (!Array.isArray(link?.notes) && link?.notes) || (!Array.isArray(payment.notes) && payment.notes) || {};
    let items = parseItemsNote((notes as Record<string, string>).items);
    // Orders and links carry the wall's trace id; its stored line items are the
    // authority when the compact note is missing or was truncated.
    const traceId = (notes as Record<string, string>).mandate_trace;
    if (items.length === 0 && traceId) {
      const { data: trace } = await db.from("traces").select("params").eq("id", traceId).eq("merchant_id", merchant.id).maybeSingle();
      items = (trace?.params as { lineItems?: { sku: string; qty: number }[] } | null)?.lineItems ?? [];
    }
    const result = await recordCapturedPayment(db, {
      merchantId: merchant.id,
      paymentId: payment.id,
      orderId: payment.order_id ?? null,
      amountPaise: Number(payment.amount ?? 0),
      source: event.event === "payment_link.paid" || link ? "payment_link" : "order",
      items,
      simulated: false,
    });
    return NextResponse.json({ ok: true, ...result });
  }

  if (payout?.id && /^payout\.(processed|failed|reversed|rejected|queued|initiated)$/.test(event.event ?? "")) {
    const status =
      event.event === "payout.processed" ? "processed" : event.event === "payout.reversed" ? "reversed" : /failed|rejected/.test(event.event ?? "") ? "failed" : event.event === "payout.queued" ? "queued" : "processing";
    const { data: row } = await db
      .from("payouts")
      .select("id, amount_paise, status, po_id")
      .eq("merchant_id", merchant.id)
      .eq("razorpay_payout_id", payout.id)
      .maybeSingle();
    if (row) {
      await db.from("payouts").update({ status }).eq("id", row.id);
      if ((status === "failed" || status === "reversed") && row.status !== "failed" && row.status !== "reversed") {
        // The money did not leave (or came back): credit the wallet to match and tell the merchant.
        await db.from("wallet_entries").insert({
          merchant_id: merchant.id,
          direction: "credit",
          amount_paise: row.amount_paise,
          kind: "refund",
          ref_type: "payout",
          ref_id: row.id,
          note: `Payout ${status}`,
        });
        if (row.po_id) {
          await db
            .from("purchase_orders")
            .update({ status: "draft", rationale: `Payout ${status}. Check the supplier's payment details and retry.` })
            .eq("id", row.po_id)
            .eq("merchant_id", merchant.id);
        }
        await db.from("alerts").insert({ merchant_id: merchant.id, trace_id: null, severity: "high", message: `A payout to a supplier ${status}. The amount was returned to your wallet and the order is back to draft.` });
      }
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: true, ignored: event.event ?? null });
}
