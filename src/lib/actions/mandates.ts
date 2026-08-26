"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireDashboardUser } from "./authGuard";

/** Reversible — an agent under a paused mandate is blocked until this
 *  merchant explicitly resumes it (see reactivateMandate). */
export async function pauseMandate(mandateId: string) {
  await requireDashboardUser();
  const db = createAdminClient();
  const { error } = await db.from("mandates").update({ status: "paused" }).eq("id", mandateId);
  if (error) throw error;
  revalidatePath("/dashboard");
}

export async function reactivateMandate(mandateId: string) {
  await requireDashboardUser();
  const db = createAdminClient();
  const { error } = await db
    .from("mandates")
    .update({ status: "active" })
    .eq("id", mandateId)
    .eq("status", "paused");
  if (error) throw error;
  revalidatePath("/dashboard");
}

/** Deliberately terminal — unlike pause, a real UPI Autopay revocation isn't
 *  something a merchant undoes; the agent would need a fresh mandate. */
export async function revokeMandate(mandateId: string) {
  await requireDashboardUser();
  const db = createAdminClient();
  const { error } = await db.from("mandates").update({ status: "revoked" }).eq("id", mandateId);
  if (error) throw error;
  revalidatePath("/dashboard");
}
