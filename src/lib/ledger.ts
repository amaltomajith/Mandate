import "server-only";
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
  const db = createAdminClient();
  // The unique index on trace_id makes this idempotent: a retried approval hits
  // the conflict and does nothing, so the same payout can never be booked twice.
  const { data: payout, error } = await db
    .from("payouts")
    .upsert(
      {
        merchant_id: input.merchantId,
        trace_id: input.traceId,
        payee_id: input.payeeId,
        po_id: input.poId ?? null,
        amount_paise: input.amountPaise,
        status: input.status,
        razorpay_payout_id: input.razorpayPayoutId,
        simulated: input.simulated,
      },
      { onConflict: "trace_id", ignoreDuplicates: true }
    )
    .select("id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!payout) return; // already booked

  const { error: walletError } = await db.from("wallet_entries").insert({
    merchant_id: input.merchantId,
    direction: "debit",
    amount_paise: input.amountPaise,
    kind: "payout",
    ref_type: "payout",
    ref_id: payout.id,
    note: input.note,
    simulated: input.simulated,
  });
  if (walletError) throw new Error(walletError.message);

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
