import "server-only";
import { evaluatePolicy } from "@/lib/policy/engine";
import { executeRealAction } from "@/lib/razorpay/actions";
import type { ActionInput } from "@/lib/mcp/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { getMerchantIdForAgent } from "@/lib/merchant";
import {
  checkMandateGate,
  createAlert,
  createEscalationForTrace,
  getActiveRules,
  getAgentTrustScore,
  getAggregates,
  insertTrace,
  recomputeTrust,
  recordMandateFromSubscription,
} from "@/lib/mcp/traceHelpers";
import type { Json } from "@/types/db";

export interface EvaluationOutcome {
  decision: "allow" | "block" | "escalate";
  ruleFired: { id: string; name: string; type: string } | null;
  reasoning: string;
  traceId: string;
  wouldEscalate: boolean;
  razorpayResponse: Json | null;
}

/**
 * Shared core of `simulate_action` and `enforce_action` — identical decision logic
 * either way. The only branch point is `mode`: "enforce" is the one that calls
 * {@link executeRealAction} and only when the policy engine says "allow".
 */
/**
 * Server-side annotations stamped onto the trace, out of reach of the caller.
 *
 * These are applied AFTER the caller's params, so a buyer agent cannot forge
 * one by putting it in its own request. That matters most for `offerId`, which
 * the re-entry guard's unique index is built on: if a caller could set it, a
 * caller could also collide it deliberately and block someone else's purchase.
 */
export interface TraceStamp {
  /** Consumed exactly once. See migration 0011. */
  offerId?: string;
  /** Which MRTR beat this trace records: the offer, or a declined offer. */
  mrtr?: "input_required" | "counter_declined";
  /** The complement that was offered, for a trace that records an offer. */
  offeredSku?: string;
}

/**
 * The agent's own words, made safe to keep and to show.
 *
 * A buying agent may send a one-line reason with its purchase. That text is
 * written by someone else's model, stored in our database, and rendered in the
 * merchant's browser — three hops from untrusted input to a human's screen. It
 * is stripped of structural characters and bounded here, at write time, rather
 * than at render time: React escaping protects the DOM, not the database, and
 * not whatever reads it next.
 */
function safeAgentReason(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const cleaned = raw.replace(/[<>{}`[\]\\]/g, "").replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  return cleaned.length > 160 ? `${cleaned.slice(0, 159).trimEnd()}…` : cleaned;
}

export async function runActionEvaluation(
  agentId: string,
  input: ActionInput,
  mode: "simulate" | "enforce",
  stamp?: TraceStamp
): Promise<EvaluationOutcome> {
  // The tenant, resolved from the agent the Ed25519 signature already proved --
  // never from the request body. An agent has no way to name a merchant, so it
  // has no way to name someone else's. Everything below is scoped by this, and
  // an agent whose row cannot be read is refused rather than defaulted: the only
  // safe thing to do with an action whose owner is unknown is not perform it.
  const db = createAdminClient();
  const merchantId = await getMerchantIdForAgent(db, agentId);

  // The mandate gate runs before the policy engine, not alongside it: a
  // revoked/paused mandate is a more fundamental "this agent isn't
  // authorized at all right now" check, and should short-circuit spend
  // rules rather than compete with them. Only actions attributed to a
  // customer can be gated by a mandate at all — and `subscription.create`
  // itself is deliberately exempt: it's how a NEW mandate gets established,
  // so it can't be blocked by a PRIOR mandate's revoked/paused status for
  // the same agent+customer pair, or a merchant could never re-authorize an
  // agent they'd previously revoked. (Caught live: reusing the same demo
  // agent+customer across runs meant every run after the first revoke
  // permanently locked out ever establishing a new one.)
  const mandateGate =
    input.customerId && input.actionType !== "subscription.create"
      ? await checkMandateGate(agentId, input.customerId)
      : null;

  let match: ReturnType<typeof evaluatePolicy> = null;
  let decision: "allow" | "block" | "escalate";
  let reasoning: string;

  if (mandateGate?.blocked) {
    decision = "block";
    reasoning = mandateGate.reasoning ?? "Blocked: this agent's mandate is not active.";
  } else {
    // The acting agent's current trust score, for `trust_floor` rules. Read
    // here rather than inside the evaluator so the evaluator stays pure and
    // DB-free — same contract every other input follows.
    const agentTrustScore = await getAgentTrustScore(agentId);
    const rules = await getActiveRules(merchantId);
    const aggregates = await getAggregates(merchantId, agentId, rules, input.currency, input.customerId);
    match = evaluatePolicy(
      {
        actionType: input.actionType,
        amount: input.amount,
        currency: input.currency,
        category: input.category,
        agentId,
        customerId: input.customerId,
        agentTrustScore,
      },
      rules,
      aggregates
    );
    decision = match?.decision ?? "allow";
    reasoning = match?.reasoning ?? "No policy rule matched — allowed by default.";
  }

  let razorpayResponse: Json | null = null;
  if (mode === "enforce" && decision === "allow") {
    razorpayResponse = await executeRealAction(input);
    if (input.actionType === "subscription.create") {
      const subscriptionId = (razorpayResponse as { subscription?: { id?: string } } | null)?.subscription?.id;
      if (subscriptionId) {
        await recordMandateFromSubscription(merchantId, agentId, input.customerId, subscriptionId, razorpayResponse);
      }
    }
  }

  const trace = await insertTrace({
    merchantId,
    parentTraceId: input.forkFrom ?? null,
    mode,
    actionType: input.actionType,
    // Caller params first, authoritative fields last. `amount` here is what
    // the revenue figures and the order history read, and it has to be the
    // amount the policy engine actually judged; spread the other way round, a
    // caller passing `params: { amount: 1 }` would have its order evaluated on
    // the real amount but recorded — and reported — as one paisa.
    //
    // `customerId` is persisted alongside it because the mandate gate above
    // already acted on it: a trace recording what was bought and by which
    // agent, but not for whom, is an audit trail with a hole in it.
    params: {
      ...input.params,
      // Re-written over the caller's own copy, sanitised. Spread order matters:
      // this has to land after the spread or the raw value survives.
      // `params` is a discriminated union and only some members carry notes, so
      // it is read through a widened view rather than assumed.
      ...(() => {
        const notes = (input.params as { notes?: Record<string, unknown> }).notes;
        if (!notes) return {};
        const reason = safeAgentReason(notes.agent_reason);
        return { notes: { ...notes, ...(reason ? { agent_reason: reason } : {}) } };
      })(),
      amount: input.amount,
      currency: input.currency,
      category: input.category,
      customerId: input.customerId ?? null,
      // Server-stamped, last, so nothing a caller sent can impersonate them.
      ...(stamp?.offerId ? { offer_id: stamp.offerId } : {}),
      ...(stamp?.mrtr ? { mrtr: stamp.mrtr } : {}),
      ...(stamp?.offeredSku ? { offered_sku: stamp.offeredSku } : {}),
    } as unknown as Json,
    agentId,
    decision,
    ruleFiredId: match?.rule.id ?? null,
    reasoning,
    razorpayResponse,
  });

  if (mode === "enforce") {
    if (decision === "escalate") {
      await createEscalationForTrace(merchantId, trace.id);
      await createAlert(merchantId, trace.id, "notable", `Escalation: ${reasoning}`);
    } else if (decision === "block") {
      await createAlert(merchantId, trace.id, "high", `Blocked: ${reasoning}`);
    }
    await recomputeTrust(agentId);
  }

  return {
    decision,
    ruleFired: match ? { id: match.rule.id, name: match.rule.name, type: match.rule.type } : null,
    reasoning,
    traceId: trace.id,
    wouldEscalate: decision === "escalate",
    razorpayResponse,
  };
}
