"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireDashboardUser } from "./authGuard";
import { getCurrentMerchant } from "@/lib/merchant";
import { executeRealAction } from "@/lib/razorpay/actions";
import { ActionInput } from "@/lib/mcp/schemas";
import { recomputeTrust } from "@/lib/mcp/traceHelpers";
import type { Json } from "@/types/db";

/**
 * The other half of the step-up flow: `enforce_action` never executed anything
 * for a decision of "escalate" — it just recorded the trace and left an
 * `escalations` row pending. Approving here is where the real Razorpay call
 * finally happens, driven by a human, through the dashboard's own Supabase Auth
 * session — not through Web Bot Auth, because this isn't an agent acting, it's
 * the merchant overriding the gate on purpose.
 */
export async function approveEscalation(escalationId: string) {
  const user = await requireDashboardUser();
  const merchant = await getCurrentMerchant();
  const db = createAdminClient();

  const { data: escalation, error: escError } = await db
    .from("escalations")
    .select("*")
    .eq("id", escalationId)
    .eq("merchant_id", merchant.id)
    .single();
  if (escError || !escalation) throw new Error("Escalation not found.");
  // Idempotent on the outcome the caller asked for. A second approve lands
  // whenever a click repeats before the dashboard's poll catches up, and
  // re-approving something already approved is the same end state — throwing
  // there turned a harmless double-click into a server error in the log and a
  // red banner in the UI. A conflicting resolution is still an error, because
  // silently "approving" something a human denied would be a real one.
  if (escalation.status === "approved") return;
  if (escalation.status !== "pending") throw new Error("This escalation was already denied.");

  const { data: trace, error: traceError } = await db
    .from("traces")
    .select("*")
    .eq("id", escalation.trace_id)
    .eq("merchant_id", merchant.id)
    .single();
  if (traceError || !trace) throw new Error("Underlying trace not found.");

  const rawParams = trace.params as Record<string, unknown>;
  const candidate = {
    actionType: trace.action_type,
    amount: rawParams.amount,
    currency: rawParams.currency,
    category: rawParams.category,
    params: rawParams,
  };
  const parsed = ActionInput.parse(candidate);

  const razorpayResponse = await executeRealAction(parsed);

  await db.from("traces").update({ razorpay_response: razorpayResponse as Json }).eq("id", trace.id);
  await db
    .from("escalations")
    .update({ status: "approved", resolved_by: user.email ?? user.id, resolved_at: new Date().toISOString() })
    .eq("id", escalationId);
  await db
    .from("alerts")
    .insert({ merchant_id: merchant.id, trace_id: trace.id, severity: "info", message: `Escalation approved by ${user.email ?? user.id} — action executed.` });

  if (trace.agent_id) await recomputeTrust(trace.agent_id);

  revalidatePath("/dashboard");
}

export async function denyEscalation(escalationId: string) {
  const user = await requireDashboardUser();
  const merchant = await getCurrentMerchant();
  const db = createAdminClient();

  const { data: escalation, error } = await db
    .from("escalations")
    .select("*")
    .eq("id", escalationId)
    .eq("merchant_id", merchant.id)
    .single();
  if (error || !escalation) throw new Error("Escalation not found.");
  if (escalation.status === "denied") return;
  if (escalation.status !== "pending") throw new Error("This escalation was already approved.");

  await db
    .from("escalations")
    .update({ status: "denied", resolved_by: user.email ?? user.id, resolved_at: new Date().toISOString() })
    .eq("id", escalationId);
  await db
    .from("alerts")
    .insert({ merchant_id: merchant.id, trace_id: escalation.trace_id, severity: "info", message: `Escalation denied by ${user.email ?? user.id}.` });

  revalidatePath("/dashboard");
}
