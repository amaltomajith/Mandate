import type { SupabaseClient } from "@supabase/supabase-js";
import type { PolicyRuleType } from "@/types/db";

// Shared between scripts/seed.ts (CLI) and src/lib/demo/runDemo.ts (the
// dashboard's one-click "Run demo" button) so the two setup paths can't drift
// into seeding different rules — and so there's exactly one place that knows
// how to upsert them, including the one-time rename migration below.

export interface SeedRule {
  type: PolicyRuleType;
  name: string;
  params: Record<string, unknown>;
  rationale: string;
}

export const SEED_RULES: SeedRule[] = [
  {
    type: "step_up",
    name: "Step-up above ₹5,000",
    params: { threshold_amount: 500000, currency: "INR" },
    rationale: "Payouts and orders at or above ₹5,000 need a human's sign-off before they execute.",
  },
  {
    type: "cap",
    name: "Per-transaction cap ₹20,000",
    params: { max_amount: 2000000, currency: "INR", scope: "per_transaction" },
    rationale: "No single action should ever exceed ₹20,000 — an absolute ceiling regardless of who approves it.",
  },
  {
    type: "velocity",
    name: "Max 30 actions/hour per agent",
    params: { max_count: 30, window_seconds: 3600, scope: "per_agent" },
    rationale:
      "Caps how fast any one agent identity can act, independent of amount — protects against a runaway loop. Set high enough that running the demo several times in an hour doesn't trip it; this rule exists to stop a malfunctioning agent, not a healthy one.",
  },
  {
    type: "category_block",
    name: "Blocked categories",
    params: { categories: ["gambling", "crypto"] },
    rationale: "Categories this merchant has decided no agent may transact in, at any amount.",
  },
];

export const SEED_CUSTOMER = { name: "Demo Customer", email: "demo-customer@example.com" };

/** Renamed from "Max 5 actions/hour per agent" early in this project — that
 *  limit was tight enough to make the dashboard's repeatable "Run demo"
 *  button start blocking real actions after one run. If a row with the old
 *  name is still sitting in an existing project, rename+update it in place
 *  instead of leaving it active alongside a new one (which would mean BOTH
 *  the old 5/hour and new 30/hour limits applying — the stricter one wins). */
const LEGACY_VELOCITY_RULE_NAME = "Max 5 actions/hour per agent";

export async function applySeedRules(db: SupabaseClient): Promise<{ created: number; migrated: boolean }> {
  let created = 0;
  let migrated = false;

  const { data: legacy } = await db.from("policy_rules").select("id").eq("name", LEGACY_VELOCITY_RULE_NAME).maybeSingle();
  if (legacy) {
    const velocityRule = SEED_RULES.find((r) => r.type === "velocity")!;
    const { error } = await db
      .from("policy_rules")
      .update({ name: velocityRule.name, params: velocityRule.params, rationale: velocityRule.rationale })
      .eq("id", legacy.id);
    if (error) throw error;
    migrated = true;
  }

  for (const rule of SEED_RULES) {
    const { data: existing } = await db.from("policy_rules").select("id").eq("name", rule.name).maybeSingle();
    if (existing) continue;
    const { error } = await db
      .from("policy_rules")
      .insert({ type: rule.type, name: rule.name, params: rule.params, status: "active", source: "human", rationale: rule.rationale });
    if (error) throw error;
    created++;
  }

  const { data: existingCustomer } = await db.from("customers").select("id").eq("name", SEED_CUSTOMER.name).maybeSingle();
  if (!existingCustomer) {
    const { error } = await db.from("customers").insert(SEED_CUSTOMER);
    if (error) throw error;
  }

  return { created, migrated };
}
