import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getRazorpay } from "@/lib/razorpay/client";
import type { CampaignTargetStatus } from "@/types/db";

/**
 * Reading conversion back out of Razorpay.
 *
 * This is the part that makes a campaign an orchestrator rather than a sender.
 * An order tells you nothing about whether anyone paid — creating one is just
 * an intent. A payment link carries a `status` that moves to `paid` and an
 * `amount_paid`, so "this campaign earned X" is a number that can be fetched
 * rather than asserted.
 *
 * Nothing here writes a status the merchant's own Razorpay account doesn't
 * already say. A conversion figure this dashboard invented would be worth
 * less than no figure at all, and every other number in this project is a
 * replay of something that actually happened.
 */

export interface ReconcileResult {
  checked: number;
  paid: number;
  expired: number;
  /** Links that could not be fetched. Counted rather than swallowed: a
   *  reconcile that silently skipped half the campaign would report a
   *  conversion rate over a denominator nobody was told about. */
  unreadable: number;
  revenuePaise: number;
}

/** Razorpay's link status, mapped onto ours. `partially_paid` counts as paid:
 *  money moved and the campaign caused it, which is what the figure claims.
 *  `cancelled` is folded into expired — both mean the offer is closed with
 *  nothing collected, and splitting them would add a status nothing acts on. */
function mapStatus(status: string): CampaignTargetStatus | null {
  if (status === "paid" || status === "partially_paid") return "paid";
  if (status === "expired" || status === "cancelled") return "expired";
  return null;
}

export async function reconcileCampaign(db: SupabaseClient, campaignId: string): Promise<ReconcileResult> {
  const { data: targets, error } = await db
    .from("campaign_targets")
    .select("id, payment_link_id, status")
    .eq("campaign_id", campaignId)
    .eq("status", "offered")
    .not("payment_link_id", "is", null);
  if (error) throw new Error(error.message);

  const result: ReconcileResult = { checked: 0, paid: 0, expired: 0, unreadable: 0, revenuePaise: 0 };
  if (!targets || targets.length === 0) return result;

  const rzp = getRazorpay();

  for (const target of targets) {
    result.checked++;
    try {
      const link = await rzp.paymentLink.fetch(target.payment_link_id as string);
      const next = mapStatus(link.status);
      // Still open. Left alone rather than rewritten to the same value, so
      // nothing churns and `created_at` ordering stays meaningful.
      if (!next) continue;

      await db.from("campaign_targets").update({ status: next }).eq("id", target.id);
      if (next === "paid") {
        result.paid++;
        result.revenuePaise += Number(link.amount_paid ?? 0);
      } else {
        result.expired++;
      }
    } catch (err) {
      // One unreachable link must not abandon the rest of the campaign.
      result.unreadable++;
      console.warn(`[campaigns] could not read payment link ${target.payment_link_id}:`, err);
    }
  }

  return result;
}
