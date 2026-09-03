"use server";

import { requireDashboardUser } from "./authGuard";
import { getCurrentMerchant } from "@/lib/merchant";
import { fetchCatalog } from "@/lib/demo/catalog";
import { createAdminClient } from "@/lib/supabase/admin";
import { evaluatePolicy } from "@/lib/policy/engine";
import { getActiveRules, getAggregates } from "@/lib/mcp/traceHelpers";

/**
 * What the agent can actually sell right now.
 *
 * A price list says what exists; this says what would *go through*. Each item
 * is put to the real policy engine through `simulate_action`, so the answer is
 * the one the engine would genuinely give — not a re-implementation of the
 * rules in the UI that could drift from them.
 *
 * This is the headroom mechanism made visible. The same probing the agent does
 * before it proposes an upsell, shown to the merchant: these clear, these need
 * you, these are refused. It changes as trust moves, as caps are edited, and
 * as the agent's own rate budget is consumed — which is the point. A static
 * catalog cannot tell a merchant that half their range has become unsellable
 * because an agent's trust fell.
 *
 * PER AGENT, and evaluated IN PROCESS rather than over the wire. That change is
 * forced by the thing this project is proudest of: signing as an agent requires
 * that agent's private key, and a third party's key is never generated, stored
 * or reachable here. So there is no way to send a signed probe on another
 * agent's behalf — and the moment there were, the isolation the buyer exists to
 * demonstrate would be a claim rather than a fact.
 *
 * What it calls instead is `evaluatePolicy` — the same pure engine the MCP path
 * calls, with the same live rules, the same aggregates and the same per-agent
 * trust and scope. Exactly the precedent counterOffer.ts already sets. The
 * mandate gate is the one thing the wire path adds, and it only runs when an
 * action names a customer; these probes name none, so the two paths decide
 * identically here.
 *
 * The catalog stays UNSCOPED on purpose. Filtering out what an agent may not
 * touch would answer a different question — the merchant wants to see that this
 * product is refused *and why*, not to have it quietly disappear. An
 * out-of-scope item renders as a block with the scope named, which is what
 * makes two agents' views differ visibly rather than just differ in length.
 *
 * Costs nothing to run: nothing is written, so probing the whole catalog does
 * not consume the agent's rate limit or move any money.
 *
 * Returns per-item verdicts and nothing aggregated. Summing list prices across
 * these buckets produced a number that measured nothing real — not revenue,
 * not inventory — so the counting is left to the caller, where "5 of 6
 * products" is a statement a merchant can actually act on.
 */

export interface SellableItem {
  sku: string;
  name: string;
  description: string;
  category: string;
  priceInPaise: number;
  /** `unknown` when this one probe failed. One bad answer becomes one honest
   *  row rather than an error where five good rows should be — a merchant
   *  looking at five verdicts and one gap is better informed than one looking
   *  at a red box. */
  decision: "allow" | "escalate" | "block" | "unknown";
  reasoning: string;
}

export interface SellableSnapshot {
  items: SellableItem[];
  checkedAt: string;
  /** Whose view this is. Named so a merchant reading two different answers
   *  knows which agent each belongs to. */
  agent: { id: string; name: string; trustScore: number; catalogScope: string[] | null } | null;
}

export interface HeadroomAgent {
  id: string;
  name: string;
  managed: boolean;
  catalogScope: string[] | null;
}

/** The agents a merchant can ask "what could this one sell?" about. */
export async function listHeadroomAgents(): Promise<HeadroomAgent[]> {
  await requireDashboardUser();
  const merchant = await getCurrentMerchant();
  const db = createAdminClient();
  const { data } = await db
    .from("agents")
    .select("id, name, managed, catalog_scope")
    .eq("merchant_id", merchant.id)
    .order("managed")
    .order("name");
  return (data ?? []).map((a) => ({
    id: a.id,
    name: a.name,
    managed: a.managed,
    catalogScope: a.catalog_scope,
  }));
}

export async function getSellableCatalog(agentId?: string): Promise<SellableSnapshot> {
  await requireDashboardUser();
  const merchant = await getCurrentMerchant();
  const db = createAdminClient();

  // Scoped by merchant as well as id. A row id is not authorization -- section
  // 17 records treating one as such as a real bug -- so an id from another
  // tenant resolves to nothing rather than to someone else's agent.
  const { data: agentRow } = agentId
    ? await db
        .from("agents")
        .select("id, name, trust_score, catalog_scope")
        .eq("id", agentId)
        .eq("merchant_id", merchant.id)
        .maybeSingle()
    : await db
        .from("agents")
        .select("id, name, trust_score, catalog_scope")
        .eq("merchant_id", merchant.id)
        .eq("managed", true)
        .maybeSingle();

  const catalog = await fetchCatalog(db, merchant.id);

  if (!agentRow) {
    // No agent to answer for. Honest emptiness rather than a view attributed to
    // nobody -- a verdict with no agent behind it is not a verdict.
    return { items: [], checkedAt: new Date().toISOString(), agent: null };
  }

  const rules = await getActiveRules(merchant.id);
  const aggregates = await getAggregates(merchant.id, agentRow.id, rules, "INR");

  const items: SellableItem[] = catalog.map((item) => {
    const match = evaluatePolicy(
      {
        actionType: "order.create",
        amount: item.priceInPaise,
        currency: "INR",
        category: item.category,
        agentId: agentRow.id,
        agentTrustScore: agentRow.trust_score,
        agentCatalogScope: agentRow.catalog_scope,
      },
      rules,
      aggregates
    );
    return {
      sku: item.sku,
      name: item.name,
      description: item.description,
      category: item.category,
      priceInPaise: item.priceInPaise,
      decision: match ? match.decision : "allow",
      reasoning: match ? match.reasoning : "No policy rule matched — this would clear.",
    };
  });

  return {
    items: items.sort((a, b) => a.priceInPaise - b.priceInPaise),
    checkedAt: new Date().toISOString(),
    agent: {
      id: agentRow.id,
      name: agentRow.name,
      trustScore: agentRow.trust_score,
      catalogScope: agentRow.catalog_scope,
    },
  };
}

