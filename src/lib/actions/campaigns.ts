"use server";

import { revalidatePath } from "next/cache";
import { requireDashboardUser } from "./authGuard";
import { getCurrentMerchant } from "@/lib/merchant";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchCatalog } from "@/lib/demo/catalog";
import { MandateClient } from "@/lib/demo/mandateClient";
import { ensureAgentIdentity } from "@/lib/demo/shared";
import { planCampaign, type PlannedCampaign } from "@/lib/campaigns/planner";
import { buildSegment, describeSegment } from "@/lib/campaigns/segment";
import { runCampaign, committedDiscount, describeRun, type CampaignRunResult } from "@/lib/campaigns/orchestrator";
import { reconcileCampaign, type ReconcileResult } from "@/lib/campaigns/conversion";
import type { Campaign, CampaignTarget, Json } from "@/types/db";

/**
 * The merchant's side of a campaign: propose, approve, run, reconcile.
 *
 * Planning and running are deliberately separate actions with a human between
 * them. A campaign is an agent spending the merchant's money across many
 * customers at once, and the plan is the thing being approved — which product,
 * what discount, to whom, and up to what total. Collapsing the two into one
 * button would make the approval decorative.
 */

const SIM_AGENT = {
  envIdVar: "SIM_AGENT_ID",
  envSecretVar: "SIM_AGENT_SECRET_KEY",
  name: "Checkout Agent",
  description: "An AI buyer agent transacting on behalf of customers.",
};

export interface CampaignPreview {
  plan: PlannedCampaign;
  segmentDescription: string;
  segmentSize: number;
  /** Orders the trail cannot attribute to anyone, so invisible to targeting.
   *  Surfaced rather than hidden: a segment of 3 drawn from a history where 200
   *  orders have no customer is a different fact from one drawn from a
   *  complete book, and the merchant should see which they are approving. */
  unattributableOrders: number;
  suggestedBudgetPaise: number;
}

async function dashboardData(merchantId: string) {
  const db = createAdminClient();
  const [traces, escalations, products, customers] = await Promise.all([
    db.from("traces").select("*").eq("merchant_id", merchantId).order("created_at", { ascending: false }).limit(300),
    db.from("escalations").select("*").eq("merchant_id", merchantId).limit(300),
    db.from("products").select("*").eq("merchant_id", merchantId),
    db.from("customers").select("*").eq("merchant_id", merchantId),
  ]);
  return {
    traces: traces.data ?? [],
    escalations: escalations.data ?? [],
    products: products.data ?? [],
    customers: customers.data ?? [],
  };
}

/** Proposes a campaign. Writes nothing and spends nothing — this is the thing
 *  the merchant is being asked to approve. */
export async function previewCampaign(goal: string): Promise<CampaignPreview> {
  await requireDashboardUser();
  const merchant = await getCurrentMerchant();
  const db = createAdminClient();

  const trimmed = goal.trim();
  if (trimmed.length < 8) throw new Error("Say a little more about what you're trying to achieve.");

  const catalog = await fetchCatalog(db, merchant.id);
  const plan = await planCampaign(trimmed, catalog);
  if (!plan) {
    throw new Error(
      "Couldn't turn that into a campaign. Try naming a product or a kind of customer — " +
        "for example, 'win back people who bought a stand but never a hub'."
    );
  }

  const data = await dashboardData(merchant.id);
  const segment = buildSegment(plan.segment, data.traces, data.escalations, data.products, data.customers);

  return {
    plan,
    segmentDescription: describeSegment(plan.segment, data.products),
    segmentSize: segment.members.length,
    unattributableOrders: segment.unattributableOrders,
    // Enough to cover the whole segment at this discount, rounded up to a
    // round number. A suggestion, not a decision — the merchant edits it.
    suggestedBudgetPaise: Math.max(
      plan.unitDiscountPaise,
      Math.ceil((segment.members.length * plan.unitDiscountPaise) / 100_000) * 100_000
    ),
  };
}

export interface CampaignRunSummary {
  campaign: Campaign;
  result: CampaignRunResult;
  description: string;
}

/**
 * Approves a plan and runs it. Every offer goes out as a signed
 * `payment_link.create` through the same policy engine as any other action, so
 * it can be cleared, held for approval, or refused — there is no
 * campaign-specific bypass.
 */
export async function launchCampaign(
  goal: string,
  plan: PlannedCampaign,
  budgetPaise: number,
  maxSends: number
): Promise<CampaignRunSummary> {
  await requireDashboardUser();
  const merchant = await getCurrentMerchant();
  const db = createAdminClient();

  if (!Number.isFinite(budgetPaise) || budgetPaise <= 0) {
    throw new Error("A campaign needs a budget above zero.");
  }

  const { id: agentId, secretKeyBase64 } = await ensureAgentIdentity(db, merchant.id, SIM_AGENT);

  const { data: campaign, error } = await db
    .from("campaigns")
    .insert({
      merchant_id: merchant.id,
      name: plan.name,
      goal: goal.trim(),
      plan: plan as unknown as Json,
      budget_paise: Math.round(budgetPaise),
      status: "running",
      agent_id: agentId,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const client = new MandateClient(baseUrl, merchant.slug, agentId, secretKeyBase64);
  await client.initialize("mandate-campaign");

  const data = await dashboardData(merchant.id);
  const result = await runCampaign(db, campaign, plan, client, data, maxSends);

  // Done when the segment is exhausted or the budget is spent; still running
  // when it merely hit this run's send limit and has more to do.
  await db
    .from("campaigns")
    .update({ status: result.stoppedBecause === "limit" ? "running" : "done" })
    .eq("id", campaign.id)
    .eq("merchant_id", merchant.id);

  revalidatePath("/dashboard");
  return { campaign, result, description: describeRun(result, plan, data.products) };
}

export interface CampaignRow {
  campaign: Campaign;
  targets: CampaignTarget[];
  committedPaise: number;
  paid: number;
  revenuePaise: number;
}

/** Every campaign with its targets, for the dashboard list. */
export async function listCampaigns(): Promise<CampaignRow[]> {
  await requireDashboardUser();
  const merchant = await getCurrentMerchant();
  const db = createAdminClient();

  const { data: campaigns } = await db
    .from("campaigns")
    .select("*")
    .eq("merchant_id", merchant.id)
    .order("created_at", { ascending: false });
  if (!campaigns || campaigns.length === 0) return [];

  const { data: targets } = await db
    .from("campaign_targets")
    .select("*")
    .in(
      "campaign_id",
      campaigns.map((c) => c.id)
    );

  return campaigns.map((campaign) => {
    const mine = (targets ?? []).filter((t) => t.campaign_id === campaign.id);
    const paidTargets = mine.filter((t) => t.status === "paid");
    return {
      campaign,
      targets: mine,
      committedPaise: committedDiscount(mine),
      paid: paidTargets.length,
      // What the customers paid, not the link value: revenue is money that
      // moved. Derived from the targets rather than stored on the campaign,
      // same reasoning as everywhere else in this codebase.
      revenuePaise: paidTargets.reduce((sum, t) => sum + t.amount_paise, 0),
    };
  });
}

/** Asks Razorpay what actually happened to each link. Nothing here invents a
 *  status the merchant's own account does not already report. */
export async function reconcile(campaignId: string): Promise<ReconcileResult> {
  await requireDashboardUser();
  const merchant = await getCurrentMerchant();
  const db = createAdminClient();

  const { data: campaign } = await db
    .from("campaigns")
    .select("id")
    .eq("id", campaignId)
    .eq("merchant_id", merchant.id)
    .maybeSingle();
  if (!campaign) throw new Error("Campaign not found.");

  const result = await reconcileCampaign(db, campaignId);
  revalidatePath("/dashboard");
  return result;
}
