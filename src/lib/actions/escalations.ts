"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireDashboardUser } from "./authGuard";
import { getCurrentMerchant } from "@/lib/merchant";
import { approveEscalationCore, denyEscalationCore } from "@/lib/approvals";

/**
 * The other half of the step-up flow: `enforce_action` never executes anything
 * for a decision of "escalate". It records the trace and leaves an `escalations`
 * row pending. Approving here is where the real call finally happens, driven by
 * a human through the dashboard's own session, not through Web Bot Auth, because
 * this is not an agent acting, it is the merchant overriding the gate on purpose.
 *
 * The checks live in src/lib/approvals.ts so every way of approving (this one,
 * and later an emailed or WhatsApp link) runs the same ones.
 */
export async function approveEscalation(escalationId: string) {
  const user = await requireDashboardUser();
  const merchant = await getCurrentMerchant();
  await approveEscalationCore(createAdminClient(), merchant.id, escalationId, user.email ?? user.id);
  revalidatePath("/dashboard");
}

export async function denyEscalation(escalationId: string) {
  const user = await requireDashboardUser();
  const merchant = await getCurrentMerchant();
  await denyEscalationCore(createAdminClient(), merchant.id, escalationId, user.email ?? user.id);
  revalidatePath("/dashboard");
}
