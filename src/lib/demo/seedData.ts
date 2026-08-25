import type { PolicyRuleType } from "@/types/db";

// Shared between scripts/seed.ts (CLI) and src/lib/demo/runDemo.ts (the
// dashboard's one-click "Run demo" button) so the two setup paths can't drift
// into seeding different rules.

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
    name: "Max 5 actions/hour per agent",
    params: { max_count: 5, window_seconds: 3600, scope: "per_agent" },
    rationale: "Caps how fast any one agent identity can act, independent of amount — protects against a runaway loop.",
  },
  {
    type: "category_block",
    name: "Blocked categories",
    params: { categories: ["gambling", "crypto"] },
    rationale: "Categories this merchant has decided no agent may transact in, at any amount.",
  },
];

export const SEED_CUSTOMER = { name: "Demo Customer", email: "demo-customer@example.com" };
