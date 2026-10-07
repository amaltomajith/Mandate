import type { SupabaseClient } from "@supabase/supabase-js";
import type { MerchantSettings } from "@/types/db";

/**
 * A merchant's plain-language controls. Created on first read with the schema
 * defaults, so every caller can assume a row exists. Never trusts a merchant id
 * from outside: callers pass the one they already resolved.
 */
export async function getSettings(db: SupabaseClient, merchantId: string): Promise<MerchantSettings> {
  const { data, error } = await db.from("merchant_settings").select("*").eq("merchant_id", merchantId).maybeSingle();
  if (error) throw new Error(error.message);
  if (data) return data as MerchantSettings;

  const { data: created, error: insertError } = await db
    .from("merchant_settings")
    .upsert({ merchant_id: merchantId }, { onConflict: "merchant_id", ignoreDuplicates: true })
    .select("*")
    .maybeSingle();
  if (insertError) throw new Error(insertError.message);
  if (created) return created as MerchantSettings;
  // Lost an insert race to another request; the row exists now.
  const { data: again, error: againError } = await db.from("merchant_settings").select("*").eq("merchant_id", merchantId).single();
  if (againError) throw new Error(againError.message);
  return again as MerchantSettings;
}

/** Mirrors the column defaults in migration 0020/0021, for callers that need
 *  the numbers before the row exists (first-time provisioning). */
export const DEFAULT_SETTINGS = {
  max_single_payout_paise: 5_000_000,
  approval_threshold_paise: 1_000_000,
  min_margin_bps: 1500,
  weekly_payout_budget_paise: 10_000_000,
  payout_budget_pct: 70,
  starting_float_paise: 2_500_000,
  require_approved_vendors: true,
  agents_enabled: true,
  dry_run: false,
  channel_mode: "sandbox" as const,
  whatsapp_enabled: false,
};
