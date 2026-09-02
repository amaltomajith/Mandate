import type { SupabaseClient } from "@supabase/supabase-js";
import { MandateClient } from "@/lib/demo/mandateClient";
import { buildSegment, describeSegment, type SegmentMember } from "./segment";
import type { PlannedCampaign } from "./planner";
import type { Campaign, CampaignTarget, Customer, Escalation, Product, Trace } from "@/types/db";

/**
 * Running a campaign: the agent spending the merchant's money, one governed
 * action at a time.
 *
 * Every offer goes out as a signed `enforce_action` for `payment_link.create`,
 * exactly like a purchase. It can be cleared, held for approval, or refused,
 * and it lands in the same audit trail with the same explanation. There is no
 * campaign-specific bypass, and that is the point: a discount is money given
 * away, and an agent giving it away across hundreds of customers unattended is
 * the exact thing this system exists to bound.
 *
 * The budget is enforced here rather than left to a policy rule, and both
 * matter. A `cap` rule scoped to `payment_link.create` bounds what the agent
 * may spend in a day across every campaign; this bounds what *this* campaign
 * may spend in total. Neither substitutes for the other, and the loop stops on
 * whichever binds first.
 */

export interface SendOutcome {
  customerId: string;
  customerName: string;
  decision: "allow" | "escalate" | "block" | "skipped";
  reasoning: string;
  amountPaise: number;
  discountPaise: number;
  paymentLinkUrl: string | null;
  traceId: string | null;
}

export interface CampaignRunResult {
  campaignId: string;
  segmentSize: number;
  /** Orders in the history with no customer attached, so invisible to
   *  segmentation. Carried through from buildSegment so the caller can say how
   *  much of the book this campaign could actually see. */
  unattributableOrders: number;
  sent: SendOutcome[];
  discountCommittedPaise: number;
  budgetPaise: number;
  stoppedBecause: "budget" | "segment-exhausted" | "limit" | null;
}

/** Mirrors what `runActionEvaluation` returns through the MCP tool result.
 *  `razorpayResponse` is the raw Razorpay object; for a payment link it
 *  carries `short_url` (the link a customer opens) and `id` (what conversion
 *  is later read back against). Null for anything policy did not execute. */
interface EnforceResult {
  decision: "allow" | "escalate" | "block";
  reasoning: string;
  traceId?: string;
  razorpayResponse?: { short_url?: string; id?: string } | null;
}

/**
 * Committed discount, summed from the targets rather than stored on the
 * campaign. Same reasoning as `totalExecuted` in revenue.ts: a running total
 * kept in a column is a second source of truth, and it goes wrong the first
 * time an update fails after the action already happened. A budget figure that
 * has drifted is worse than no budget figure, because it will be trusted.
 *
 * A refused target committed nothing — policy stopped it before a link
 * existed — so it does not count against the budget.
 */
export function committedDiscount(targets: Pick<CampaignTarget, "status" | "discount_paise">[]): number {
  return targets
    .filter((t) => t.status === "offered" || t.status === "paid" || t.status === "held")
    .reduce((sum, t) => sum + t.discount_paise, 0);
}

export async function runCampaign(
  db: SupabaseClient,
  campaign: Campaign,
  plan: PlannedCampaign,
  client: MandateClient,
  data: { traces: Trace[]; escalations: Escalation[]; products: Product[]; customers: Customer[] },
  maxSends: number
): Promise<CampaignRunResult> {
  const segment = buildSegment(plan.segment, data.traces, data.escalations, data.products, data.customers);

  const { data: existingRows } = await db
    .from("campaign_targets")
    .select("customer_id, status, discount_paise")
    .eq("campaign_id", campaign.id);
  const existing = existingRows ?? [];
  const alreadyTargeted = new Set(existing.map((t) => t.customer_id));

  let discountCommittedPaise = committedDiscount(existing);
  const sent: SendOutcome[] = [];
  let stoppedBecause: CampaignRunResult["stoppedBecause"] = "segment-exhausted";

  const queue = segment.members.filter((m) => !alreadyTargeted.has(m.customerId));

  for (const member of queue) {
    if (sent.length >= maxSends) {
      stoppedBecause = "limit";
      break;
    }
    // Checked before the action, not after. Spending past the budget and then
    // noticing is not a budget.
    if (discountCommittedPaise + plan.unitDiscountPaise > campaign.budget_paise) {
      stoppedBecause = "budget";
      break;
    }

    const outcome = await offerTo(db, campaign, plan, client, member);
    sent.push(outcome);
    if (outcome.decision === "allow" || outcome.decision === "escalate") {
      discountCommittedPaise += plan.unitDiscountPaise;
    }
  }

  return {
    campaignId: campaign.id,
    segmentSize: segment.members.length,
    unattributableOrders: segment.unattributableOrders,
    sent,
    discountCommittedPaise,
    budgetPaise: campaign.budget_paise,
    stoppedBecause: sent.length === 0 && queue.length === 0 ? "segment-exhausted" : stoppedBecause,
  };
}

async function offerTo(
  db: SupabaseClient,
  campaign: Campaign,
  plan: PlannedCampaign,
  client: MandateClient,
  member: SegmentMember
): Promise<SendOutcome> {
  const description = `${plan.discountPct}% off ${plan.item.name}`;

  let result: EnforceResult;
  try {
    result = await client.callTool<EnforceResult>("enforce_action", {
      actionType: "payment_link.create",
      amount: plan.unitChargePaise,
      currency: "INR",
      category: plan.item.category,
      customerId: member.customerId,
      params: {
        description,
        customerName: member.name,
        discountPaise: plan.unitDiscountPaise,
        campaignId: campaign.id,
        // Off. Razorpay sends the email itself when this is true, and these are
        // synthetic customers with real-looking addresses. Turning it on is a
        // deliberate act, not a default.
        notify: false,
        expiresInHours: 168,
        notes: { campaign: campaign.name, sku: plan.item.sku },
      },
    });
  } catch (err) {
    // A transport failure is not a policy decision and must not be recorded as
    // one. No target row is written, so the customer stays in the queue and the
    // next run picks them up rather than silently skipping them forever.
    return {
      customerId: member.customerId,
      customerName: member.name,
      decision: "skipped",
      reasoning: err instanceof Error ? err.message : "The offer could not be sent.",
      amountPaise: plan.unitChargePaise,
      discountPaise: plan.unitDiscountPaise,
      paymentLinkUrl: null,
      traceId: null,
    };
  }

  const status =
    result.decision === "allow" ? "offered" : result.decision === "escalate" ? "held" : "refused";

  // merchant_id is required (migration 0010) and the error is checked. Both
  // matter, and their absence is why this silently wrote nothing at all: the
  // column was added to every table when the instance became multi-tenant,
  // this insert was written before that, and an unchecked insert failing is
  // indistinguishable from one succeeding. Offers went out with real Razorpay
  // links and left no record of who had received them.
  const { error: targetError } = await db.from("campaign_targets").insert({
    merchant_id: campaign.merchant_id,
    campaign_id: campaign.id,
    customer_id: member.customerId,
    trace_id: result.traceId ?? null,
    payment_link_id: result.razorpayResponse?.id ?? null,
    payment_link_url: result.razorpayResponse?.short_url ?? null,
    status,
    amount_paise: plan.unitChargePaise,
    discount_paise: plan.unitDiscountPaise,
  });
  if (targetError) {
    // A link exists at Razorpay but nothing here records it. Loud, because the
    // budget is derived from these rows: losing one means the campaign
    // undercounts what it has already given away.
    throw new Error(
      `Offer to ${member.name} was created at Razorpay but could not be recorded: ${targetError.message}`
    );
  }

  return {
    customerId: member.customerId,
    customerName: member.name,
    decision: result.decision,
    reasoning: result.reasoning,
    amountPaise: plan.unitChargePaise,
    discountPaise: plan.unitDiscountPaise,
    paymentLinkUrl: result.razorpayResponse?.short_url ?? null,
    traceId: result.traceId ?? null,
  };
}

/** Human-readable summary of what a run did, built from the run's own numbers
 *  so it cannot describe something other than what happened. */
export function describeRun(result: CampaignRunResult, plan: PlannedCampaign, products: Product[]): string {
  const allowed = result.sent.filter((s) => s.decision === "allow").length;
  const held = result.sent.filter((s) => s.decision === "escalate").length;
  const refused = result.sent.filter((s) => s.decision === "block").length;
  const money = (p: number) => `₹${(p / 100).toLocaleString("en-IN")}`;

  const parts = [
    `${describeSegment(plan.segment, products)} — ${result.segmentSize} matched.`,
    `${allowed} offer${allowed === 1 ? "" : "s"} went out`,
  ];
  if (held > 0) parts.push(`${held} held for your approval`);
  if (refused > 0) parts.push(`${refused} refused by policy`);
  parts.push(`${money(result.discountCommittedPaise)} of ${money(result.budgetPaise)} budget committed`);
  if (result.stoppedBecause === "budget") parts.push("stopped on budget");
  return parts.join(" · ");
}
