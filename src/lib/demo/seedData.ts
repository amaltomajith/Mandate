import type { SupabaseClient } from "@supabase/supabase-js";
import type { PolicyRuleType } from "@/types/db";

// Shared between scripts/seed.ts (CLI) and src/lib/demo/runDemo.ts (the
// dashboard's one-click "Run demo" button) so the two setup paths can't drift
// into seeding different rules — and so there's exactly one place that knows
// how to upsert them, including the one-time rename migration below.

export interface SeedDomain {
  name: string;
  description: string;
  matchActionTypes: string[];
  matchCategories: string[];
  isDefault: boolean;
  positionX: number;
  positionY: number;
  color: string;
}

/** The two domains real, exercisable-today action types split into — see
 *  src/lib/policy/domains.ts for why not more, and why not fewer. Explicit,
 *  distinct positions and colors so the first-ever load of the canvas
 *  doesn't show two cards stacked exactly on top of each other at (0, 0) —
 *  caught testing against a freshly-migrated database, where the column
 *  defaults alone would have made both identical. */
export const SEED_DOMAINS: SeedDomain[] = [
  {
    name: "Purchases",
    description: "One-time orders and refunds — each bounded to a single transaction. The catch-all default: anything not claimed by a more specific domain lands here.",
    matchActionTypes: ["order.create", "refund.create"],
    matchCategories: [],
    isDefault: true,
    positionX: 40,
    positionY: 40,
    color: "#4f9dff",
  },
  {
    name: "Recurring Mandates",
    description: "Standing UPI Autopay authorizations. A future liability, not a single bounded transaction — governed independently, and more tightly, than a one-time purchase.",
    matchActionTypes: ["subscription.create"],
    matchCategories: [],
    isDefault: false,
    positionX: 380,
    positionY: 40,
    color: "#a78bfa",
  },
];

export interface SeedRule {
  type: PolicyRuleType;
  name: string;
  domain: "purchases" | "mandates";
  params: Record<string, unknown>;
  rationale: string;
}

export const SEED_RULES: SeedRule[] = [
  {
    type: "step_up",
    name: "Step-up above ₹5,000",
    domain: "purchases",
    params: { threshold_amount: 500000, currency: "INR" },
    rationale: "Payouts and orders at or above ₹5,000 need a human's sign-off before they execute.",
  },
  {
    type: "cap",
    name: "Per-transaction cap ₹20,000",
    domain: "purchases",
    params: { max_amount: 2000000, currency: "INR", scope: "per_transaction" },
    rationale: "No single action should ever exceed ₹20,000 — an absolute ceiling regardless of who approves it.",
  },
  {
    type: "category_block",
    name: "Blocked categories",
    domain: "purchases",
    params: { categories: ["gambling", "crypto"] },
    rationale: "Categories this merchant has decided no agent may transact in, at any amount.",
  },
  {
    type: "velocity",
    name: "Rapid-repeat guard: 6 actions / 2 min per agent",
    domain: "purchases",
    params: { max_count: 6, window_seconds: 120, scope: "per_agent" },
    rationale:
      "Catches an agent trying to structure around the step-up threshold — many small actions fired rapidly instead of one that would have required approval. Amount-blind, like all velocity rules: it's the rate that's suspicious, not any single action's size. Tuned against the real demo: four ordinary purchases precede the structuring attempt, so the third chunk is the one that trips it. The two-minute window is deliberately short — long enough that a single run's actions all fall inside it, short enough that re-running the demo a couple of minutes later starts clean instead of being blocked by the previous run's history.",
  },
  {
    type: "step_up",
    name: "Mandate step-up above ₹1,000",
    domain: "mandates",
    params: { threshold_amount: 100000, currency: "INR" },
    rationale:
      "A recurring mandate is a standing future liability, not a single bounded transaction — independently, and more tightly, governed than one-time purchases. Set above the demo's own ₹199 mandate-establishment amount so establishing a mandate still allows outright; only a genuinely large recurring authorization escalates.",
  },
  {
    type: "cap",
    name: "Mandate per-transaction cap ₹2,000",
    domain: "mandates",
    params: { max_amount: 200000, currency: "INR", scope: "per_transaction" },
    rationale: "Caps how large a single recurring-mandate authorization can be, independent of the one-time-purchase cap above.",
  },
];

export const SEED_CUSTOMER = { name: "Demo Customer", email: "demo-customer@example.com" };

/** Idempotent by name — creates the two seed domains if missing, returns
 *  their ids either way. Never overwrites an existing domain's routing
 *  rules: if the merchant has already edited "Purchases" via the canvas,
 *  re-running this must not clobber that. */
export async function applySeedDomains(db: SupabaseClient): Promise<Record<"purchases" | "mandates", string>> {
  const ids: Record<"purchases" | "mandates", string> = { purchases: "", mandates: "" };
  const key = (name: string): "purchases" | "mandates" => (name === "Purchases" ? "purchases" : "mandates");

  for (const domain of SEED_DOMAINS) {
    const { data: existing } = await db.from("policy_domains").select("id").eq("name", domain.name).maybeSingle();
    if (existing) {
      ids[key(domain.name)] = existing.id;
      continue;
    }
    const { data, error } = await db
      .from("policy_domains")
      .insert({
        name: domain.name,
        description: domain.description,
        match_action_types: domain.matchActionTypes,
        match_categories: domain.matchCategories,
        is_default: domain.isDefault,
        position_x: domain.positionX,
        position_y: domain.positionY,
        color: domain.color,
      })
      .select("id")
      .single();
    if (error) throw error;
    ids[key(domain.name)] = data.id;
  }

  return ids;
}

/** Renamed from "Max 5 actions/hour per agent" early in this project — that
 *  limit was tight enough to make the dashboard's repeatable "Run demo"
 *  button start blocking real actions after one run. If a row with the old
 *  name is still sitting in an existing project, rename+update it in place
 *  instead of leaving it active alongside a new one (which would mean BOTH
 *  the old 5/hour and new 30/hour limits applying — the stricter one wins). */
/** This domain's velocity guard has been retuned more than once. Each older
 *  definition must be retired when re-seeding, not left active beside the
 *  current one: two overlapping velocity rules in a single domain is exactly
 *  the conflict `auditPolicySet` flags, and the looser of the two would
 *  silently never fire. Retiring (superseded) rather than deleting keeps any
 *  trace that cites one of these as its reason intact. */
const RETIRED_VELOCITY_RULE_NAMES = [
  "Max 5 actions/hour per agent",
  "Max 30 actions/hour per agent",
  "Rapid-repeat guard: 10 actions / 5 min per agent",
];

export async function applySeedRules(db: SupabaseClient): Promise<{ created: number; migrated: boolean }> {
  let created = 0;
  let migrated = false;

  const domainIds = await applySeedDomains(db);

  const { data: retired, error: retiredError } = await db
    .from("policy_rules")
    .update({ status: "superseded" })
    .in("name", RETIRED_VELOCITY_RULE_NAMES)
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
      domain_id: domainIds[rule.domain],
      params: rule.params,
      status: "active",
      source: "human",
      rationale: rule.rationale,
    });
    if (error) throw error;
    created++;
  }

  // Backfill: any rule created before policy domains existed has
  // domain_id = null, which the domain-scoped evaluator would never match
  // to anything — silently disabling it. Every such rule was, in effect,
  // a "purchases"-only rule already (the only domain that existed), so
  // that's the honest default to backfill to, not a guess.
  const { error: backfillError } = await db
    .from("policy_rules")
    .update({ domain_id: domainIds.purchases })
    .is("domain_id", null);
  if (backfillError) throw backfillError;

  const { data: existingCustomer } = await db.from("customers").select("id").eq("name", SEED_CUSTOMER.name).maybeSingle();
  if (!existingCustomer) {
    const { error } = await db.from("customers").insert(SEED_CUSTOMER);
    if (error) throw error;
  }

  return { created, migrated };
}
