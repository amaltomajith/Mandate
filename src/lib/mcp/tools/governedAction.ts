import "server-only";
import { randomUUID } from "node:crypto";
import type { ActionInput } from "@/lib/mcp/schemas";
import { runActionEvaluation, type EvaluationOutcome } from "./actionEvaluator";
import { findCounterOffer, type CounterOffer } from "@/lib/mcp/counterOffer";
import { counterOffersConfigured } from "@/lib/mcp/requestState";
import type { OfferState } from "@/lib/mcp/requestState";
import { createAdminClient } from "@/lib/supabase/admin";
import { getMerchantIdForAgent } from "@/lib/merchant";
import { getActiveRules, getAggregates, getAgentPolicyFacts } from "@/lib/mcp/traceHelpers";
import { fetchCatalog } from "@/lib/demo/catalog";

/**
 * The counter-offer round trip, wrapped around the ordinary decision path.
 *
 * === THE INVARIANT ===
 *
 * MRTR retries the ORIGINAL call. The second POST re-enters this function with
 * the same arguments plus the buyer's answers, which means there are two
 * separate, independently verified requests for one logical purchase:
 *
 *   POST #1  evaluate the parent, execute NOTHING, return the offer
 *   POST #2  re-verify, re-gate, re-evaluate, THEN execute
 *
 * Nothing from POST #1's decision is carried forward and reused. Trust,
 * velocity, caps and mandates may all have moved between the two posts —
 * seconds apart or minutes — and a cached "it was allowed a moment ago" is
 * precisely the bypass this design has to avoid. POST #2 calls the same
 * `runActionEvaluation` a first-time caller would, and can legitimately reach a
 * different answer. That is the feature, not a race.
 *
 * The only thing that crosses between the posts is the sealed `requestState`,
 * and even that is treated as a hint: the offered product is re-derived from
 * the catalog by SKU, so a stale price cannot be replayed and the seal only has
 * to stop substitution.
 *
 * Executing twice is prevented by a uniqueness constraint rather than a check,
 * because a check loses the race two concurrent retries create. See migration
 * 0011.
 */

export interface CounterOfferOutcome {
  offered: CounterOffer;
  accepted: boolean;
  /** Present when accepted and the child action was evaluated. It may have been
   *  refused — an accepted offer is consent, not authorization. */
  child?: EvaluationOutcome;
}

export type GovernedResult =
  | {
      kind: "result";
      outcome: EvaluationOutcome;
      /** For clients that cannot do a round trip: the same pre-cleared
       *  candidate, attached to the ordinary result. The fallback is a feature,
       *  not a hedge — most MCP clients today declare no elicitation. */
      suggestions?: CounterOffer[];
      counterOffer?: CounterOfferOutcome;
    }
  | {
      kind: "input_required";
      offer: CounterOffer;
      state: OfferState;
      /** The parent's preview decision, so a caller can see what would happen.
       *  Nothing has executed at this point. */
      preview: EvaluationOutcome;
    };

export interface MrtrContext {
  /** Declared per request in the `_meta` envelope. */
  supportsElicitation: boolean;
  /** Verified and decoded by the SDK's request-state codec. Present only on a
   *  retry, and only when the seal held. */
  offerState?: OfferState;
  /** The buyer's answer, keyed as the offer was. */
  accepted?: boolean;
  /** The buyer's own words about that answer. Untrusted; sanitised where it is
   *  written onto the trace, not here. */
  buyerReason?: string;
}

/**
 * Attaches the buyer's stated reason to a copy of the input, so the decline
 * trace carries it.
 *
 * A copy rather than a mutation: `input` is the thing POST #2 re-evaluates, and
 * quietly editing it would mean the parent decision and the decline record were
 * judged on different objects. The reason is sanitised where it is written --
 * see safeAgentReason in actionEvaluator -- not here.
 */
function withAgentReason(input: ActionInput, reason?: string): ActionInput {
  if (!reason) return input;
  const notes = (input.params as { notes?: Record<string, string> }).notes ?? {};
  return {
    ...input,
    params: { ...input.params, notes: { ...notes, agent_reason: reason } },
  } as ActionInput;
}

/** The SKU the parent action is for, when it names one. Written onto the trace
 *  at purchase time; there is deliberately no inference from the amount, for
 *  the same reason the order history refuses to guess. */
function parentSku(input: ActionInput): string | undefined {
  const notes = (input.params as { notes?: Record<string, string> }).notes;
  return notes?.sku;
}

export async function runGovernedAction(
  agentId: string,
  input: ActionInput,
  mode: "simulate" | "enforce",
  mrtr: MrtrContext
): Promise<GovernedResult> {
  // ---------------------------------------------------------------- POST #2
  if (mrtr.offerState) {
    // Re-runs everything: mandate gate, policy engine, aggregates, trust. The
    // offer id is stamped here, and the unique index refuses a second retry
    // echoing the same state — a replay becomes an insert conflict rather than
    // a second order.
    const parent = await runActionEvaluation(agentId, input, mode, {
      offerId: mrtr.offerState.offerId,
    });

    if (!mrtr.accepted) {
      // A decline is real signal and is recorded. As a simulate-mode trace: no
      // money was involved in the refusal of an offer, and recording it as
      // enforce would spend a velocity slot and move the trust score for
      // something the agent did entirely correctly.
      await runActionEvaluation(agentId, withAgentReason(input, mrtr.buyerReason), "simulate", {
        mrtr: "counter_declined",
        offeredSku: mrtr.offerState.sku,
      });
      return {
        kind: "result",
        outcome: parent,
        counterOffer: {
          offered: await rehydrate(agentId, mrtr.offerState, input),
          accepted: false,
        },
      };
    }

    // Accepted. The child is a full action in its own right, evaluated by the
    // same engine — so it can be blocked or escalated even though the parent
    // cleared. An accepted offer is consent, never authorization.
    const offered = await rehydrate(agentId, mrtr.offerState, input);
    const child = await runActionEvaluation(
      agentId,
      {
        ...input,
        actionType: "order.create",
        amount: offered.amountPaise,
        category: offered.category,
        forkFrom: parent.traceId,
        params: {
          receipt: `counter-${Date.now()}`,
          notes: { sku: offered.sku, item: offered.name, source: "counter-offer" },
        },
      } as ActionInput,
      mode
    );

    return { kind: "result", outcome: parent, counterOffer: { offered, accepted: true, child } };
  }

  // ---------------------------------------------------------------- POST #1
  //
  // Only enforce mode starts a round trip. `simulate_action` is a preview, and
  // a preview that stops to ask a question is not a preview.
  const canOffer = mode === "enforce" && mrtr.supportsElicitation && counterOffersConfigured();

  if (mode === "enforce" && parentSku(input)) {
    const offer = await previewAndFindOffer(agentId, input, canOffer);

    if (offer && canOffer) {
      // The parent was evaluated in SIMULATE mode above: nothing executed, no
      // Razorpay call, no velocity slot spent, no trust movement. That is what
      // makes "POST #1 executes nothing" structural rather than a promise —
      // there is no code path from here to executeRealAction.
      return {
        kind: "input_required",
        offer: offer.offer,
        state: { offerId: randomUUID(), sku: offer.offer.sku },
        preview: offer.preview,
      };
    }

    if (offer && !canOffer) {
      // Same candidate, delivered as a suggestion on the ordinary result.
      const outcome = await runActionEvaluation(agentId, input, mode);
      return { kind: "result", outcome, suggestions: [offer.offer] };
    }
  }

  return { kind: "result", outcome: await runActionEvaluation(agentId, input, mode) };
}

/**
 * Evaluates the parent without executing, and looks for a complement the
 * engine would currently permit.
 *
 * The preview runs in simulate mode deliberately. It is the same engine on the
 * same inputs, so its answer is the answer — and running it this way means the
 * offer round trip cannot cost the buyer a rate slot or shift its trust score
 * for a purchase that has not happened yet. Item 5 of the design asks for
 * exactly that property; getting it by choosing the right mode rather than by
 * adding filters to `getAggregates` means there is no filter to forget.
 */
async function previewAndFindOffer(
  agentId: string,
  input: ActionInput,
  wantOffer: boolean
): Promise<{ preview: EvaluationOutcome; offer: CounterOffer } | null> {
  const preview = await runActionEvaluation(agentId, input, "simulate", {
    mrtr: wantOffer ? "input_required" : undefined,
  });

  // No offer on a parent the merchant would not permit. Proposing an extra on
  // top of a refusal is noise, and on an escalation it would ask the buyer to
  // decide something before the merchant has.
  if (preview.decision !== "allow") return null;

  const db = createAdminClient();
  const merchantId = await getMerchantIdForAgent(db, agentId);
  const rules = await getActiveRules(merchantId);
  const [aggregates, agentFacts] = await Promise.all([
    getAggregates(merchantId, agentId, rules, input.currency, input.customerId),
    getAgentPolicyFacts(agentId),
  ]);

  const offer = await findCounterOffer({
    db,
    merchantId,
    agentId,
    customerId: input.customerId,
    currency: input.currency,
    parentSku: parentSku(input),
    rules,
    aggregates,
    agentTrustScore: agentFacts.trustScore,
    // Passed so every candidate is pre-cleared against this agent's scope too.
    // Offering something the same engine would then block is worse than not
    // offering at all -- it invites the agent to accept a purchase that cannot
    // complete.
    agentCatalogScope: agentFacts.catalogScope,
  });

  return offer ? { preview, offer } : null;
}

/**
 * Rebuilds the offered product from the catalog on the retry.
 *
 * The sealed state names a SKU and nothing else priceable. Everything the
 * child action is judged on — amount, category — is read from the merchant's
 * own catalog here, so even a perfectly sealed state cannot carry a stale or
 * chosen price into a policy decision.
 */
async function rehydrate(agentId: string, state: OfferState, input: ActionInput): Promise<CounterOffer> {
  const db = createAdminClient();
  const merchantId = await getMerchantIdForAgent(db, agentId);
  const catalog = await fetchCatalog(db, merchantId);
  const item = catalog.find((c) => c.sku === state.sku);
  if (!item) {
    throw new Error(`The offered product (${state.sku}) is no longer in the catalog.`);
  }
  return {
    sku: item.sku,
    name: item.name,
    amountPaise: item.priceInPaise,
    currency: input.currency,
    category: item.category,
    reason: "",
  };
}
