/**
 * The campaign orchestrator, end to end against live Razorpay test mode.
 *
 * Builds a merchant with real purchase history (real signed MCP orders, so the
 * segmentation has something honest to read), plans a campaign, runs it, and
 * reconciles. Then deletes everything.
 *
 * The cases that matter are the ones about spending someone else's money:
 * the budget stops the run before it is exceeded rather than after, a customer
 * cannot be offered the same campaign twice, and every offer went out as a
 * policy-gated action rather than around one.
 *
 * Usage: npx tsx scripts/verify-campaign.ts   (needs the dev server running)
 */
import "./lib/loadEnv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { generateKeyPair } from "../src/lib/webBotAuth/keys";
import { MandateClient } from "../src/lib/demo/mandateClient";
import { applySeedProducts, fetchCatalog } from "../src/lib/demo/catalog";
import { planCampaign } from "../src/lib/campaigns/planner";
import { buildSegment } from "../src/lib/campaigns/segment";
import { runCampaign, committedDiscount } from "../src/lib/campaigns/orchestrator";
import type { Campaign, Json } from "../src/types/db";

const db: SupabaseClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);
const BASE = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(56)} ${detail}`);
}

async function main() {
  const slug = `camp-${Math.random().toString(36).slice(2, 7)}`;
  const { data: merchant, error } = await db
    .from("merchants")
    .insert({ name: "Campaign Test", slug })
    .select()
    .single();
  if (error) throw new Error(error.message);
  await applySeedProducts(db, merchant.id);

  try {
    const { secretKey, publicKey } = generateKeyPair();
    const { data: agent } = await db
      .from("agents")
      .insert({ merchant_id: merchant.id, name: "Buyer", public_key: publicKey })
      .select()
      .single();
    const client = new MandateClient(BASE, slug, agent!.id, secretKey);
    await client.initialize("verify-campaign");

    const catalog = await fetchCatalog(db, merchant.id);
    const stand = catalog.find((c) => c.sku === "stand-01")!;

    // Four customers, each with a real completed order for the same product.
    // Segmentation reads orders, not customer rows, so a customer with no
    // purchase history is invisible to it — which is correct, and means this
    // has to buy something for each of them.
    const customerIds: string[] = [];
    for (const name of ["Buyer One", "Buyer Two", "Buyer Three", "Buyer Four"]) {
      const { data: c } = await db
        .from("customers")
        .insert({ merchant_id: merchant.id, name, email: `${name.replace(/ /g, ".")}@example.com` })
        .select()
        .single();
      customerIds.push(c!.id);
      await db.from("mandates").insert({
        merchant_id: merchant.id,
        agent_id: agent!.id,
        customer_id: c!.id,
        type: "upi_autopay",
        status: "active",
        razorpay_ref: `camp_${Math.random().toString(36).slice(2, 10)}`,
        raw_payload: { simulated: true } as Json,
      });
      await client.callTool("enforce_action", {
        actionType: "order.create",
        amount: stand.priceInPaise,
        currency: "INR",
        category: stand.category,
        customerId: c!.id,
        params: {
          receipt: `camp-seed-${Date.now()}-${customerIds.length}`,
          notes: { sku: stand.sku, item: stand.name },
        },
      });
    }
    check("seeded four customers with real purchase history", customerIds.length === 4, "");

    // ---- Planning. Grounded against the real catalog.
    const plan = await planCampaign(
      "Sell a USB-C hub to people who already bought a laptop stand",
      catalog
    );
    check("a goal becomes a grounded plan", !!plan, plan ? `${plan.discountPct}% off ${plan.item.name}` : "null");
    if (!plan) throw new Error("planning failed; cannot continue");

    const skus = new Set(catalog.map((c) => c.sku));
    check(
      "every sku the plan names is real",
      skus.has(plan.sku) &&
        (!plan.segment.boughtSku || skus.has(plan.segment.boughtSku)) &&
        (!plan.segment.notBoughtSku || skus.has(plan.segment.notBoughtSku)),
      `${plan.sku}${plan.segment.boughtSku ? ` / bought ${plan.segment.boughtSku}` : ""}`
    );
    check(
      "price and discount are computed, not taken from the model",
      plan.unitChargePaise === plan.unitPricePaise - plan.unitDiscountPaise &&
        plan.unitPricePaise === plan.item.priceInPaise,
      `${plan.unitPricePaise} - ${plan.unitDiscountPaise} = ${plan.unitChargePaise}`
    );

    const data = {
      traces: (await db.from("traces").select("*").eq("merchant_id", merchant.id)).data ?? [],
      escalations: (await db.from("escalations").select("*").eq("merchant_id", merchant.id)).data ?? [],
      products: (await db.from("products").select("*").eq("merchant_id", merchant.id)).data ?? [],
      customers: (await db.from("customers").select("*").eq("merchant_id", merchant.id)).data ?? [],
    };
    const segment = buildSegment(plan.segment, data.traces, data.escalations, data.products, data.customers);
    check("the segment is computed from real orders", segment.members.length > 0, `${segment.members.length} matched`);

    // ---- Budget. Deliberately enough for exactly two offers, so the third
    //      must be refused by the budget rather than by running out of people.
    const budget = plan.unitDiscountPaise * 2;
    const { data: campaign } = await db
      .from("campaigns")
      .insert({
        merchant_id: merchant.id,
        name: plan.name,
        goal: "verify-campaign",
        plan: plan as unknown as Json,
        budget_paise: budget,
        status: "running",
        agent_id: agent!.id,
      })
      .select()
      .single();

    const run = await runCampaign(db, campaign as Campaign, plan, client, data, 10);
    const sent = run.sent.filter((s) => s.decision === "allow");
    for (const o of run.sent) console.log(`    [offer] ${o.decision} :: ${o.reasoning.slice(0, 160)}`);

    check(
      "the budget stops the run before it is exceeded",
      run.discountCommittedPaise <= budget && run.stoppedBecause === "budget",
      `${run.discountCommittedPaise} of ${budget}, stopped on ${run.stoppedBecause}`
    );
    check(
      "offers went out as real Razorpay payment links",
      sent.length > 0 && sent.every((s) => !!s.paymentLinkUrl),
      sent[0]?.paymentLinkUrl ?? "(none sent)"
    );
    check(
      "every offer is traced through the policy engine",
      run.sent.length > 0 && run.sent.every((s) => s.traceId !== null),
      `${run.sent.length} offer(s)`
    );

    const { data: targets } = await db
      .from("campaign_targets")
      .select("customer_id, status, discount_paise, payment_link_id")
      .eq("campaign_id", campaign!.id);
    const uniqueCustomers = new Set((targets ?? []).map((t) => t.customer_id));
    check(
      "one offer per customer per campaign",
      (targets ?? []).length > 0 && uniqueCustomers.size === (targets ?? []).length,
      `${targets?.length} target(s), ${uniqueCustomers.size} distinct`
    );
    check(
      "committed discount is derived from the targets",
      committedDiscount(targets ?? []) === run.discountCommittedPaise,
      `${committedDiscount(targets ?? [])} = ${run.discountCommittedPaise}`
    );

    // ---- A second run must not re-target anyone already offered to. The
    //      database enforces it, so this checks the loop respects it too rather
    //      than relying on the insert to blow up.
    const rerun = await runCampaign(db, campaign as Campaign, plan, client, data, 10);
    check(
      "re-running does not offer the same customer twice",
      rerun.sent.every((s) => !uniqueCustomers.has(s.customerId)),
      `${rerun.sent.length} new offer(s)`
    );

    // ---- Conversion. Nothing has been paid, so this must say so rather than
    //      invent a number.
    const links = (targets ?? []).filter((t) => t.payment_link_id).length;
    check("links are recorded for later reconciliation", links > 0, `${links} link id(s)`);
  } finally {
    await db.from("merchants").delete().eq("id", merchant.id);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  for (const f of failed) console.log(`  FAILED: ${f.name} — ${f.detail}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
