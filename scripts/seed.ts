/**
 * Seeds the four starter policy rules the demo script (HANDOVER.md "Demo script")
 * depends on, plus one sample customer. Safe to re-run — it upserts by rule name.
 *
 * Usage: npx tsx scripts/seed.ts
 */
import "./lib/loadEnv";
import { createClient } from "@supabase/supabase-js";

// See scripts/gen-agent-key.ts for why this doesn't import src/lib/supabase/admin.ts.
function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set.");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function main() {
  const db = createAdminClient();

  const rules = [
    {
      type: "step_up" as const,
      name: "Step-up above ₹5,000",
      params: { threshold_amount: 500000, currency: "INR" },
      rationale: "Payouts and orders at or above ₹5,000 need a human's sign-off before they execute.",
    },
    {
      type: "cap" as const,
      name: "Per-transaction cap ₹20,000",
      params: { max_amount: 2000000, currency: "INR", scope: "per_transaction" },
      rationale: "No single action should ever exceed ₹20,000 — an absolute ceiling regardless of who approves it.",
    },
    {
      type: "velocity" as const,
      name: "Max 5 actions/hour per agent",
      params: { max_count: 5, window_seconds: 3600, scope: "per_agent" },
      rationale: "Caps how fast any one agent identity can act, independent of amount — protects against a runaway loop.",
    },
    {
      type: "category_block" as const,
      name: "Blocked categories",
      params: { categories: ["gambling", "crypto"] },
      rationale: "Categories this merchant has decided no agent may transact in, at any amount.",
    },
  ];

  for (const rule of rules) {
    const { data: existing } = await db.from("policy_rules").select("id").eq("name", rule.name).maybeSingle();
    if (existing) {
      console.log(`Rule "${rule.name}" already exists (${existing.id}) — skipping.`);
      continue;
    }
    const { data, error } = await db
      .from("policy_rules")
      .insert({ type: rule.type, name: rule.name, params: rule.params, status: "active", source: "human", rationale: rule.rationale })
      .select()
      .single();
    if (error) throw error;
    console.log(`Created rule "${data.name}" (${data.id})`);
  }

  const { data: existingCustomer } = await db.from("customers").select("id").eq("name", "Demo Customer").maybeSingle();
  if (!existingCustomer) {
    const { data, error } = await db
      .from("customers")
      .insert({ name: "Demo Customer", email: "demo-customer@example.com" })
      .select()
      .single();
    if (error) throw error;
    console.log(`Created customer "${data.name}" (${data.id})`);
  } else {
    console.log(`Customer "Demo Customer" already exists (${existingCustomer.id}) — skipping.`);
  }

  console.log("\nSeed complete.");
}

main();
