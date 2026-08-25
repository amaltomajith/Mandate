"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireDashboardUser } from "./authGuard";
import { runSemanticPolicyAudit, type SemanticIssue } from "@/lib/policy/semanticAudit";
import { suggestPolicyFix, type FixSuggestion } from "@/lib/policy/suggestFix";
import type { Json } from "@/types/db";

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

/** Permanent removal — only allowed for a rule that has never actually
 *  fired. A rule referenced by real transaction history stays deletable-in-
 *  spirit via deactivate (the audit trail needs `rule_fired_id` to keep
 *  resolving), but a rule that was rejected, superseded, or simply never
 *  matched anything is safe to remove outright. */
export async function deletePolicyRule(ruleId: string) {
  await requireDashboardUser();
  const db = createAdminClient();

  const { count, error: countError } = await db
    .from("traces")
    .select("id", { count: "exact", head: true })
    .eq("rule_fired_id", ruleId);
  if (countError) throw countError;
  if (count && count > 0) {
    throw new Error(
      `This rule fired on ${count} transaction${count > 1 ? "s" : ""} — deactivate it instead of deleting, so that history keeps its explanation.`
    );
  }

  // Clear any rule that lists this one as "replaced by," so the delete
  // doesn't fail on the superseded_by foreign key.
  const { error: clearError } = await db.from("policy_rules").update({ superseded_by: null }).eq("superseded_by", ruleId);
  if (clearError) throw clearError;

  const { error } = await db.from("policy_rules").delete().eq("id", ruleId);
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

export async function suggestFixForIssue(
  issueTitle: string,
  issueExplanation: string,
  affectedRuleIds: string[]
): Promise<FixSuggestion[]> {
  await requireDashboardUser();
  if (affectedRuleIds.length === 0) return [];
  const db = createAdminClient();
  const { data: rules, error } = await db.from("policy_rules").select("*").in("id", affectedRuleIds);
  if (error) throw error;
  return suggestPolicyFix(issueTitle, issueExplanation, rules ?? []);
}

/** Applying a suggested fix is a second, separate, explicit click from
 *  requesting one — "suggest" never auto-applies. */
export async function applyPolicyFix(ruleId: string, proposedParams: Record<string, unknown>) {
  await requireDashboardUser();
  const db = createAdminClient();
  const { error } = await db.from("policy_rules").update({ params: proposedParams as unknown as Json }).eq("id", ruleId);
  if (error) throw error;
  revalidatePath("/dashboard");
}
