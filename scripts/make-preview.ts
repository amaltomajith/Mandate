/**
 * Builds (or refreshes) a preview account with a realistic amount of activity, so
 * the dashboard and the 3D map have something to show. Needs the dev server.
 *
 *   npx tsx --tsconfig worker/tsconfig.json scripts/make-preview.ts
 *   then open /dev/preview?slug=preview  (needs MANDATE_DEV_PREVIEW=1)
 */
import "./lib/loadEnv";
import { createAdminClient } from "../src/lib/supabase/admin";
import { ensureWorkspace } from "../src/lib/workspace";
import { loadSampleStore } from "../src/lib/sample";
import { loadAgentIdentity } from "../src/lib/agents/inhouse";
import { MandateClient } from "./lib/mandateClient";
import { runAgent } from "../worker/src/runner";
import { runBuyingAgent } from "../worker/src/agents/buying";
import { runSellingAgent } from "../worker/src/agents/selling";

const db = createAdminClient();
const BASE = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

async function main() {
  const slug = process.env.PREVIEW_SLUG ?? "preview";
  let { data: m } = await db.from("merchants").select("*").eq("slug", slug).maybeSingle();
  if (m) await db.from("merchants").delete().eq("id", m.id);
  const created = await db.from("merchants").insert({ name: "Preview Storefront", slug }).select("*").single();
  if (created.error) throw new Error(created.error.message);
  m = created.data;

  await ensureWorkspace(db, m.id);
  await loadSampleStore(db, m.id);

  // A candidate supplier found by research, waiting for the merchant.
  await db.from("vendors").insert({
    merchant_id: m.id,
    name: "Delhi Gadget Wholesale",
    channel: "email",
    email: "sales@delhigadgets.example",
    website: "https://delhigadgets.example",
    status: "candidate",
    source: "research",
    categories: ["electronics"],
    notes: "Found by web research. Unverified: check before approving.",
  });

  const buying = await loadAgentIdentity(db, m.id, "buying");
  const buyer = new MandateClient(BASE, m.slug, buying.agentId, buying.secretKey);

  // The buying agent restocks the bestseller; the payout waits for approval.
  console.log("buying:", JSON.stringify(await runAgent(db, m, "buying", runBuyingAgent)));
  // Selling agent clears slow stock and haggles.
  for (let i = 0; i < 4; i++) console.log("selling:", JSON.stringify(await runAgent(db, m, "selling", runSellingAgent)));

  // An unapproved payee gets refused at the wall.
  const { data: vendor } = await db.from("vendors").select("id").eq("merchant_id", m.id).eq("name", "Bharat Office Supplies").single();
  const { data: pending } = await db
    .from("payees")
    .insert({ merchant_id: m.id, vendor_id: vendor!.id, kind: "upi", display_name: "Bharat Office (new UPI)", masked_identifier: "ba••@okbank", status: "pending", simulated: true })
    .select("id")
    .single();
  const { data: bharatPo } = await db
    .from("purchase_orders")
    .insert({ merchant_id: m.id, vendor_id: vendor!.id, status: "quoting", total_paise: 400_00_00, advance_paise: 200_00_00 })
    .select("id")
    .single();
  const refused = await buyer.callTool("enforce_action", { actionType: "payout.create", amount: 800000, currency: "INR", params: { payeeId: pending!.id, poId: bharatPo!.id, purpose: "vendor_advance" } });
  console.log("unapproved payee:", JSON.stringify(refused).slice(0, 160));
  // An over-limit payout.
  const { data: payee } = await db.from("payees").select("id, vendor_id").eq("merchant_id", m.id).eq("status", "active").eq("vendor_id", vendor!.id).limit(1).single();
  const big = await buyer.callTool("enforce_action", { actionType: "payout.create", amount: 90_00_000, currency: "INR", params: { payeeId: payee!.id, poId: bharatPo!.id, purpose: "vendor_advance" } });
  console.log("over the cap:", JSON.stringify(big).slice(0, 160));
  // A forged request.
  const forged = await buyer.sendTamperedRequest();
  console.log("forged:", forged.status);

  console.log(`\nPreview ready: ${BASE}/dev/preview?slug=${slug}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
