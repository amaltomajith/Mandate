import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { evaluatePolicy } from "@/lib/policy/engine";
import type { EvaluationAggregates, PolicyRule } from "@/lib/policy/types";
import { fetchCatalog } from "@/lib/demo/catalog";
import { suggestCrossSell } from "@/lib/demo/crossSell";

/**
 * The counter-offer: what Mandate proposes back when a buyer proposes a
 * purchase.
 *
 * Two jobs, kept apart on purpose.
 *
 * The MODEL picks candidate complements from the live catalog. That prompt
 * stays in the `public` egress class — it carries the catalog and a SKU, both
 * already served unauthenticated at /api/m/<slug>/catalog.
 *
 * The ENGINE decides which candidates the merchant would actually permit.
 * Caps, thresholds and trust scores are never sent to any model, and this file
 * does not widen that boundary: it calls `evaluatePolicy` directly with rules
 * and aggregates the caller already fetched.
 *
 * Getting that separation wrong would be the quiet failure here. A model that
 * knows the step-up threshold could be induced to propose just underneath it,
 * which is precisely the structuring the rate limiter exists to catch.
 */

/** Bounded so a catalog description cannot become an instruction in the buyer
 *  agent's context. See `safeReason`. */
const MAX_REASON_CHARS = 160;

export interface CounterOffer {
  sku: string;
  name: string;
  amountPaise: number;
  currency: string;
  category: string;
  /** One sentence a buyer agent can show a human. Untrusted text — see below. */
  reason: string;
}

/**
 * The pitch reaches another agent's context, so it is data and never
 * instructions.
 *
 * Catalog copy is merchant-editable and the pitch is model-written, which makes
 * this a path from two soft sources into a third party's prompt. Stripping the
 * characters that make text look structural — braces, backticks, angle
 * brackets, newlines — and bounding the length means the worst case is an odd
 * sentence rather than something that reads as a directive.
 */
function safeReason(raw: string): string {
  const cleaned = raw
    .replace(/[<>{}`[\]\\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return "Pairs with what you are buying.";
  return cleaned.length > MAX_REASON_CHARS
    ? `${cleaned.slice(0, MAX_REASON_CHARS - 1).trimEnd()}…`
    : cleaned;
}

export interface CounterOfferContext {
  db: SupabaseClient;
  merchantId: string;
  agentId: string;
  customerId?: string;
  currency: string;
  /** The SKU the buyer is already purchasing, so the complement is not the
   *  same product. Absent when the parent action names no catalog item, in
   *  which case there is nothing to complement and no offer is made. */
  parentSku?: string;
  /** Rules and aggregates the caller already fetched for the parent decision.
   *  Reused rather than re-read so the candidate is judged against exactly the
   *  same state the parent was — a candidate cleared against fresher
   *  aggregates than the parent would be cleared against a world that never
   *  existed. */
  rules: PolicyRule[];
  aggregates: EvaluationAggregates;
  agentTrustScore?: number;
  agentCatalogScope?: string[] | null;
}

/**
 * Finds one complement the merchant's own policy would currently permit.
 *
 * Returns null freely: no parent SKU, no model suggestion, an ungrounded SKU, a
 * candidate the engine would not clear, or any failure at all. A counter-offer
 * is an optional extra on top of a purchase that has already been decided, so
 * it must never be able to fail the purchase it rides on. Every exit here is a
 * quiet null rather than a throw.
 */
export async function findCounterOffer(ctx: CounterOfferContext): Promise<CounterOffer | null> {
  if (!ctx.parentSku) return null;

  try {
    const catalog = await fetchCatalog(ctx.db, ctx.merchantId);
    if (catalog.length < 2) return null;

    // Public egress: the catalog and a SKU, nothing about policy.
    const suggestion = await suggestCrossSell(catalog, ctx.parentSku);
    if (!suggestion) return null;

    // suggestCrossSell already grounds the SKU against the catalog it was
    // given; re-checking here is cheap and means this function cannot be made
    // to emit a product that does not exist even if that changes.
    const item = catalog.find((c) => c.sku === suggestion.item.sku);
    if (!item || item.sku === ctx.parentSku) return null;

    // The engine decides. Pre-cleared against the same rules and aggregates the
    // parent was judged on, which costs nothing and moves nothing — this is the
    // simulate path's reasoning applied inline, so it consumes no rate budget
    // and writes no trace.
    const verdict = evaluatePolicy(
      {
        actionType: "order.create",
        amount: item.priceInPaise,
        currency: ctx.currency,
        category: item.category,
        agentId: ctx.agentId,
        customerId: ctx.customerId,
        agentTrustScore: ctx.agentTrustScore,
        agentCatalogScope: ctx.agentCatalogScope,
      },
      ctx.rules,
      ctx.aggregates
    );

    // Only offer what currently clears. Offering something that would be
    // refused on acceptance wastes a round trip and teaches a buyer agent that
    // this merchant's offers cannot be trusted.
    if (verdict !== null) return null;

    return {
      sku: item.sku,
      name: item.name,
      amountPaise: item.priceInPaise,
      currency: ctx.currency,
      category: item.category,
      reason: safeReason(suggestion.pitch),
    };
  } catch (err) {
    console.warn("[counterOffer] suppressed:", err instanceof Error ? err.message : err);
    return null;
  }
}
