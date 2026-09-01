"use server";

import { requireDashboardUser } from "./authGuard";
import { fetchCatalog } from "@/lib/demo/catalog";
import { MandateClient } from "@/lib/demo/mandateClient";
import { createAdminClient, ensureAgentIdentity } from "@/lib/demo/shared";

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
 * Costs nothing to run: velocity aggregates count only `enforce`-mode traces
 * (see getAggregates), so probing the whole catalog does not consume the
 * agent's rate limit or move any money.
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
  decision: "allow" | "escalate" | "block";
  reasoning: string;
}

export interface SellableSnapshot {
  items: SellableItem[];
  checkedAt: string;
}

interface ActionResult {
  decision: "allow" | "block" | "escalate";
  reasoning: string;
}

export async function getSellableCatalog(): Promise<SellableSnapshot> {
  await requireDashboardUser();
  const db = createAdminClient();

  const catalog = await fetchCatalog(db);
  const { id: agentId, secretKeyBase64 } = await ensureAgentIdentity(db, {
    envIdVar: "SIM_AGENT_ID",
    envSecretVar: "SIM_AGENT_SECRET_KEY",
    name: "Checkout Agent",
    description: "An AI buyer agent transacting on behalf of customers.",
  });

  const client = new MandateClient(
    process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
    agentId,
    secretKeyBase64
  );
  await client.initialize("mandate-sellable-check");

  const items: SellableItem[] = [];

  for (const item of catalog) {
    const probe = await client.callTool<ActionResult>("simulate_action", {
      actionType: "order.create",
      amount: item.priceInPaise,
      currency: "INR",
      category: item.category,
      params: { receipt: `sellable-${Date.now()}-${item.sku}` },
    });

    items.push({
      sku: item.sku,
      name: item.name,
      description: item.description,
      category: item.category,
      priceInPaise: item.priceInPaise,
      decision: probe.decision,
      reasoning: probe.reasoning,
    });
  }

  return {
    items: items.sort((a, b) => a.priceInPaise - b.priceInPaise),
    checkedAt: new Date().toISOString(),
  };
}
