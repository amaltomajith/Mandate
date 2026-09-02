"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireDashboardUser } from "./authGuard";
import { getCurrentMerchant } from "@/lib/merchant";

/**
 * Every mutation here matches on merchant as well as id.
 *
 * A row id alone is not authorization. These are addressed by a uuid that came
 * from the page, and a uuid is unguessable in practice — but "in practice" is
 * not a security boundary, and the extra predicate costs nothing. With it, the
 * worst case for a forged id is that the update matches no rows.
 */

/** Reversible — an agent under a paused mandate is blocked until this
 *  merchant explicitly resumes it (see reactivateMandate). */
export async function pauseMandate(mandateId: string) {
  await requireDashboardUser();
  const merchant = await getCurrentMerchant();
  const db = createAdminClient();
  const { error } = await db.from("mandates").update({ status: "paused" }).eq("id", mandateId).eq("merchant_id", merchant.id);
  if (error) throw error;
  revalidatePath("/dashboard");
}

export async function reactivateMandate(mandateId: string) {
  await requireDashboardUser();
  const merchant = await getCurrentMerchant();
  const db = createAdminClient();
  const { error } = await db
    .from("mandates")
    .update({ status: "active" })
    .eq("id", mandateId)
    .eq("merchant_id", merchant.id)
    .eq("status", "paused");
  if (error) throw error;
  revalidatePath("/dashboard");
}

/** Deliberately terminal — unlike pause, a real UPI Autopay revocation isn't
 *  something a merchant undoes; the agent would need a fresh mandate. */
export async function revokeMandate(mandateId: string) {
  await requireDashboardUser();
  const merchant = await getCurrentMerchant();
  const db = createAdminClient();
  const { error } = await db.from("mandates").update({ status: "revoked" }).eq("id", mandateId).eq("merchant_id", merchant.id);
  if (error) throw error;
  revalidatePath("/dashboard");
}
