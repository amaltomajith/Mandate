import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { executeRealAction } from "@/lib/razorpay/actions";
import { ActionInput } from "@/lib/mcp/schemas";
import { recomputeTrust, updateTraceOutcome } from "@/lib/mcp/traceHelpers";
import { recheckBeforeApproval } from "@/lib/mcp/tools/actionEvaluator";
import type { Json } from "@/types/db";

/**
 * Resolving an escalation: a person says yes or no to something an agent asked
 * for and the wall held.
 *
 * Kept free of any particular way of authenticating the person (the dashboard
 * uses Clerk; an emailed approval link would use a signed token) so every
 * entrance runs the exact same checks. Callers establish WHO approved and pass
 * `approver` and the merchant; nothing in here trusts a merchant id from input.
 */

export type ApprovalResult = { status: "approved" | "already_approved" };

export async function approveEscalationCore(
  db: SupabaseClient,
  merchantId: string,
  escalationId: string,
  approver: string
): Promise<ApprovalResult> {
  const { data: escalation, error: escError } = await db
    .from("escalations")
    .select("*")
    .eq("id", escalationId)
    .eq("merchant_id", merchantId)
    .single();
  if (escError || !escalation) throw new Error("Escalation not found.");
  // Idempotent on the outcome asked for: a repeated click on something already
  // approved is the same end state. A conflicting resolution is still an error,
  // because silently "approving" something a human denied would be a real one.
  if (escalation.status === "approved") return { status: "already_approved" };
  if (escalation.status !== "pending") throw new Error("This escalation was already denied.");

  const { data: trace, error: traceError } = await db
    .from("traces")
    .select("*")
    .eq("id", escalation.trace_id)
    .eq("merchant_id", merchantId)
    .single();
  if (traceError || !trace) throw new Error("Underlying trace not found.");

  const rawParams = trace.params as Record<string, unknown>;
  const parsed = ActionInput.parse({
    actionType: trace.action_type,
    amount: rawParams.amount,
    currency: rawParams.currency,
    category: rawParams.category,
    params: rawParams,
  });
  if (!trace.agent_id) throw new Error("This action has no agent behind it, so it cannot be approved.");

  // Limits are re-checked at approval time; see recheckBeforeApproval.
  const recheck = await recheckBeforeApproval(merchantId, trace.agent_id, parsed);
  if (!recheck.ok) throw new Error(`Can't approve this any more: ${recheck.reasoning}`);

  // Claim before executing. The conditional update only succeeds for the one
  // caller that flips `pending` -> `approved`, so two concurrent approvals cannot
  // both reach Razorpay. If the real call then fails the claim is released, so
  // the human can retry instead of being stuck on an approved escalation that
  // never executed.
  const { data: claimed, error: claimError } = await db
    .from("escalations")
    .update({ status: "approved", resolved_by: approver, resolved_at: new Date().toISOString() })
    .eq("id", escalationId)
    .eq("merchant_id", merchantId)
    .eq("status", "pending")
    .select("id");
  if (claimError) throw claimError;
  if (!claimed || claimed.length === 0) return { status: "already_approved" };

  let razorpayResponse: Json;
  try {
    razorpayResponse = await executeRealAction(parsed, { merchantId, traceId: trace.id, agentId: trace.agent_id });
  } catch (err) {
    await db
      .from("escalations")
      .update({ status: "pending", resolved_by: null, resolved_at: null })
      .eq("id", escalationId)
      .eq("merchant_id", merchantId);
    throw err;
  }

  await updateTraceOutcome(merchantId, trace.id, { razorpayResponse });
  await db
    .from("alerts")
    .insert({ merchant_id: merchantId, trace_id: trace.id, severity: "info", message: `Escalation approved by ${approver}: action executed.` });
  await recomputeTrust(trace.agent_id);
  return { status: "approved" };
}

export async function denyEscalationCore(
  db: SupabaseClient,
  merchantId: string,
  escalationId: string,
  approver: string
): Promise<void> {
  const { data: escalation, error } = await db
    .from("escalations")
    .select("*")
    .eq("id", escalationId)
    .eq("merchant_id", merchantId)
    .single();
  if (error || !escalation) throw new Error("Escalation not found.");
  if (escalation.status === "denied") return;
  if (escalation.status !== "pending") throw new Error("This escalation was already approved.");

  // Conditional, like the approval claim: a deny that raced an approve must not
  // overwrite it.
  const { data: denied } = await db
    .from("escalations")
    .update({ status: "denied", resolved_by: approver, resolved_at: new Date().toISOString() })
    .eq("id", escalationId)
    .eq("merchant_id", merchantId)
    .eq("status", "pending")
    .select("id");
  if (!denied || denied.length === 0) throw new Error("This escalation was resolved by someone else just now.");

  await db
    .from("alerts")
    .insert({ merchant_id: merchantId, trace_id: escalation.trace_id, severity: "info", message: `Escalation denied by ${approver}.` });

  // A denied payout leaves its purchase order waiting for a person rather than
  // quietly retrying: put it back to draft with the reason.
  const { data: trace } = await db.from("traces").select("action_type, params").eq("id", escalation.trace_id).maybeSingle();
  const poId = (trace?.params as { poId?: string } | null)?.poId;
  if (trace?.action_type === "payout.create" && poId) {
    await db
      .from("purchase_orders")
      .update({ status: "cancelled", rationale: `Payout denied by ${approver}.` })
      .eq("id", poId)
      .eq("merchant_id", merchantId)
      .eq("status", "awaiting_approval");
  }
}
