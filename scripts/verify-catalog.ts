/**
 * Retiring a product has to reach every reader of the catalog.
 *
 * Four things read it: the public /catalog route, the headroom probe,
 * counter-offer candidates and campaign planning. Three go through
 * `fetchCatalog`; /catalog runs its own query. That split is exactly the shape
 * of bug worth a test — a deactivated SKU that is still offerable would look
 * completely fine from the dashboard, because the dashboard reads the table
 * directly and would show it retired while an agent was still being sold it.
 *
 * The counter-offer check is the one most likely to pass for the wrong reason,
 * so it is written to fail loudly if it ever stops proving anything: it asserts
 * the retired SKU can be offered BEFORE retiring it, so "not offered after" is
 * a change rather than a vacuous truth about an empty candidate list.
 */
import "./lib/loadEnv";
import { createClient } from "@supabase/supabase-js";
import { fetchCatalog, applySeedProducts, PRODUCT_CATEGORIES } from "../src/lib/demo/catalog";

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const BASE = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

const results: [string, boolean, string][] = [];
const check = (n: string, ok: boolean, d = "") => {
  results.push([n, ok, d]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${n.padEnd(54)} ${d}`);
};

async function main() {
  const slug = `cat-${Math.random().toString(36).slice(2, 7)}`;
  const { data: m } = await db.from("merchants").insert({ name: "Catalog Test", slug }).select().single();
  await applySeedProducts(db, m!.id);

  try {
    const before = await fetchCatalog(db, m!.id);
    check("the live catalog starts populated", before.length >= 2, `${before.length} product(s)`);

    const victim = before[0];

    // /catalog serves it, and still withholds the thresholds.
    const res = await fetch(`${BASE}/api/m/${slug}/catalog`);
    const body = (await res.json()) as { catalog: { sku: string }[] };
    check(
      "/catalog serves the active product",
      body.catalog.some((c) => c.sku === victim.sku),
      victim.sku
    );
    const raw = JSON.stringify(body);
    check(
      "/catalog still withholds policy thresholds",
      !/threshold_amount|max_amount|min_score|step_up/.test(raw),
      "no rule internals in the payload"
    );

    // The candidate pool a counter-offer draws from is the live catalog minus
    // the parent. Asserted BEFORE retiring, so the check below is a change.
    const candidatesBefore = (await fetchCatalog(db, m!.id)).filter((c) => c.sku !== before[1].sku);
    check(
      "the retired-to-be sku is offerable beforehand",
      candidatesBefore.some((c) => c.sku === victim.sku),
      `${candidatesBefore.length} candidate(s)`
    );

    // ---- retire it
    const { error } = await db.from("products").update({ active: false }).eq("merchant_id", m!.id).eq("sku", victim.sku);
    if (error) throw new Error(error.message);

    const after = await fetchCatalog(db, m!.id);
    check("fetchCatalog drops it", !after.some((c) => c.sku === victim.sku), `${after.length} left`);

    const candidatesAfter = after.filter((c) => c.sku !== before[1].sku);
    check(
      "it is no longer a counter-offer candidate",
      !candidatesAfter.some((c) => c.sku === victim.sku),
      `${candidatesAfter.length} candidate(s)`
    );

    // The route caches for 60s, so ask past it -- otherwise this asserts the
    // cache, not the filter.
    const res2 = await fetch(`${BASE}/api/m/${slug}/catalog?t=${Date.now()}`, { cache: "no-store" });
    const body2 = (await res2.json()) as { catalog: { sku: string }[] };
    check(
      "/catalog stops advertising it",
      !body2.catalog.some((c) => c.sku === victim.sku),
      `${body2.catalog.length} advertised`
    );

    // The row survives, so history still resolves.
    const { data: still } = await db
      .from("products")
      .select("sku, active")
      .eq("merchant_id", m!.id)
      .eq("sku", victim.sku)
      .maybeSingle();
    check("the row survives so past traces still resolve", !!still && still.active === false, victim.sku);

    // Restoring puts it back everywhere.
    await db.from("products").update({ active: true }).eq("merchant_id", m!.id).eq("sku", victim.sku);
    const restored = await fetchCatalog(db, m!.id);
    check("restoring brings it back", restored.some((c) => c.sku === victim.sku), `${restored.length} product(s)`);

    // Seeded products must all carry a category the engine can match on, or a
    // category_block rule silently misses them.
    const unknown = restored.filter((c) => !(PRODUCT_CATEGORIES as readonly string[]).includes(c.category));
    check("every seeded product has a known category", unknown.length === 0, unknown.map((u) => u.category).join(", "));
  } finally {
    await db.from("merchants").delete().eq("id", m!.id);
  }

  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
