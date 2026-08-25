/**
 * Seeds the four starter policy rules the demo script (HANDOVER.md "Demo script")
 * depends on, plus one sample customer. Safe to re-run — it upserts by rule name.
 *
 * Shares its rule/customer definitions with src/lib/demo/runDemo.ts (the
 * dashboard's one-click "Run demo" button) via src/lib/demo/seedData.ts, so
 * the CLI and the button can't seed different data.
 *
 * Usage: npx tsx scripts/seed.ts
 */
import "./lib/loadEnv";
import { createClient } from "@supabase/supabase-js";
import { SEED_CUSTOMER, SEED_RULES } from "../src/lib/demo/seedData";

// See scripts/gen-agent-key.ts for why this doesn't import src/lib/supabase/admin.ts.
function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set.");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function main() {
  const db = createAdminClient();

  for (const rule of SEED_RULES) {
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

  const { data: existingCustomer } = await db.from("customers").select("id").eq("name", SEED_CUSTOMER.name).maybeSingle();
  if (!existingCustomer) {
    const { data, error } = await db.from("customers").insert(SEED_CUSTOMER).select().single();
    if (error) throw error;
    console.log(`Created customer "${data.name}" (${data.id})`);
  } else {
    console.log(`Customer "${SEED_CUSTOMER.name}" already exists (${existingCustomer.id}) — skipping.`);
  }

  console.log("\nSeed complete.");
}

main().catch((err) => {
  console.error("\nSeed failed:", err);
  process.exit(1);
});
