"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireDashboardUser } from "./authGuard";

export async function approvePolicyRule(ruleId: string) {
  await requireDashboardUser();
  const db = createAdminClient();
  const { error } = await db.from("policy_rules").update({ status: "active" }).eq("id", ruleId);
  if (error) throw error;
  revalidatePath("/dashboard");
}

export async function rejectPolicyRule(ruleId: string) {
  await requireDashboardUser();
  const db = createAdminClient();
  const { error } = await db.from("policy_rules").update({ status: "rejected" }).eq("id", ruleId);
  if (error) throw error;
  revalidatePath("/dashboard");
}
