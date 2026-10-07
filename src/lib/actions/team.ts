"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireDashboardUser } from "./authGuard";
import { getCurrentMerchant } from "@/lib/merchant";
import { getSettings } from "@/lib/settings";
import { applyGuardrails } from "@/lib/policy/guardrails";
import { clearSampleStore, loadSampleStore } from "@/lib/sample";
import { simulateSandboxPayment } from "@/lib/sales";

/**
 * The merchant's controls over their autonomous team: the plain-language
 * guardrails, the on/off and dry-run switches, the sample store, and the sandbox
 * "customer pays" button.
 */

async function scope() {
  await requireDashboardUser();
  return { merchant: await getCurrentMerchant(), db: createAdminClient() };
}

const Rupees = z.number().finite().min(0).max(10_000_000_000);

const GuardrailInput = z.object({
  maxSinglePayoutRupees: Rupees.min(1),
  approvalThresholdRupees: Rupees.min(1),
  minMarginPercent: z.number().min(0).max(90),
  weeklyBudgetRupees: Rupees,
  budgetPercentOfRevenue: z.number().min(0).max(100),
  startingFloatRupees: Rupees,
  requireApprovedVendors: z.boolean(),
});
export type GuardrailInput = z.infer<typeof GuardrailInput>;

/**
 * Saves the merchant's plain controls and rewrites the guardrail rules from
 * them. The numbers are the whole interface: no rule types, no JSON.
 */
export async function updateGuardrails(input: GuardrailInput): Promise<void> {
  const { merchant, db } = await scope();
  const v = GuardrailInput.parse(input);
  if (v.approvalThresholdRupees > v.maxSinglePayoutRupees) {
    // An approval threshold above the hard cap would never fire: every payout big
    // enough to need approval would already be refused outright.
    throw new Error("The approval amount can't be higher than the largest single payout, or it would never ask you.");
  }
  const { error } = await db
    .from("merchant_settings")
    .update({
      max_single_payout_paise: Math.round(v.maxSinglePayoutRupees * 100),
      approval_threshold_paise: Math.round(v.approvalThresholdRupees * 100),
      min_margin_bps: Math.round(v.minMarginPercent * 100),
      weekly_payout_budget_paise: Math.round(v.weeklyBudgetRupees * 100),
      payout_budget_pct: Math.round(v.budgetPercentOfRevenue),
      starting_float_paise: Math.round(v.startingFloatRupees * 100),
      require_approved_vendors: v.requireApprovedVendors,
      updated_at: new Date().toISOString(),
    })
    .eq("merchant_id", merchant.id);
  if (error) throw new Error(error.message);
  await applyGuardrails(db, merchant.id, await getSettings(db, merchant.id));
  revalidatePath("/dashboard");
}

export async function setTeamEnabled(enabled: boolean): Promise<void> {
  const { merchant, db } = await scope();
  const { error } = await db.from("merchant_settings").update({ agents_enabled: enabled, updated_at: new Date().toISOString() }).eq("merchant_id", merchant.id);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

export async function setDryRun(on: boolean): Promise<void> {
  const { merchant, db } = await scope();
  const { error } = await db.from("merchant_settings").update({ dry_run: on, updated_at: new Date().toISOString() }).eq("merchant_id", merchant.id);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

export async function setChannelMode(mode: "sandbox" | "live"): Promise<void> {
  const { merchant, db } = await scope();
  const { error } = await db.from("merchant_settings").update({ channel_mode: mode, updated_at: new Date().toISOString() }).eq("merchant_id", merchant.id);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

export async function setWhatsAppEnabled(on: boolean): Promise<void> {
  const { merchant, db } = await scope();
  const { error } = await db.from("merchant_settings").update({ whatsapp_enabled: on, updated_at: new Date().toISOString() }).eq("merchant_id", merchant.id);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

export async function loadSample(): Promise<{ sales: number; vendors: number }> {
  const { merchant, db } = await scope();
  const r = await loadSampleStore(db, merchant.id);
  revalidatePath("/dashboard");
  return r;
}

export async function clearSample(): Promise<void> {
  const { merchant, db } = await scope();
  await clearSampleStore(db, merchant.id);
  revalidatePath("/dashboard");
}

/** The sandbox customer pays a simulated link. Refuses anything that is not a sandbox object. */
export async function settleSandboxPayment(traceId: string): Promise<{ booked: boolean }> {
  const { merchant, db } = await scope();
  const r = await simulateSandboxPayment(db, merchant.id, traceId);
  revalidatePath("/dashboard");
  return { booked: r.booked };
}
