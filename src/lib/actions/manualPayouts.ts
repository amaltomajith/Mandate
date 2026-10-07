"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireDashboardUser } from "./authGuard";
import { getCurrentMerchant } from "@/lib/merchant";
import {
  cancelManualPayout,
  confirmManualPayout,
  getPayoutInstructions,
  type PayoutInstructions,
} from "@/lib/manualPayouts";

/**
 * The merchant's side of paying a supplier by hand. Each action resolves the
 * merchant from the signed-in session; none accepts a merchant id, and each core
 * function re-checks that the payout belongs to that merchant.
 */

async function scope() {
  const user = await requireDashboardUser();
  return { user, merchant: await getCurrentMerchant(), db: createAdminClient() };
}

/** The payment details to pay from your own bank. Fetched on request, never preloaded. */
export async function loadPayoutInstructions(payoutId: string): Promise<PayoutInstructions> {
  const { merchant, db } = await scope();
  return getPayoutInstructions(db, merchant.id, payoutId);
}

export async function confirmPayoutPaid(payoutId: string, reference?: string): Promise<void> {
  const { user, merchant, db } = await scope();
  const r = await confirmManualPayout(db, merchant.id, payoutId, user.email, reference);
  if (!r.confirmed) throw new Error(r.reason ?? "Could not confirm that payment.");
  revalidatePath("/dashboard");
}

export async function cancelPayout(payoutId: string): Promise<void> {
  const { user, merchant, db } = await scope();
  const r = await cancelManualPayout(db, merchant.id, payoutId, user.email);
  if (!r.confirmed) throw new Error(r.reason ?? "Could not cancel that payment.");
  revalidatePath("/dashboard");
}
