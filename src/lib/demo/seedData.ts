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
    type: "category_block",
    name: "Blocked categories",
    params: { categories: ["gambling", "crypto"] },
    rationale: "Categories this merchant has decided no agent may transact in, at any amount.",
  },
  {
    type: "velocity",
    name: "Rapid-repeat guard: 20 actions / 2 min per agent",
    params: { max_count: 20, window_seconds: 120, scope: "per_agent" },
    rationale:
      "Amount-blind, like all velocity rules: it's the rate that's suspicious, not any single action's size — this is what catches an agent firing many small actions rapidly instead of one that would have needed approval. Tuned against the simulation's speed settings: Calm and Busy stay comfortably inside it, while Stress deliberately outruns it, so the rate limiter can be seen engaging rather than only described.",
  },
  {
    type: "trust_floor",
    name: "Hold agents below trust 35",
    params: { min_score: 35, action: "escalate" },
    rationale:
      "Reputation, made consequential. Every agent starts at a neutral 50 and moves with its own record — an agent that has been blocked repeatedly, or has had forged requests rejected in its name, falls. Below 35 its actions are held for a human regardless of amount, because the problem is the caller, not the transaction. Set below the starting score deliberately: a new agent is unproven, not suspect, and shouldn't be punished for having no history.",
  },
];

export const SEED_CUSTOMER = { name: "Demo Customer", email: "demo-customer@example.com" };

/** Renamed from "Max 5 actions/hour per agent" early in this project — that
 *  limit was tight enough to make the dashboard's repeatable "Run demo"
 *  button start blocking real actions after one run. If a row with the old
 *  name is still sitting in an existing project, rename+update it in place
 *  instead of leaving it active alongside a new one (which would mean BOTH
 *  the old 5/hour and new 30/hour limits applying — the stricter one wins). */
/** Rules that must be retired on re-seed rather than left active. Each older definition
 *  must be retired when re-seeding, not left active beside the current one:
 *  two overlapping velocity rules is exactly the conflict `auditPolicySet`
 *  flags, and the looser of the two would silently never fire. Retiring
 *  (superseded) rather than deleting keeps any trace that cites one of these
 *  as its reason intact. */
const RETIRED_RULE_NAMES = [
  // Scoped to the old "Recurring Mandates" domain, where a ₹1,000 step-up and
  // a ₹2,000 ceiling were deliberately tighter than the purchases domain's.
  // With domains removed every rule applies to every action, so these stopped
  // governing standing authorizations and started refusing ordinary orders —
  // a ₹2,199 laptop stand blocked by a cap written for recurring debits.
  "Mandate step-up above ₹1,000",
  "Mandate per-transaction cap ₹2,000",
  "Max 5 actions/hour per agent",
  "Max 30 actions/hour per agent",
  "Rapid-repeat guard: 10 actions / 5 min per agent",
  "Rapid-repeat guard: 6 actions / 2 min per agent",
];

export async function applySeedRules(db: SupabaseClient): Promise<{ created: number; migrated: boolean }> {
  let created = 0;
  let migrated = false;

  const { data: retired, error: retiredError } = await db
    .from("policy_rules")
    .update({ status: "superseded" })
    .in("name", RETIRED_RULE_NAMES)
    .eq("status", "active")
    .select("id");
  if (retiredError) throw retiredError;
  migrated = (retired?.length ?? 0) > 0;

  for (const rule of SEED_RULES) {
    const { data: existing } = await db.from("policy_rules").select("id").eq("name", rule.name).maybeSingle();
    if (existing) continue;
    const { error } = await db.from("policy_rules").insert({
      type: rule.type,
      name: rule.name,
      params: rule.params,
      status: "active",
      source: "human",
      rationale: rule.rationale,
    });
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
