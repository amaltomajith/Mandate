import { fetchCatalog, type CatalogItem } from "./catalog";
import { suggestCrossSell } from "./crossSell";
import { MandateClient } from "./mandateClient";
import { createAdminClient, ensureAgentIdentity, moneyLabel } from "./shared";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The simulated agent — one agent, not a cast of them.
 *
 * This replaced a scripted eleven-step demo that walked through each capability
 * in a fixed order. The script showed the beats reliably but read as a
 * rehearsal: nothing happened unless you pressed play, and it was obvious the
 * outcomes were arranged. A control plane's actual job is continuous, so this
 * shows it continuously — the same capabilities surface, just because traffic
 * happened to hit them rather than because a script said so.
 *
 * The mix below is what makes that work. Purely random purchases would be an
 * unbroken wall of "allow" and would never demonstrate that the engine does
 * anything. Weighting the scenarios means every decision type — allow,
 * escalate, block, protocol_reject — turns up on its own within a minute or
 * two of ordinary running, without any of them being staged.
 *
 * Deliberately NOT scripted per-outcome: each tick picks a scenario by weight
 * and then lets the real policy engine decide. A "high value" tick escalates
 * because it genuinely crosses the step-up threshold, not because the
 * simulation labelled it an escalation. If a rule is retuned, the mix shifts
 * with it — which is the honest behaviour.
 */

/** One agent identity for everything. Velocity is scoped per agent, so a
 *  second identity would spend a separate budget and quietly make the rate
 *  limiter look inert; keeping it to one means the limits shown are the
 *  limits actually being tested. */
const SIM_AGENT = {
  envIdVar: "SIM_AGENT_ID",
  envSecretVar: "SIM_AGENT_SECRET_KEY",
  name: "Checkout Agent",
  description: "An AI buyer agent transacting on behalf of customers.",
};

const SYNTHETIC_CUSTOMERS = [
  { name: "Priya Sharma", email: "priya.sharma@example.com" },
  { name: "Arjun Mehta", email: "arjun.mehta@example.com" },
  { name: "Fatima Khan", email: "fatima.khan@example.com" },
  { name: "Rohan Iyer", email: "rohan.iyer@example.com" },
  { name: "Ananya Gupta", email: "ananya.gupta@example.com" },
];

/** Categories the merchant has banned outright. Kept in step with the
 *  "Blocked categories" seed rule — if that rule's list changes, this is what
 *  stops the simulation from generating traffic that no longer proves
 *  anything. */
const BANNED_CATEGORIES = ["crypto", "gambling"];

type Scenario = "ordinary" | "high_value" | "banned_category" | "forged";

/** Weights, not a schedule. Roughly: most traffic is unremarkable, a minority
 *  needs a human, a little is refused outright, and a little is someone
 *  trying it on. */
const SCENARIO_WEIGHTS: [Scenario, number][] = [
  ["ordinary", 72],
  ["high_value", 14],
  ["banned_category", 8],
  ["forged", 6],
];

function pickScenario(): Scenario {
  const total = SCENARIO_WEIGHTS.reduce((s, [, w]) => s + w, 0);
  let roll = Math.random() * total;
  for (const [scenario, weight] of SCENARIO_WEIGHTS) {
    roll -= weight;
    if (roll <= 0) return scenario;
  }
  return "ordinary";
}

/** Skewed toward the cheaper end of the catalog, which is the ordinary shape
 *  of retail order sizes — not a statistical model, just not a flat random
 *  pick that would make every third order a standing desk.
 *
 *  Keys are real SKUs, and every catalog item is listed. A key matching
 *  nothing falls through to the default weight in silence — which is exactly
 *  what had been happening: "mat-01" was never a SKU (the yoga mat is
 *  "yogamat-01"), so it drew the default 2 rather than the 4 written here,
 *  and the USB-C hub was missing from the map entirely. */
const ITEM_WEIGHTS: Record<string, number> = {
  "mouse-01": 5,
  "hub-01": 4,
  "yogamat-01": 4,
  "keyboard-01": 3,
  "stand-01": 3,
  "desk-01": 1,
};

function weightedItem(catalog: CatalogItem[]): CatalogItem {
  const weighted = catalog.flatMap((item) => Array(ITEM_WEIGHTS[item.sku] ?? 2).fill(item) as CatalogItem[]);
  return weighted[Math.floor(Math.random() * weighted.length)];
}

async function ensureSyntheticCustomers(db: SupabaseClient, merchantId: string): Promise<{ id: string; name: string }[]> {
  const result: { id: string; name: string }[] = [];
  for (const customer of SYNTHETIC_CUSTOMERS) {
    const { data: existing } = await db
      .from("customers")
      .select("id, name")
      .eq("merchant_id", merchantId)
      .eq("name", customer.name)
      .maybeSingle();
    if (existing) {
      result.push(existing);
      continue;
    }
    const { data, error } = await db
      .from("customers")
      .insert({ ...customer, merchant_id: merchantId })
      .select("id, name")
      .single();
    if (error) throw error;
    result.push(data);
  }
  return result;
}

/**
 * A few standing mandates so the Mandates tab isn't empty on a cold start.
 * Only a subset of customers get one, and it's left to chance which — a
 * merchant's real book looks like that, not like every customer having
 * authorized every agent. Idempotent: only tops up when fewer than the
 * target number are active, so it never accumulates duplicates on repeated
 * runs, and never resurrects one the merchant deliberately revoked.
 */
const TARGET_ACTIVE_MANDATES = 3;

export async function ensureSomeActiveMandates(merchantId: string): Promise<number> {
  const db = createAdminClient();
  const { id: agentId } = await ensureAgentIdentity(db, merchantId, SIM_AGENT);
  const customers = await ensureSyntheticCustomers(db, merchantId);

  // Scoped to THIS agent. A mandate belonging to a deleted agent still reads
  // as active but authorizes nobody, so counting it here left the book
  // permanently one short of the target while looking full.
  const { data: existing } = await db
    .from("mandates")
    .select("customer_id")
    .eq("merchant_id", merchantId)
    .eq("status", "active")
    .eq("agent_id", agentId);
  const alreadyHeld = new Set((existing ?? []).map((m) => m.customer_id));
  if (alreadyHeld.size >= TARGET_ACTIVE_MANDATES) return 0;

  const candidates = customers.filter((c) => !alreadyHeld.has(c.id)).sort(() => Math.random() - 0.5);
  const needed = TARGET_ACTIVE_MANDATES - alreadyHeld.size;
  let created = 0;

  for (const customer of candidates.slice(0, needed)) {
    const { error } = await db.from("mandates").insert({
      merchant_id: merchantId,
      agent_id: agentId,
      customer_id: customer.id,
      type: "upi_autopay",
      status: "active",
      razorpay_ref: `sim_mandate_${Math.random().toString(36).slice(2, 12)}`,
      raw_payload: { simulated: true, note: "Standing authorization for the simulated agent." },
    });
    if (error) throw error;
    created++;
  }
  return created;
}

/** How often an allowed ordinary purchase is followed by the agent proposing
 *  a complement. Not every purchase: an agent that upsells on all of them
 *  reads as a script rather than a judgement, and the LLM call costs a second
 *  or two on the tick it happens to land on. */
const UPSELL_CHANCE = 0.3;

export interface SimulationEvent {
  scenario: Scenario;
  label: string;
  decision: "allow" | "escalate" | "block" | "protocol_reject";
  reasoning: string;
  amountPaise: number;
  /** An action the agent proposed off the back of another, rather than one the
   *  customer came for. Revenue that exists because the agent suggested it. */
  isUpsell?: boolean;
  /** The agent's own pitch, shown so the upsell reads as reasoning rather than
   *  a second random order. */
  pitch?: string;
}

export interface SimulationSummary {
  events: SimulationEvent[];
  allowed: number;
  escalated: number;
  blocked: number;
  rejected: number;
  totalAmountPaise: number;
}

interface ActionResult {
  decision: "allow" | "block" | "escalate";
  reasoning: string;
  /** Needed so an upsell can be recorded as a child of the purchase that
   *  prompted it — see UPSELL_CHANCE below. */
  traceId: string;
}


/**
 * Asks the policy engine what this customer can actually be sold right now.
 *
 * This is the control plane working as a *sales* input rather than only a
 * gate. An agent that proposes blind wastes its best pitch on something that
 * bounces; an agent that can ask first always offers the most valuable thing
 * that will clear. Same rules, opposite use.
 *
 * Probing is free: velocity aggregates count only `mode=enforce` traces
 * (getAggregates in traceHelpers.ts), so simulating a dozen candidates costs
 * the agent nothing against its own rate limit. If that ever changed, this
 * would quietly start rate-limiting the agent for thinking.
 *
 * Descending by price on purpose — the question is not "what fits" but "what
 * is the most valuable thing that fits".
 */
async function bestClearingItem(
  client: MandateClient,
  candidates: CatalogItem[],
  customerId: string
): Promise<CatalogItem | null> {
  for (const item of [...candidates].sort((a, b) => b.priceInPaise - a.priceInPaise)) {
    const probe = await client.callTool<ActionResult>("simulate_action", {
      actionType: "order.create",
      amount: item.priceInPaise,
      currency: "INR",
      category: item.category,
      customerId,
      params: { receipt: `probe-${Date.now()}-${item.sku}` },
    });
    if (probe.decision === "allow") return item;
  }
  return null;
}

/** Runs `count` simulated actions. The caller controls pacing — see
 *  SimulationPanel.tsx, where the merchant picks the interval. */
export async function runSimulation(merchant: { id: string; slug: string }, count: number = 1): Promise<SimulationSummary> {
  const db = createAdminClient();
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

  const { id: agentId, secretKeyBase64 } = await ensureAgentIdentity(db, merchant.id, SIM_AGENT);
  const [catalog, customers] = await Promise.all([fetchCatalog(db, merchant.id), ensureSyntheticCustomers(db, merchant.id)]);

  const client = new MandateClient(baseUrl, merchant.slug, agentId, secretKeyBase64);
  await client.initialize("mandate-simulation");

  const events: SimulationEvent[] = [];
  let allowed = 0;
  let escalated = 0;
  let blocked = 0;
  let rejected = 0;
  let totalAmountPaise = 0;

  for (let i = 0; i < count; i++) {
    const scenario = pickScenario();
    const customer = customers[Math.floor(Math.random() * customers.length)];

    // A forged request never reaches the policy engine at all — it's rejected
    // at the protocol layer on a signature that doesn't verify. Handled
    // separately because there is no tool call to make: the point is that the
    // request dies before becoming one.
    if (scenario === "forged") {
      const tampered = await client.sendTamperedRequest();
      events.push({
        scenario,
        label: "Forged request from an unrecognised caller",
        decision: "protocol_reject",
        reasoning: `HTTP ${tampered.status} — signature failed to verify, rejected before the policy engine.`,
        amountPaise: 0,
      });
      rejected++;
      continue;
    }

    let amount: number;
    let category: string;
    let label: string;
    let boughtItem: CatalogItem | null = null;

    if (scenario === "high_value") {
      // Above the step-up threshold, so a human is asked. Randomised rather
      // than fixed so the escalation queue doesn't fill with identical rows.
      amount = 500000 + Math.floor(Math.random() * 1300000);
      category = "office";
      label = "High-value purchase";
    } else if (scenario === "banned_category") {
      amount = 50000 + Math.floor(Math.random() * 200000);
      category = BANNED_CATEGORIES[Math.floor(Math.random() * BANNED_CATEGORIES.length)];
      label = `Purchase in a banned category (${category})`;
    } else {
      const item = weightedItem(catalog);
      boughtItem = item;
      amount = item.priceInPaise;
      category = item.category;
      label = `Purchase: ${item.name}`;
    }

    const args = {
      actionType: "order.create",
      amount,
      currency: "INR",
      category,
      customerId: customer.id,
      params: {
        receipt: `sim-${Date.now()}-${i}`,
        // The SKU is written onto the trace rather than inferred later from
        // the amount. Two products can share a price, and the scenarios that
        // pick a random amount can land on one by coincidence — reading the
        // product back out of the number would put a name on an order that
        // never had one. Only catalog-backed orders carry it; the rest carry
        // no product at all, and the order history says so.
        notes: { scenario, source: "simulation", ...(boughtItem ? { sku: boughtItem.sku, item: boughtItem.name } : {}) },
      },
    };

    const enforced = await client.callTool<ActionResult>("enforce_action", args);
    totalAmountPaise += amount;
    if (enforced.decision === "allow") allowed++;
    else if (enforced.decision === "escalate") escalated++;
    else blocked++;

    events.push({ scenario, label, decision: enforced.decision, reasoning: enforced.reasoning, amountPaise: amount });

    // The growth half of the loop: having sold something, the agent reasons
    // over the real catalog for a genuine complement and tries to sell that
    // too. Recorded with `forkFrom` so it is a child of the purchase that
    // prompted it — which is what makes it attributable revenue rather than
    // just another order, and what draws the edge in the entity graph.
    //
    // It goes through `enforce_action` like anything else, so an upsell that
    // breaches a cap is refused exactly as a customer-initiated purchase would
    // be. The agent proposing something does not privilege it.
    if (boughtItem && enforced.decision === "allow" && Math.random() < UPSELL_CHANCE) {
      // Taste first: the LLM picks a genuine complement over the real catalog.
      // A failed suggestion returns null and never touches the purchase it
      // followed.
      const suggestion = await suggestCrossSell(catalog, boughtItem.sku);
      if (suggestion) {
        // Then constraint. Asking the engine BEFORE proposing is the whole
        // point: without it the agent pitches its favourite complement and
        // eats a refusal, losing a sale the merchant would have accepted at a
        // different size.
        const wanted = suggestion.item;
        const probe = await client.callTool<ActionResult>("simulate_action", {
          actionType: "order.create",
          amount: wanted.priceInPaise,
          currency: "INR",
          category: wanted.category,
          customerId: customer.id,
          params: { receipt: `probe-${Date.now()}-${wanted.sku}` },
        });

        let offer: CatalogItem | null = wanted;
        let substituted = false;
        if (probe.decision !== "allow") {
          // What it wanted to sell won't clear. Rather than abandoning the
          // upsell, fall back to the most valuable thing that will.
          offer = await bestClearingItem(
            client,
            catalog.filter((c) => c.sku !== boughtItem.sku && c.sku !== wanted.sku),
            customer.id
          );
          substituted = true;
        }

        if (offer) {
          const upsell = await client.callTool<ActionResult>("enforce_action", {
            actionType: "order.create",
            amount: offer.priceInPaise,
            currency: "INR",
            category: offer.category,
            customerId: customer.id,
            forkFrom: enforced.traceId,
            params: {
              receipt: `sim-upsell-${Date.now()}-${i}`,
              notes: {
                scenario: "upsell",
                source: "simulation",
                upsell_of: boughtItem.sku,
                sku: offer.sku,
                item: offer.name,
              },
            },
          });
          totalAmountPaise += offer.priceInPaise;
          if (upsell.decision === "allow") allowed++;
          else if (upsell.decision === "escalate") escalated++;
          else blocked++;

          events.push({
            scenario: "ordinary",
            label: `Agent upsells: ${offer.name}`,
            decision: upsell.decision,
            reasoning: substituted
              ? `Wanted to offer ${wanted.name} (${moneyLabel(wanted.priceInPaise)}) but policy wouldn't clear it, so it offered the most valuable alternative that would. ${upsell.reasoning}`
              : upsell.reasoning,
            amountPaise: offer.priceInPaise,
            isUpsell: true,
            pitch: substituted ? undefined : suggestion.pitch,
          });
        }
      }
    }
  }

  return { events, allowed, escalated, blocked, rejected, totalAmountPaise };
}
