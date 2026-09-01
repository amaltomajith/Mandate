import "server-only";
import { evaluatePolicy } from "@/lib/policy/engine";
import { executeRealAction } from "@/lib/razorpay/actions";
import type { ActionInput } from "@/lib/mcp/schemas";
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
export async function runActionEvaluation(
  agentId: string,
  input: ActionInput,
  mode: "simulate" | "enforce"
): Promise<EvaluationOutcome> {
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
    const rules = await getActiveRules();
    const aggregates = await getAggregates(agentId, rules, input.currency, input.customerId);
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
        await recordMandateFromSubscription(agentId, input.customerId, subscriptionId, razorpayResponse);
      }
    }
  }

  const trace = await insertTrace({
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
      amount: input.amount,
      currency: input.currency,
      category: input.category,
      customerId: input.customerId ?? null,
    } as unknown as Json,
    agentId,
    decision,
    ruleFiredId: match?.rule.id ?? null,
    reasoning,
    razorpayResponse,
  });

  if (mode === "enforce") {
    if (decision === "escalate") {
      await createEscalationForTrace(trace.id);
      await createAlert(trace.id, "notable", `Escalation: ${reasoning}`);
    } else if (decision === "block") {
      await createAlert(trace.id, "high", `Blocked: ${reasoning}`);
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
