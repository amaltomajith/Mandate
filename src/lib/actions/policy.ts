"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireDashboardUser } from "./authGuard";
import { getCurrentMerchant } from "@/lib/merchant";
import { runSemanticPolicyAudit, type SemanticIssue } from "@/lib/policy/semanticAudit";
import { suggestPolicyFix, type FixSuggestion } from "@/lib/policy/suggestFix";
import type { Json } from "@/types/db";
import { sweepThresholds, type ReplayAction, type ThresholdOutcome } from "@/lib/policy/thresholdSweep";

/** `supersedeRuleIds` — rules the user chose to retire at the same moment
 *  this one activates, from the conflict-resolution UI in PolicyRulesPanel.
 *  Optional: approving a rule that conflicts with an existing one doesn't
 *  force a choice, it offers one. */
export async function approvePolicyRule(ruleId: string, supersedeRuleIds: string[] = []) {
  await requireDashboardUser();
  const merchant = await getCurrentMerchant();
  const db = createAdminClient();

  const { error } = await db.from("policy_rules").update({ status: "active" }).eq("id", ruleId).eq("merchant_id", merchant.id);
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
  const merchant = await getCurrentMerchant();
  const db = createAdminClient();
  const { error } = await db.from("policy_rules").update({ status: "rejected" }).eq("id", ruleId).eq("merchant_id", merchant.id);
  if (error) throw error;
  revalidatePath("/dashboard");
}

/** Turns an active rule off without deleting it — the audit trail (which
 *  trace fired which rule) stays intact either way. Reuses the existing
 *  `superseded` status rather than adding a new one: `superseded_by` stays
 *  null here, distinguishing "manually retired" from "replaced by rule X". */
export async function deactivatePolicyRule(ruleId: string) {
  await requireDashboardUser();
  const merchant = await getCurrentMerchant();
  const db = createAdminClient();
  const { error } = await db.from("policy_rules").update({ status: "superseded", superseded_by: null }).eq("id", ruleId).eq("merchant_id", merchant.id);
  if (error) throw error;
  revalidatePath("/dashboard");
}

export async function reactivatePolicyRule(ruleId: string) {
  await requireDashboardUser();
  const merchant = await getCurrentMerchant();
  const db = createAdminClient();
  const { error } = await db.from("policy_rules").update({ status: "active", superseded_by: null }).eq("id", ruleId).eq("merchant_id", merchant.id);
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
  const merchant = await getCurrentMerchant();
  const db = createAdminClient();

  const { count, error: countError } = await db
    .from("traces")
    .select("id", { count: "exact", head: true })
    .eq("merchant_id", merchant.id)
    .eq("rule_fired_id", ruleId);
  if (countError) throw countError;
  if (count && count > 0) {
    throw new Error(
      `This rule fired on ${count} transaction${count > 1 ? "s" : ""} — deactivate it instead of deleting, so that history keeps its explanation.`
    );
  }

  // Clear any rule that lists this one as "replaced by," so the delete
  // doesn't fail on the superseded_by foreign key.
  const { error: clearError } = await db.from("policy_rules").update({ superseded_by: null }).eq("superseded_by", ruleId).eq("merchant_id", merchant.id);
  if (clearError) throw clearError;

  const { error } = await db.from("policy_rules").delete().eq("id", ruleId).eq("merchant_id", merchant.id);
  if (error) throw error;
  revalidatePath("/dashboard");
}

export async function runPolicyAudit(): Promise<SemanticIssue[]> {
  await requireDashboardUser();
  const merchant = await getCurrentMerchant();
  const db = createAdminClient();
  const { data: rules, error } = await db.from("policy_rules").select("*").eq("merchant_id", merchant.id);
  if (error) throw error;
  return runSemanticPolicyAudit(rules ?? []);
}

export async function suggestFixForIssue(
  issueTitle: string,
  issueExplanation: string,
  affectedRuleIds: string[]
): Promise<FixSuggestion[]> {
  await requireDashboardUser();
  const merchant = await getCurrentMerchant();
  if (affectedRuleIds.length === 0) return [];
  const db = createAdminClient();
  const { data: rules, error } = await db.from("policy_rules").select("*").eq("merchant_id", merchant.id).in("id", affectedRuleIds);
  if (error) throw error;
  return suggestPolicyFix(issueTitle, issueExplanation, rules ?? []);
}

/** Applying a suggested fix is a second, separate, explicit click from
 *  requesting one — "suggest" never auto-applies. */
export async function applyPolicyFix(ruleId: string, proposedParams: Record<string, unknown>) {
  await requireDashboardUser();
  const merchant = await getCurrentMerchant();
  const db = createAdminClient();
  const { error } = await db.from("policy_rules").update({ params: proposedParams as unknown as Json }).eq("id", ruleId).eq("merchant_id", merchant.id);
  if (error) throw error;
  revalidatePath("/dashboard");
}

/**
 * Replays a range of step-up thresholds against this merchant's own recent
 * traffic so they can see the revenue/friction trade before committing to it.
 *
 * Only actions the step-up rule could plausibly have decided are sampled.
 * Anything a cap or category ban refused is excluded rather than counted as
 * "would clear" — those are refused at any threshold, and including them would
 * make raising the dial look like it unlocks money a different rule was always
 * going to stop.
 */
export async function replayStepUpThresholds(): Promise<{
  currency: string;
  currentThreshold: number | null;
  sampleSize: number;
  current: ThresholdOutcome | null;
  options: ThresholdOutcome[];
}> {
  await requireDashboardUser();
  const merchant = await getCurrentMerchant();
  const db = createAdminClient();

  const { data: rules, error: rulesError } = await db
    .from("policy_rules")
    .select("id, type, params, status")
    .eq("status", "active");
  if (rulesError) throw rulesError;

  const stepUp = (rules ?? []).find((r) => r.type === "step_up");
  const stepUpParams = stepUp?.params as { threshold_amount?: number; currency?: string } | null;
  const currency = stepUpParams?.currency ?? "INR";
  const currentThreshold = typeof stepUpParams?.threshold_amount === "number" ? stepUpParams.threshold_amount : null;

  const { data: traces, error: tracesError } = await db
    .from("traces")
    .select("action_type, params, decision, agent_id")
    .eq("merchant_id", merchant.id)
    .eq("mode", "enforce")
    .order("created_at", { ascending: false })
    .limit(300);
  if (tracesError) throw tracesError;

  const sample: ReplayAction[] = [];
  for (const t of traces ?? []) {
    // A block was refused by a cap, a category ban or a rate limit — none of
    // which the step-up threshold governs, so it stays refused whatever this
    // dial is set to and does not belong in the sample.
    if (t.decision === "block") continue;
    const p = t.params as { amount?: number; currency?: string; category?: string } | null;
    if (typeof p?.amount !== "number" || !p.currency) continue;
    sample.push({
      amount: p.amount,
      currency: p.currency,
      category: p.category,
      actionType: t.action_type,
      agentId: t.agent_id ?? "",
    });
  }

  // Round numbers a merchant would actually pick, in paise.
  const candidates = [200000, 500000, 800000, 1200000, 2000000];
  const swept = sweepThresholds(currentThreshold ?? 500000, currency, sample, candidates);

  return {
    currency,
    currentThreshold,
    sampleSize: sample.length,
    current: currentThreshold === null ? null : swept.current,
    options: swept.options,
  };
}

/**
 * Proposes a new step-up threshold as a `pending_review` rule.
 *
 * Deliberately not applied directly, and deliberately not routed through
 * draft_policy either. Going via the LLM would round-trip an exact number the
 * merchant already chose through a model that might return a different one;
 * writing it straight to active would let a revenue dial silently loosen a
 * spending control. So it lands in the same review queue every other proposed
 * rule goes through, where the existing conflict UI can retire the rule it
 * replaces at the moment it activates.
 */
export async function proposeStepUpThreshold(thresholdAmount: number, currency: string) {
  await requireDashboardUser();
  const merchant = await getCurrentMerchant();
  if (!Number.isFinite(thresholdAmount) || thresholdAmount <= 0) {
    throw new Error("A step-up threshold has to be a positive amount.");
  }
  const db = createAdminClient();

  const rupees = (thresholdAmount / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 });
  const { error } = await db.from("policy_rules").insert({
    merchant_id: merchant.id,
    type: "step_up",
    name: `Step-up above ₹${rupees}`,
    params: { threshold_amount: thresholdAmount, currency } as unknown as Json,
    status: "pending_review",
    source: "human",
    rationale:
      `Proposed from the threshold replay: chosen after seeing what this threshold would have done to the merchant's own recent traffic. Activating this should supersede the step-up rule it replaces — two step-up rules at different thresholds means the higher one never fires.`,
  });
  if (error) throw error;

  revalidatePath("/dashboard");
}
