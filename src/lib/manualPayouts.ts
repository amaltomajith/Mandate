import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import QRCode from "qrcode";
import { decryptJson } from "@/lib/secrets";
import type { PayeeDetails } from "@/lib/razorpay/payees";

/**
 * Manual payouts: the merchant pays the supplier from their own bank, and
 * Mandate keeps the books.
 *
 * Everything upstream is unchanged. The Buying agent still proposes the payout,
 * the wall still decides, a person still approves anything over the threshold,
 * and the same limits, budget and purchase-order checks apply. What differs is the
 * last step: instead of calling RazorpayX, an allowed payout becomes a TASK for the
 * merchant, and money is only considered gone when they say so.
 *
 * The three states, and what each does to the books:
 *
 *   queued     Reserved. It counts against the weekly budget and against the
 *              order's unpaid advance (so it cannot be paid twice), but the wallet
 *              has not moved: nothing has left the bank yet.
 *   processed  The merchant confirmed they paid. The wallet is debited, the order
 *              is marked paid (once its advance is covered), and the Buying agent
 *              then tells the supplier, because the supplier should hear "paid"
 *              only after it is true.
 *   failed     The merchant cancelled it. The reservation is released.
 *
 * The confirmation is the merchant's word. Mandate cannot see their bank, so the
 * optional reference (a UTR or transaction id) is recorded for their own
 * reconciliation, not verified.
 */

const OPEN = ["draft", "quoting", "awaiting_approval", "approved"];

export async function queueManualPayout(
  db: SupabaseClient,
  p: { merchantId: string; traceId: string; payeeId: string; poId?: string; amountPaise: number }
): Promise<{ id: string }> {
  // Unique on trace_id: a retried approval gets the row that already exists.
  const { data, error } = await db
    .from("payouts")
    .upsert(
      {
        merchant_id: p.merchantId,
        trace_id: p.traceId,
        payee_id: p.payeeId,
        po_id: p.poId ?? null,
        amount_paise: p.amountPaise,
        status: "queued",
        manual: true,
        simulated: false,
        razorpay_payout_id: `manual_${p.traceId.replaceAll("-", "").slice(0, 12)}`,
      },
      { onConflict: "trace_id" }
    )
    .select("id")
    .single();
  if (error) throw new Error(error.message);

  // Approved for payment, but not paid: the order stays open until it is.
  if (p.poId) {
    await db.from("purchase_orders").update({ status: "approved" }).eq("id", p.poId).eq("merchant_id", p.merchantId).in("status", OPEN.filter((s) => s !== "approved"));
  }
  return { id: data.id };
}

export type ConfirmResult = { confirmed: boolean; reason?: string };

/** The merchant says they paid. Debits the wallet exactly once. */
export async function confirmManualPayout(
  db: SupabaseClient,
  merchantId: string,
  payoutId: string,
  confirmedBy: string,
  reference?: string
): Promise<ConfirmResult> {
  const ref = reference?.trim().slice(0, 64) || null;
  if (ref && !/^[\w .\-/#]+$/.test(ref)) throw new Error("A payment reference is letters, digits, spaces and . - / # _ only.");

  // Claim, wallet debit, order and alert are one transaction in the database
  // (confirm_manual_payout, migration 0026). Conditional on `queued`, so a double
  // click or two tabs cannot debit the wallet twice, and a failed debit cannot
  // leave a payout marked paid with no money booked.
  const { data, error } = await db.rpc("confirm_manual_payout", { p_merchant: merchantId, p_payout: payoutId, p_by: confirmedBy, p_ref: ref });
  if (error) throw new Error(error.message);
  if (!(data as { confirmed?: boolean } | null)?.confirmed) return { confirmed: false, reason: "This payment is not waiting for you any more." };
  return { confirmed: true };
}

/** The merchant decided not to pay. Releases the reservation; books nothing. */
export async function cancelManualPayout(db: SupabaseClient, merchantId: string, payoutId: string, by: string): Promise<ConfirmResult> {
  const { data: cancelled, error } = await db
    .from("payouts")
    .update({ status: "failed", confirmed_by: by })
    .eq("id", payoutId)
    .eq("merchant_id", merchantId)
    .eq("manual", true)
    .eq("status", "queued")
    .select("id, po_id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!cancelled) return { confirmed: false, reason: "This payment is not waiting for you any more." };
  if (cancelled.po_id) {
    await db
      .from("purchase_orders")
      .update({ status: "draft", rationale: `Payment cancelled by ${by}. Nothing was paid.` })
      .eq("id", cancelled.po_id)
      .eq("merchant_id", merchantId)
      .in("status", OPEN);
  }
  await db.from("alerts").insert({ merchant_id: merchantId, trace_id: null, severity: "info", message: "You cancelled a supplier payment. Nothing was paid and the order is back to draft." });
  return { confirmed: true };
}

export interface PayoutInstructions {
  supplier: string;
  amountPaise: number;
  note: string;
  kind: "bank" | "upi" | "unknown";
  /** Full details, only when this payee was added in manual mode. */
  details: { accountNumber?: string; ifsc?: string; vpa?: string } | null;
  masked: string;
  /** upi:// link and a QR of it, for UPI payees. */
  upiLink: string | null;
  qrDataUrl: string | null;
}

/**
 * What the merchant needs to make the payment. The only place stored payment
 * details are decrypted, and only for a payout that belongs to the signed-in
 * merchant and is still waiting for them.
 */
export async function getPayoutInstructions(db: SupabaseClient, merchantId: string, payoutId: string): Promise<PayoutInstructions> {
  const { data: payout, error } = await db
    .from("payouts")
    .select("amount_paise, payee_id, po_id, status, manual")
    .eq("id", payoutId)
    .eq("merchant_id", merchantId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!payout || !payout.manual) throw new Error("No such manual payment.");
  if (payout.status !== "queued") throw new Error("This payment is no longer waiting for you.");

  const { data: payee } = await db
    .from("payees")
    .select("display_name, kind, masked_identifier, details_enc, status")
    .eq("id", payout.payee_id)
    .eq("merchant_id", merchantId)
    .maybeSingle();
  if (!payee) throw new Error("The payee for this payment no longer exists.");
  // Even for a payment already queued, an account that has been revoked since is
  // not one to send money to.
  if (payee.status !== "active") throw new Error("This payee has been revoked, so do not pay it. Cancel this payment.");

  const { data: po } = payout.po_id ? await db.from("purchase_orders").select("rationale").eq("id", payout.po_id).maybeSingle() : { data: null };
  const details = payee.details_enc ? decryptJson<PayeeDetails>(payee.details_enc) : null;
  const note = `Mandate order ${(payout.po_id ?? "").slice(0, 8)}`.trim();

  let upiLink: string | null = null;
  let qrDataUrl: string | null = null;
  if (details?.kind === "upi") {
    upiLink = `upi://pay?pa=${encodeURIComponent(details.vpa)}&pn=${encodeURIComponent(payee.display_name)}&am=${(payout.amount_paise / 100).toFixed(2)}&cu=INR&tn=${encodeURIComponent(note)}`;
    qrDataUrl = await QRCode.toDataURL(upiLink, { margin: 1, width: 220 });
  }
  void po;
  return {
    supplier: payee.display_name,
    amountPaise: Number(payout.amount_paise),
    note,
    kind: details?.kind ?? payee.kind,
    details: details
      ? details.kind === "bank"
        ? { accountNumber: details.accountNumber, ifsc: details.ifsc }
        : { vpa: details.vpa }
      : null,
    masked: payee.masked_identifier,
    upiLink,
    qrDataUrl,
  };
}
