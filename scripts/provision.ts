/**
 * Makes a merchant's account complete from the command line: starting rules,
 * catalog, the Selling and Buying agents, settings and guardrails. Idempotent.
 * Add --sample to also load the sample store (labelled sandbox data).
 *
 *   npm run provision -- --slug demo --sample
 */
import "./lib/loadEnv";
import { createAdminClient } from "../src/lib/supabase/admin";
import { ensureWorkspace } from "../src/lib/workspace";
import { loadSampleStore } from "../src/lib/sample";
import { merchantForScript } from "./lib/merchant";

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf("--slug");
  if (i >= 0) process.env.MANDATE_MERCHANT_SLUG = args[i + 1];
  const db = createAdminClient();
  const merchant = await merchantForScript(db);
  await ensureWorkspace(db, merchant.id);
  console.log(`Workspace ready for "${merchant.slug}".`);
  if (args.includes("--sample")) {
    const r = await loadSampleStore(db, merchant.id);
    console.log(`Sample store loaded: ${r.sales} sales, ${r.vendors} suppliers.`);
  }
}

main().catch((err) => {
  console.error("\nProvisioning failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
