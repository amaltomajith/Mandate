import type { SupabaseClient } from "@supabase/supabase-js";
import type { MerchantSettings } from "@/types/db";
import type { SeedRule } from "./seed";

/**
 * The merchant's plain controls, expressed as policy rules.
 *
 * A merchant thinks "never pay more than ₹50,000 at once" and "never sell below
 * 15% margin"; they do not think in rule types. The Guardrails page edits
 * `merchant_settings`, and this turns those numbers into the same rules the
 * engine already enforces, so there is one enforcement path rather than a
 * second one that could drift from it.
 *
 * Each rule carries `managed: "guardrails"` and a stable `key`, which is how a
 * later edit finds the rule to update instead of stacking a second one beside
 * it. Everything else (raw rules a merchant wrote by hand) is left alone.
 */

const INR = "INR";
const MONEY_OUT = ["payout.create"];
const SALES = ["order.create", "payment_link.create", "price.change"];

function rupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

export function guardrailRules(s: MerchantSettings): (SeedRule & { key: string })[] {
  const tag = (key: string) => ({ managed: "guardrails", key });
  return [
    {
      key: "payee_whitelist",
      type: "whitelisted_payee",
      name: "Guardrail: pay only approved payees",
      params: { ...tag("payee_whitelist"), require_vendor_approved: s.require_approved_vendors, action_types: MONEY_OUT },
      rationale: "Money only goes to a supplier and bank account a person has approved. An unknown or pending payee is refused, whatever the amount.",
    },
    {
      key: "max_single_payout",
      type: "cap",
      name: `Guardrail: no single payout over ${rupees(s.max_single_payout_paise)}`,
      params: { ...tag("max_single_payout"), max_amount: s.max_single_payout_paise, currency: INR, scope: "per_transaction", action_types: MONEY_OUT },
      rationale: "An absolute ceiling on one payout, regardless of who approves it.",
    },
    {
      key: "payee_daily_cap",
      type: "cap",
      name: `Guardrail: no more than ${rupees(s.max_single_payout_paise * 2)} a day to one payee`,
      params: { ...tag("payee_daily_cap"), max_amount: s.max_single_payout_paise * 2, currency: INR, scope: "per_payee_per_day", action_types: MONEY_OUT },
      rationale: "Stops a payout being split into many small ones to the same supplier.",
    },
    {
      key: "payout_approval",
      type: "step_up",
      name: `Guardrail: ask me for payouts of ${rupees(s.approval_threshold_paise)} or more`,
      params: { ...tag("payout_approval"), threshold_amount: s.approval_threshold_paise, currency: INR, action_types: MONEY_OUT },
      rationale: "Larger payouts wait for a human approval before any money moves.",
    },
    {
      key: "payout_budget",
      type: "payout_budget",
      name: `Guardrail: restock budget ${rupees(s.weekly_payout_budget_paise)} a week`,
      params: {
        ...tag("payout_budget"),
        currency: INR,
        period_days: 7,
        max_amount: s.weekly_payout_budget_paise,
        pct_of_revenue: s.payout_budget_pct,
        float_amount: s.starting_float_paise,
        action_types: MONEY_OUT,
      },
      rationale: `Restocking pays for itself: payouts in a week may not exceed a ${rupees(s.starting_float_paise)} starting float plus ${s.payout_budget_pct}% of what the business sold, nor ${rupees(s.weekly_payout_budget_paise)}.`,
    },
    {
      key: "min_margin",
      type: "min_margin_floor",
      name: `Guardrail: never sell below ${(s.min_margin_bps / 100).toFixed(0)}% margin`,
      params: { ...tag("min_margin"), min_margin_bps: s.min_margin_bps, action_types: SALES },
      rationale: "No price drop or sale may go under this margin, computed from the product's recorded cost. A product with no recorded cost waits for a human.",
    },
  ];
}

/** Writes the merchant's controls as rules: updates the ones that exist, adds
 *  the ones that don't. Never touches a rule without the managed marker. */
export async function applyGuardrails(db: SupabaseClient, merchantId: string, settings: MerchantSettings): Promise<void> {
  const { data: existing, error } = await db
    .from("policy_rules")
    .select("id, params")
    .eq("merchant_id", merchantId)
    .eq("params->>managed", "guardrails");
  if (error) throw new Error(error.message);
  const byKey = new Map<string, string>();
  for (const r of existing ?? []) {
    const key = (r.params as { key?: string } | null)?.key;
    if (key) byKey.set(key, r.id);
  }

  for (const rule of guardrailRules(settings)) {
    const row = {
      type: rule.type,
      name: rule.name,
      params: rule.params,
      status: "active",
      source: "human",
      rationale: rule.rationale,
    };
    const id = byKey.get(rule.key);
    const { error: writeError } = id
      ? await db.from("policy_rules").update(row).eq("id", id).eq("merchant_id", merchantId)
      : await db.from("policy_rules").insert({ ...row, merchant_id: merchantId });
    if (writeError) throw new Error(writeError.message);
  }
}

export interface GuardrailValues {
  maxSinglePayoutRupees: number;
  approvalThresholdRupees: number;
  minMarginPercent: number;
  weeklyBudgetRupees: number;
  budgetPercentOfRevenue: number;
  startingFloatRupees: number;
  requireApprovedVendors: boolean;
}

/** The settings columns a set of plain guardrail values writes. One mapping, so a
 *  preview and a save can never disagree about what a number means. */
export function guardrailPatch(v: GuardrailValues) {
  return {
    max_single_payout_paise: Math.round(v.maxSinglePayoutRupees * 100),
    approval_threshold_paise: Math.round(v.approvalThresholdRupees * 100),
    min_margin_bps: Math.round(v.minMarginPercent * 100),
    weekly_payout_budget_paise: Math.round(v.weeklyBudgetRupees * 100),
    payout_budget_pct: Math.round(v.budgetPercentOfRevenue),
    starting_float_paise: Math.round(v.startingFloatRupees * 100),
    require_approved_vendors: v.requireApprovedVendors,
  };
}
