import "server-only";
import { evaluatePolicy } from "@/lib/policy/engine";
import { executeRealAction } from "@/lib/razorpay/actions";
import type { ActionInput } from "@/lib/mcp/schemas";
import {
  createAlert,
  createEscalationForTrace,
  getActiveRules,
  getAggregates,
  insertTrace,
  recomputeTrust,
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
  const rules = await getActiveRules();
  const aggregates = await getAggregates(agentId, rules, input.currency);

  const match = evaluatePolicy(
    {
      actionType: input.actionType,
      amount: input.amount,
      currency: input.currency,
      category: input.category,
      agentId,
      customerId: input.customerId,
    },
    rules,
    aggregates
  );

  const decision = match?.decision ?? "allow";
  const reasoning = match?.reasoning ?? "No policy rule matched — allowed by default.";

  let razorpayResponse: Json | null = null;
  if (mode === "enforce" && decision === "allow") {
    razorpayResponse = await executeRealAction(input);
  }

  const trace = await insertTrace({
    parentTraceId: input.forkFrom ?? null,
    mode,
    actionType: input.actionType,
    params: { amount: input.amount, currency: input.currency, category: input.category, ...input.params } as unknown as Json,
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
