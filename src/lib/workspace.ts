import type { SupabaseClient } from "@supabase/supabase-js";
import { applySeedProducts } from "@/lib/catalog";
import { applySeedRules } from "@/lib/policy/seed";
import { applyGuardrails } from "@/lib/policy/guardrails";
import { ensureInhouseAgents } from "@/lib/agents/inhouse";
import { DEFAULT_SETTINGS, getSettings } from "@/lib/settings";
import type { MerchantSettings } from "@/types/db";

/**
 * Makes a merchant's account complete: starting rules, a starting catalog, the
 * Selling and Buying agents, and the guardrail rules written from their
 * settings. Safe to call repeatedly; each step is idempotent.
 *
 * The settings row is written LAST and doubles as the "done" marker, so a call
 * that dies halfway is simply run again on the next load instead of leaving a
 * merchant who looks provisioned but has no agents or guardrails.
 */
export async function ensureWorkspace(db: SupabaseClient, merchantId: string): Promise<void> {
  const { data } = await db.from("merchant_settings").select("merchant_id").eq("merchant_id", merchantId).maybeSingle();
  if (data) return;

  await applySeedRules(db, merchantId);
  await applySeedProducts(db, merchantId);
  await ensureInhouseAgents(db, merchantId);
  await applyGuardrails(db, merchantId, { merchant_id: merchantId, updated_at: "", ...DEFAULT_SETTINGS } as MerchantSettings);
  await getSettings(db, merchantId);
}
