"use server";

import { revalidatePath } from "next/cache";
import { requireDashboardUser } from "./authGuard";
import { fetchCatalog, type CatalogItem } from "@/lib/demo/catalog";
import { MandateClient } from "@/lib/demo/mandateClient";
import { createAdminClient, ensureAgentIdentity, moneyLabel } from "@/lib/demo/shared";
import { interpretRequest, isChoice } from "@/lib/demo/shopper";

/**
 * Conversational checkout: a person says what they want, an agent buys it, and
 * every step is the same governed path any external agent would take.
 *
 * Nothing here is a shortcut around the policy engine — the purchase goes
 * through `enforce_action` over a signed MCP call exactly like the simulated
 * agent's traffic, so it can be escalated or refused, and it lands in the same
 * audit trail. The only difference is who started it.
 *
 * The growth mechanism is the last step. When policy refuses what was asked
 * for, the agent doesn't stop at "no" — it probes the catalog for the most
 * valuable thing that *would* clear and offers that instead. A refusal becomes
 * a smaller sale rather than an abandoned one. Probing is free: velocity
 * counts only enforce-mode traces, so simulating alternatives costs the agent
 * nothing against its own rate limit.
 */

export interface CheckoutStep {
  label: string;
  detail: string;
  status: "ok" | "escalated" | "blocked" | "info";
}

export interface CheckoutResult {
  steps: CheckoutStep[];
  /** Set when something was actually bought or held for approval. */
  purchased?: { name: string; amountPaise: number; decision: "allow" | "escalate" };
  /** Set when the original ask was refused but something else would clear. */
  alternative?: { name: string; amountPaise: number; reason: string };
}

interface ActionResult {
  decision: "allow" | "block" | "escalate";
  reasoning: string;
  traceId: string;
}

const SIM_AGENT = {
  envIdVar: "SIM_AGENT_ID",
  envSecretVar: "SIM_AGENT_SECRET_KEY",
  name: "Checkout Agent",
  description: "An AI buyer agent transacting on behalf of customers.",
};

export async function buyFromRequest(request: string): Promise<CheckoutResult> {
  await requireDashboardUser();
  const trimmed = request.trim();
  if (!trimmed) throw new Error("Say what you'd like to buy.");

  const db = createAdminClient();
  const steps: CheckoutStep[] = [];

  const catalog = await fetchCatalog(db);
  const intent = await interpretRequest(catalog, trimmed);

  if (!isChoice(intent)) {
    steps.push({ label: "Agent read the request", detail: intent.reason, status: "info" });
    return { steps };
  }

  const { item, reason, maxAmountPaise } = intent;
  steps.push({
    label: `Agent chose ${item.name} · ${moneyLabel(item.priceInPaise)}`,
    detail: reason,
    status: "info",
  });

  // The shopper's own ceiling is checked before the merchant's policy is
  // consulted at all. Buying past someone's stated budget because the merchant
  // happens to permit it would be the agent serving the wrong party.
  if (maxAmountPaise !== null && item.priceInPaise > maxAmountPaise) {
    steps.push({
      label: "Stopped — over your budget",
      detail: `${item.name} costs ${moneyLabel(item.priceInPaise)}, above the ${moneyLabel(maxAmountPaise)} you set. Nothing was bought.`,
      status: "blocked",
    });
    const cheaper = catalog
      .filter((c) => c.priceInPaise <= maxAmountPaise)
      .sort((a, b) => b.priceInPaise - a.priceInPaise)[0];
    return {
      steps,
      alternative: cheaper
        ? {
            name: cheaper.name,
            amountPaise: cheaper.priceInPaise,
            reason: `the closest thing inside your budget`,
          }
        : undefined,
    };
  }

  const { id: agentId, secretKeyBase64 } = await ensureAgentIdentity(db, SIM_AGENT);
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const client = new MandateClient(baseUrl, agentId, secretKeyBase64);
  await client.initialize("mandate-conversational-checkout");

  const result = await client.callTool<ActionResult>("enforce_action", {
    actionType: "order.create",
    amount: item.priceInPaise,
    currency: "INR",
    category: item.category,
    params: { receipt: `checkout-${Date.now()}`, notes: { source: "conversational-checkout" } },
  });

  if (result.decision === "allow") {
    steps.push({ label: "Bought", detail: result.reasoning, status: "ok" });
    revalidatePath("/dashboard");
    return { steps, purchased: { name: item.name, amountPaise: item.priceInPaise, decision: "allow" } };
  }

  if (result.decision === "escalate") {
    steps.push({
      label: "Held for your approval",
      detail: `${result.reasoning} It's waiting in Escalations — approving it there completes the purchase.`,
      status: "escalated",
    });
    revalidatePath("/dashboard");
    return { steps, purchased: { name: item.name, amountPaise: item.priceInPaise, decision: "escalate" } };
  }

  steps.push({ label: "Refused by policy", detail: result.reasoning, status: "blocked" });

  // Recover the sale rather than ending on a refusal: find the most valuable
  // thing that would actually clear, and offer that.
  const alternative = await bestClearingAlternative(client, catalog, item, maxAmountPaise);
  if (alternative) {
    steps.push({
      label: `Offered instead: ${alternative.name} · ${moneyLabel(alternative.priceInPaise)}`,
      detail: "The most valuable item that clears policy right now — asked for, rather than bought, since it isn't what you requested.",
      status: "info",
    });
  }

  revalidatePath("/dashboard");
  return {
    steps,
    alternative: alternative
      ? { name: alternative.name, amountPaise: alternative.priceInPaise, reason: "clears policy right now" }
      : undefined,
  };
}

/** Probes candidates most-valuable-first and returns the first that would be
 *  permitted. Uses simulate_action, so nothing is bought and nothing is
 *  charged against the agent's rate limit. */
async function bestClearingAlternative(
  client: MandateClient,
  catalog: CatalogItem[],
  rejected: CatalogItem,
  maxAmountPaise: number | null
): Promise<CatalogItem | null> {
  const candidates = catalog
    .filter((c) => c.sku !== rejected.sku)
    .filter((c) => maxAmountPaise === null || c.priceInPaise <= maxAmountPaise)
    .sort((a, b) => b.priceInPaise - a.priceInPaise);

  for (const candidate of candidates) {
    const probe = await client.callTool<ActionResult>("simulate_action", {
      actionType: "order.create",
      amount: candidate.priceInPaise,
      currency: "INR",
      category: candidate.category,
      params: { receipt: `probe-${Date.now()}-${candidate.sku}` },
    });
    if (probe.decision === "allow") return candidate;
  }
  return null;
}
