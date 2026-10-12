"use server";

import { revalidatePath } from "next/cache";
import { ChannelModeSchema, PayoutModeSchema, parse } from "./schemas";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireDashboardUser } from "./authGuard";
import { getCurrentMerchant } from "@/lib/merchant";
import { getSettings } from "@/lib/settings";
import { changedFields, logConfigChange } from "@/lib/configLog";
import { applyGuardrails } from "@/lib/policy/guardrails";
import { clearSampleStore, loadSampleStore } from "@/lib/sample";
import { simulateSandboxPayment } from "@/lib/sales";

/**
 * The merchant's controls over their autonomous team: the plain-language
 * guardrails, the on/off and dry-run switches, the sample store, and the sandbox
 * "customer pays" button.
 */

async function scope() {
  const user = await requireDashboardUser();
  return { user, merchant: await getCurrentMerchant(), db: createAdminClient() };
}

/**
 * Updates merchant_settings and records who changed what. One path for every
 * setting that bounds the team, so none of them can change without a record.
 */
async function updateSettings(patch: Record<string, unknown>): Promise<{ merchantId: string; db: ReturnType<typeof createAdminClient> }> {
  const { user, merchant, db } = await scope();
  const before = (await getSettings(db, merchant.id)) as unknown as Record<string, unknown>;
  const { error } = await db
    .from("merchant_settings")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("merchant_id", merchant.id);
  if (error) throw new Error(error.message);
  await logConfigChange(db as never, merchant.id, user.email, changedFields(before, { ...before, ...patch }, Object.keys(patch)));
  return { merchantId: merchant.id, db };
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
  const v = GuardrailInput.parse(input);
  if (v.approvalThresholdRupees > v.maxSinglePayoutRupees) {
    // An approval threshold above the hard cap would never fire: every payout big
    // enough to need approval would already be refused outright.
    throw new Error("The approval amount can't be higher than the largest single payout, or it would never ask you.");
  }
  const { merchantId, db } = await updateSettings({
    max_single_payout_paise: Math.round(v.maxSinglePayoutRupees * 100),
    approval_threshold_paise: Math.round(v.approvalThresholdRupees * 100),
    min_margin_bps: Math.round(v.minMarginPercent * 100),
    weekly_payout_budget_paise: Math.round(v.weeklyBudgetRupees * 100),
    payout_budget_pct: Math.round(v.budgetPercentOfRevenue),
    starting_float_paise: Math.round(v.startingFloatRupees * 100),
    require_approved_vendors: v.requireApprovedVendors,
  });
  await applyGuardrails(db, merchantId, await getSettings(db, merchantId));
  revalidatePath("/dashboard");
}

export async function setTeamEnabled(enabled: boolean): Promise<void> {
  await updateSettings({ agents_enabled: enabled });
  revalidatePath("/dashboard");
}

export async function setDryRun(on: boolean): Promise<void> {
  await updateSettings({ dry_run: on });
  revalidatePath("/dashboard");
}

export async function setChannelMode(rawMode: "sandbox" | "live"): Promise<void> {
  const mode = parse(ChannelModeSchema, rawMode, "The mode");
  await updateSettings({ channel_mode: mode });
  revalidatePath("/dashboard");
}

export async function setPayoutMode(rawMode: "auto" | "manual"): Promise<void> {
  const mode = parse(PayoutModeSchema, rawMode, "The payout mode");
  await updateSettings({ payout_mode: mode });
  revalidatePath("/dashboard");
}

export async function setWhatsAppEnabled(on: boolean): Promise<void> {
  await updateSettings({ whatsapp_enabled: on });
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
