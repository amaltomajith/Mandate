/**
 * Inventory maths against the sample store: the story it tells must be the one
 * the agents are built around (a bestseller running out, dead stock tying up
 * cash). Needs the database, not the dev server.
 *
 *   npx tsx --tsconfig worker/tsconfig.json scripts/verify-inventory.ts
 */
import "./lib/loadEnv";
import { createAdminClient } from "../src/lib/supabase/admin";
import { ensureWorkspace } from "../src/lib/workspace";
import { loadSampleStore, clearSampleStore } from "../src/lib/sample";
import { getInventoryInsights, floorPrice, deadStockValue } from "../src/lib/inventory";

const db = createAdminClient();
let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

async function main() {
  const rnd = Math.random().toString(36).slice(2, 8);
  const { data: m, error } = await db.from("merchants").insert({ name: "inv", slug: `verify-inv-${rnd}` }).select("*").single();
  if (error) throw new Error(error.message);
  try {
    await ensureWorkspace(db, m.id);
    const before = await getInventoryInsights(db, m.id, 1500);
    check("a fresh account has no sales, so nothing is 'low' by velocity", before.every((i) => !i.needsRestock));

    const loaded = await loadSampleStore(db, m.id);
    check("sample store loads sales and vendors", loaded.sales > 100 && loaded.vendors === 2, JSON.stringify(loaded));

    const ins = await getInventoryInsights(db, m.id, 1500);
    const by = Object.fromEntries(ins.map((i) => [i.sku, i]));
    check("keyboard-01 is a bestseller running out", by["keyboard-01"].status === "low" && by["keyboard-01"].needsRestock, JSON.stringify({ s: by["keyboard-01"].status, r: by["keyboard-01"].runwayDays }));
    check("keyboard-01 reorder quantity covers lead time + a month", by["keyboard-01"].reorderQty > 40 && by["keyboard-01"].reorderQty < 120, String(by["keyboard-01"].reorderQty));
    check("mouse-01 is healthy", by["mouse-01"].status === "healthy" && !by["mouse-01"].needsRestock, by["mouse-01"].status);
    check("hub-01 is dead stock", by["hub-01"].status === "dead", by["hub-01"].status);
    check("desk-01 is dead stock", by["desk-01"].status === "dead", by["desk-01"].status);
    check("stand-01 is overstocked", by["stand-01"].status === "overstock", by["stand-01"].status);
    check("dead stock never needs restocking", !by["hub-01"].needsRestock && !by["desk-01"].needsRestock);
    check("cash tied up is stock x cost", by["hub-01"].cashTiedPaise === 220 * 70000, String(by["hub-01"].cashTiedPaise));
    check("dead + overstock value sums at cost", deadStockValue(ins) === 220 * 70000 + 18 * 460000 + 90 * 125000, String(deadStockValue(ins)));
    check("floor price keeps the margin", floorPrice(70000, 1500) === Math.ceil(70000 / 0.85));
    check("floor price is above cost", by["hub-01"].floorPricePaise! > by["hub-01"].costPaise!);

    await clearSampleStore(db, m.id);
    const { data: left } = await db.from("sales").select("id").eq("merchant_id", m.id);
    check("clearing the sample store removes its sales", (left ?? []).length === 0);
    const { data: vendors } = await db.from("vendors").select("id").eq("merchant_id", m.id);
    check("and its vendors", (vendors ?? []).length === 0);
  } finally {
    await db.from("merchants").delete().eq("id", m.id);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
