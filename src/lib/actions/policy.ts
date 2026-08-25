"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireDashboardUser } from "./authGuard";
import { runSemanticPolicyAudit, type SemanticIssue } from "@/lib/policy/semanticAudit";

/** `supersedeRuleIds` — rules the user chose to retire at the same moment
 *  this one activates, from the conflict-resolution UI in PolicyRulesPanel.
 *  Optional: approving a rule that conflicts with an existing one doesn't
 *  force a choice, it offers one. */
export async function approvePolicyRule(ruleId: string, supersedeRuleIds: string[] = []) {
  await requireDashboardUser();
  const db = createAdminClient();

  const { error } = await db.from("policy_rules").update({ status: "active" }).eq("id", ruleId);
  if (error) throw error;

  if (supersedeRuleIds.length > 0) {
    const { error: supersedeError } = await db
      .from("policy_rules")
      .update({ status: "superseded", superseded_by: ruleId })
      .in("id", supersedeRuleIds);
    if (supersedeError) throw supersedeError;
  }

  revalidatePath("/dashboard");
}

export async function rejectPolicyRule(ruleId: string) {
  await requireDashboardUser();
  const db = createAdminClient();
  const { error } = await db.from("policy_rules").update({ status: "rejected" }).eq("id", ruleId);
  if (error) throw error;
  revalidatePath("/dashboard");
}

/** Turns an active rule off without deleting it — the audit trail (which
 *  trace fired which rule) stays intact either way. Reuses the existing
 *  `superseded` status rather than adding a new one: `superseded_by` stays
 *  null here, distinguishing "manually retired" from "replaced by rule X". */
export async function deactivatePolicyRule(ruleId: string) {
  await requireDashboardUser();
  const db = createAdminClient();
  const { error } = await db.from("policy_rules").update({ status: "superseded", superseded_by: null }).eq("id", ruleId);
  if (error) throw error;
  revalidatePath("/dashboard");
}

export async function reactivatePolicyRule(ruleId: string) {
  await requireDashboardUser();
  const db = createAdminClient();
  const { error } = await db.from("policy_rules").update({ status: "active", superseded_by: null }).eq("id", ruleId);
  if (error) throw error;
  revalidatePath("/dashboard");
}

export async function runPolicyAudit(): Promise<SemanticIssue[]> {
  await requireDashboardUser();
  const db = createAdminClient();
  const { data: rules, error } = await db.from("policy_rules").select("*");
  if (error) throw error;
  return runSemanticPolicyAudit(rules ?? []);
}
