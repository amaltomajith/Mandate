"use server";

import { revalidatePath } from "next/cache";
import { requireDashboardUser } from "./authGuard";
import { getCurrentMerchant } from "@/lib/merchant";
import { draftPolicy } from "@/lib/mcp/tools/draftPolicy";

/**
 * Horizon's live RSS/GitHub polling is explicitly out of scope for this build
 * (see HANDOVER.md roadmap) — this curated example stands in for "Horizon found
 * something," feeding the exact same real draft_policy pipeline a live feed
 * would. The pipeline is real; only the polling that would trigger it isn't.
 */
const CURATED_HORIZON_EXAMPLE =
  "RBI circular (illustrative example, not a live feed): effective immediately, recurring merchant debits under UPI Autopay mandates above ₹15,000 per transaction require additional customer authentication (step-up) before execution.";

export async function triggerHorizonExample() {
  await requireDashboardUser();
  const merchant = await getCurrentMerchant();
  const result = await draftPolicy(
    merchant.id,
    CURATED_HORIZON_EXAMPLE,
    "horizon",
    "Horizon (illustrative): RBI circular on UPI Autopay step-up"
  );
  revalidatePath("/dashboard");
  return result;
}

export async function submitManualPolicyDraft(text: string) {
  await requireDashboardUser();
  const merchant = await getCurrentMerchant();
  const result = await draftPolicy(merchant.id, text, "human");
  revalidatePath("/dashboard");
  return result;
}
