/**
 * Seeds the four starter policy rules the demo script (HANDOVER.md "Demo script")
 * depends on, plus one sample customer. Safe to re-run — it upserts by rule name
 * and migrates the one rule that was renamed early on (see seedData.ts).
 *
 * Shares its rule/customer definitions and upsert logic with
 * src/lib/demo/runDemo.ts (the dashboard's one-click "Run demo" button) via
 * src/lib/demo/seedData.ts, so the CLI and the button can't drift into
 * seeding different data.
 *
 * Usage: npx tsx scripts/seed.ts
 */
import "./lib/loadEnv";
import { createClient } from "@supabase/supabase-js";
import { applySeedRules } from "../src/lib/demo/seedData";
import { merchantForScript } from "./lib/merchant";

// Builds its own service-role client rather than importing
// src/lib/supabase/admin.ts: that module is guarded with `import "server-only"`,
// which throws outside Next's server bundler context (i.e. under plain tsx).
function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set.");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function main() {
  const db = createAdminClient();
  const { created, migrated } = await applySeedRules(db, (await merchantForScript(db)).id);

  if (migrated) console.log("Retired an out-of-date velocity rule (superseded, not deleted — traces still cite it).");
  console.log(created > 0 ? `Created ${created} new rule(s).` : "All rules already existed — nothing to create.");
  console.log("\nSeed complete.");
}

main().catch((err) => {
  console.error("\nSeed failed:", err);
  process.exit(1);
});
