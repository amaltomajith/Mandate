import "server-only";
import { randomUUID } from "node:crypto";
import { evaluatePolicy } from "@/lib/policy/engine";
import { executeRealAction } from "@/lib/razorpay/actions";
import type { ActionInput } from "@/lib/mcp/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { getMerchantIdForAgent } from "@/lib/merchant";
import { getSettings } from "@/lib/settings";
import { hardChecks, resolveActionFacts } from "@/lib/mcp/facts";
import { withMerchantLock } from "@/lib/merchantLock";
import {
  createAlert,
  createEscalationForTrace,
  getActiveRules,
  getAgentPolicyFacts,
  getAggregates,
  insertTrace,
  recomputeTrust,
  updateTraceOutcome,
} from "@/lib/mcp/traceHelpers";
import type { Json } from "@/types/db";

export interface EvaluationOutcome {
  decision: "allow" | "block" | "escalate";
  ruleFired: { id: string; name: string; type: string } | null;
  reasoning: string;
  traceId: string;
  wouldEscalate: boolean;
  razorpayResponse: Json | null;
  /** Set when the wall allowed the action but the real call then failed. The
   *  decision stands (the wall said yes); the money did not move. */
  executionError?: string;
  /** True when the action was evaluated but deliberately not executed because
   *  the merchant has the agents in dry-run. */
  dryRun?: boolean;
}

/**
 * The agent's own words, made safe to keep and to show.
 *
 * An agent may send a one-line reason with its action. That text is written by a
 * model, stored in our database, and rendered in the merchant's browser — three
 * hops from untrusted input to a human's screen. It is stripped of structural
 * characters and bounded here, at write time, rather than at render time: React
 * escaping protects the DOM, not the database, and not whatever reads it next.
 */
function safeAgentReason(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const cleaned = raw.replace(/[<>{}`[\]\\]/g, "").replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  return cleaned.length > 160 ? `${cleaned.slice(0, 159).trimEnd()}…` : cleaned;
}

/**
 * What each in-house agent may even ask for.
 *
 * Least privilege, enforced where it cannot be talked around: an agent that has
 * been hijacked by a hostile email still cannot propose an action outside its
 * job. The Selling agent has no business moving money to a supplier, and the
 * Buying agent has no business changing a price, so neither can try. Outside
 * agents are not listed; they are bounded by rules alone.
 */
const AGENT_PERMISSIONS: Record<"selling" | "buying", readonly string[]> = {
  selling: ["order.create", "payment_link.create", "refund.create", "price.change"],
  buying: ["payout.create"],
};

/**
 * Shared core of `simulate_action` and `enforce_action` — identical decision
 * logic either way. The only branch point is `mode`: "enforce" is the one that
 * calls {@link executeRealAction}, and only when the policy engine says "allow".
 *
 * Order of events, and why:
 *  1. The tenant comes from the agent row the signature already proved, never
 *     from the request.
 *  2. Hard stops that precede policy: a retired agent is refused outright, and a
 *     paused agent or switched-off team is blocked and recorded. A cooperative
 *     "please stop" an agent may ignore is not a control; this is.
 *  3. Facts (payee, cost) are read from the database, not taken from the caller.
 *  4. The trace is written BEFORE any money moves, then updated with the result.
 *     A crash between the two leaves an audit record of an allowed action, never
 *     money gone with no explanation.
 */
export async function runActionEvaluation(
  agentId: string,
  input: ActionInput,
  mode: "simulate" | "enforce"
): Promise<EvaluationOutcome> {
  const merchantId = await getMerchantIdForAgent(createAdminClient(), agentId);
  // Enforce calls for one merchant run one at a time, so two of them cannot both
  // read the same "spent so far" and together exceed a cap. See merchantLock.ts.
  if (mode === "enforce") return withMerchantLock(merchantId, () => evaluate(agentId, merchantId, input, mode));
  return evaluate(agentId, merchantId, input, mode);
}

async function evaluate(
  agentId: string,
  merchantId: string,
  input: ActionInput,
  mode: "simulate" | "enforce"
): Promise<EvaluationOutcome> {
  const db = createAdminClient();
  const agentFacts = await getAgentPolicyFacts(agentId);
  if (agentFacts.retired) throw new Error("This agent has been retired and cannot act.");

  const settings = await getSettings(db, merchantId);
  const inhouse = agentFacts.kind === "selling" || agentFacts.kind === "buying";
  // Dry-run is the merchant's "show me what you would do". It is enforced here,
  // not trusted to the worker, so no caller can configure its way past it.
  const dryRun = mode === "enforce" && inhouse && settings.dry_run;
  const effectiveMode: "simulate" | "enforce" = dryRun ? "simulate" : mode;

  let hardReason: string | null = null;
  let match: ReturnType<typeof evaluatePolicy> = null;
  let decision: "allow" | "block" | "escalate";
  let reasoning: string;

  if (agentFacts.status === "paused") {
    decision = "block";
    reasoning = "This agent is paused by the merchant, so it cannot act until it is resumed.";
  } else if (inhouse && !AGENT_PERMISSIONS[agentFacts.kind as "selling" | "buying"].includes(input.actionType)) {
    decision = "block";
    reasoning = `The ${agentFacts.kind} agent is not permitted to propose "${input.actionType}". That is outside its role.`;
  } else if (inhouse && !settings.agents_enabled) {
    decision = "block";
    reasoning = "The merchant has switched the autonomous team off, so no agent action is allowed.";
  } else if (await hardChecks(merchantId, input).then((r) => (hardReason = r))) {
    decision = "block";
    reasoning = hardReason!;
  } else {
    const facts = await resolveActionFacts(merchantId, input);
    const rules = await getActiveRules(merchantId);
    const payeeId = input.actionType === "payout.create" ? input.params.payeeId : undefined;
    const aggregates = await getAggregates(merchantId, agentId, rules, input.currency, input.customerId, payeeId);
    match = evaluatePolicy(
      {
        actionType: input.actionType,
        amount: input.amount,
        currency: input.currency,
        category: input.category,
        agentId,
        customerId: input.customerId,
        agentTrustScore: agentFacts.trustScore,
        agentCatalogScope: agentFacts.catalogScope,
        payee: facts.payee,
        economics: facts.economics,
      },
      rules,
      aggregates
    );
    decision = match?.decision ?? "allow";
    reasoning = match?.reasoning ?? "No policy rule matched — allowed by default.";
  }

  const traceId = randomUUID();
  const trace = await insertTrace({
    id: traceId,
    merchantId,
    parentTraceId: null,
    mode: effectiveMode,
    actionType: input.actionType,
    // Caller params first, authoritative fields last. `amount` here is what the
    // revenue figures and the history read, and it has to be the amount the
    // policy engine actually judged; spread the other way round, a caller
    // passing `params: { amount: 1 }` would have its action evaluated on the
    // real amount but recorded as one paisa.
    params: {
      ...input.params,
      // Re-written over the caller's own copy, sanitised. Spread order matters:
      // this has to land after the spread or the raw value survives. `params` is
      // a discriminated union and only some members carry notes.
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
      ...(dryRun ? { dry_run: true } : {}),
    } as unknown as Json,
    agentId,
    decision,
    ruleFiredId: match?.rule.id ?? null,
    reasoning: dryRun ? `[dry run, nothing executed] ${reasoning}` : reasoning,
    razorpayResponse: null,
  });

  let razorpayResponse: Json | null = null;
  let executionError: string | undefined;
  if (effectiveMode === "enforce" && decision === "allow") {
    try {
      razorpayResponse = await executeRealAction(input, { merchantId, traceId: trace.id, agentId });
      await updateTraceOutcome(merchantId, trace.id, { razorpayResponse });
    } catch (err) {
      executionError = err instanceof Error ? err.message : String(err);
      razorpayResponse = { error: executionError };
      await updateTraceOutcome(merchantId, trace.id, {
        razorpayResponse,
        reasoning: `${reasoning} The wall allowed it, but the action failed: ${executionError}`,
      });
      await createAlert(merchantId, trace.id, "high", `Allowed but failed to execute: ${executionError}`);
    }
  }

  if (effectiveMode === "enforce") {
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
    ...(executionError ? { executionError } : {}),
    ...(dryRun ? { dryRun: true } : {}),
  };
}

/**
 * The checks an approval must still pass.
 *
 * A human approving an escalation overrides the rules that exist to ask a human
 * (step-up, trust, and an unknown margin) but not the ones that are limits: a
 * payee that has been revoked since, a cap, a budget already spent, a blocked
 * category. Time passes between an escalation and its approval, and an approval
 * that quietly skipped a limit which has since tightened would turn the inbox
 * into a way around the wall.
 *
 * Velocity is excluded too: the action being approved is itself a recent trace,
 * so it would count against its own rate limit.
 */
const LIMIT_RULES = new Set(["category_block", "whitelisted_payee", "catalog_scope", "cap", "payout_budget"]);

export async function recheckBeforeApproval(
  merchantId: string,
  agentId: string,
  input: ActionInput
): Promise<{ ok: true } | { ok: false; reasoning: string }> {
  const agentFacts = await getAgentPolicyFacts(agentId);
  if (agentFacts.retired) return { ok: false, reasoning: "The agent that proposed this has since been retired." };

  const hard = await hardChecks(merchantId, input);
  if (hard) return { ok: false, reasoning: hard };

  const facts = await resolveActionFacts(merchantId, input);
  const rules = (await getActiveRules(merchantId)).filter((r) => LIMIT_RULES.has(r.type));
  const payeeId = input.actionType === "payout.create" ? input.params.payeeId : undefined;
  const aggregates = await getAggregates(merchantId, agentId, rules, input.currency, input.customerId, payeeId);
  const match = evaluatePolicy(
    {
      actionType: input.actionType,
      amount: input.amount,
      currency: input.currency,
      category: input.category,
      agentId,
      customerId: input.customerId,
      agentCatalogScope: agentFacts.catalogScope,
      payee: facts.payee,
      economics: facts.economics,
    },
    rules,
    aggregates
  );
  return match ? { ok: false, reasoning: match.reasoning } : { ok: true };
}
