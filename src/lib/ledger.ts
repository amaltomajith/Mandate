import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * The money ledger: what has come in (sales) and gone out (payouts), and the
 * wallet balance that results.
 *
 * Wallet entries are append-only. A balance is always the sum of its entries and
 * never a stored number, so there is no total that can drift from the history
 * behind it.
 */

export async function walletBalancePaise(merchantId: string): Promise<number> {
  const { data, error } = await createAdminClient()
    .from("wallet_entries")
    .select("direction, amount_paise")
    .eq("merchant_id", merchantId);
  if (error) throw new Error(error.message);
  return (data ?? []).reduce((n, e) => n + (e.direction === "credit" ? 1 : -1) * Number(e.amount_paise), 0);
}

export async function recordPayout(input: {
  merchantId: string;
  traceId: string;
  payeeId: string;
  poId?: string;
  amountPaise: number;
  razorpayPayoutId: string;
  status: "queued" | "processing" | "processed" | "failed" | "reversed";
  simulated: boolean;
  note: string;
}): Promise<void> {
  const db = createAdminClient() as unknown as SupabaseClient;
  // The payout row and its wallet debit are one transaction (record_payout,
  // migration 0028), idempotent on the trace id: a retried approval gets `false`
  // and does nothing, so the same payout is never booked twice. And because they
  // are one transaction, a failure cannot leave the payout recorded without its
  // debit. This runs AFTER the money has gone out, so a transient database error
  // is retried before giving up.
  let booked: boolean | null = null;
  let lastError = "";
  for (let attempt = 0; attempt < 3 && booked === null; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 250 * 4 ** (attempt - 1)));
    const { data, error } = await db.rpc("record_payout", {
      p_merchant: input.merchantId,
      p_trace: input.traceId,
      p_payee: input.payeeId,
      p_po: input.poId ?? null,
      p_amount: input.amountPaise,
      p_status: input.status,
      p_razorpay_payout_id: input.razorpayPayoutId,
      p_simulated: input.simulated,
      p_note: input.note,
    });
    if (error) lastError = error.message;
    else booked = data === true;
  }
  if (booked === null) throw new Error(`The payout went out (${input.razorpayPayoutId}) but could not be booked: ${lastError}`);
  if (!booked) return; // already booked

  if (input.poId) {
    // An order is only "paid" once its advance is fully covered. Marking it paid
    // on the first payout would shut out a legitimate follow-up for the rest.
    const [{ data: po }, { data: paid }] = await Promise.all([
      db.from("purchase_orders").select("advance_paise").eq("id", input.poId).eq("merchant_id", input.merchantId).maybeSingle(),
      db.from("payouts").select("amount_paise").eq("merchant_id", input.merchantId).eq("po_id", input.poId).in("status", ["queued", "processing", "processed"]),
    ]);
    const covered = (paid ?? []).reduce((n, p) => n + Number(p.amount_paise), 0);
    if (po && covered >= Number(po.advance_paise)) {
      const { error: poError } = await db
        .from("purchase_orders")
        .update({ status: "paid" })
        .eq("id", input.poId)
        .eq("merchant_id", input.merchantId)
        .in("status", ["draft", "quoting", "awaiting_approval", "approved"]);
      if (poError) throw new Error(poError.message);
    }
  }
}
