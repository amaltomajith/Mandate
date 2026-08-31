import { fetchCatalog, type CatalogItem } from "./catalog";
import { MandateClient } from "./mandateClient";
import { createAdminClient, ensureAgentIdentity } from "./shared";
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
 *  pick that would make every third order a standing desk. */
const ITEM_WEIGHTS: Record<string, number> = {
  "mouse-01": 5,
  "keyboard-01": 3,
  "stand-01": 3,
  "desk-01": 1,
  "mat-01": 4,
};

function weightedItem(catalog: CatalogItem[]): CatalogItem {
  const weighted = catalog.flatMap((item) => Array(ITEM_WEIGHTS[item.sku] ?? 2).fill(item) as CatalogItem[]);
  return weighted[Math.floor(Math.random() * weighted.length)];
}

async function ensureSyntheticCustomers(db: SupabaseClient): Promise<{ id: string; name: string }[]> {
  const result: { id: string; name: string }[] = [];
  for (const customer of SYNTHETIC_CUSTOMERS) {
    const { data: existing } = await db.from("customers").select("id, name").eq("name", customer.name).maybeSingle();
    if (existing) {
      result.push(existing);
      continue;
    }
    const { data, error } = await db.from("customers").insert(customer).select("id, name").single();
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

export async function ensureSomeActiveMandates(): Promise<number> {
  const db = createAdminClient();
  const { id: agentId } = await ensureAgentIdentity(db, SIM_AGENT);
  const customers = await ensureSyntheticCustomers(db);

  const { data: existing } = await db.from("mandates").select("customer_id").eq("status", "active");
  const alreadyHeld = new Set((existing ?? []).map((m) => m.customer_id));
  if (alreadyHeld.size >= TARGET_ACTIVE_MANDATES) return 0;

  const candidates = customers.filter((c) => !alreadyHeld.has(c.id)).sort(() => Math.random() - 0.5);
  const needed = TARGET_ACTIVE_MANDATES - alreadyHeld.size;
  let created = 0;

  for (const customer of candidates.slice(0, needed)) {
    const { error } = await db.from("mandates").insert({
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

export interface SimulationEvent {
  scenario: Scenario;
  label: string;
  decision: "allow" | "escalate" | "block" | "protocol_reject";
  reasoning: string;
  amountPaise: number;
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
}

/** Runs `count` simulated actions. The caller controls pacing — see
 *  SimulationPanel.tsx, where the merchant picks the interval. */
export async function runSimulation(count: number = 1): Promise<SimulationSummary> {
  const db = createAdminClient();
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

  const { id: agentId, secretKeyBase64 } = await ensureAgentIdentity(db, SIM_AGENT);
  const [catalog, customers] = await Promise.all([fetchCatalog(db), ensureSyntheticCustomers(db)]);

  const client = new MandateClient(baseUrl, agentId, secretKeyBase64);
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
      params: { receipt: `sim-${Date.now()}-${i}`, notes: { scenario, source: "simulation" } },
    };

    const enforced = await client.callTool<ActionResult>("enforce_action", args);
    totalAmountPaise += amount;
    if (enforced.decision === "allow") allowed++;
    else if (enforced.decision === "escalate") escalated++;
    else blocked++;

    events.push({ scenario, label, decision: enforced.decision, reasoning: enforced.reasoning, amountPaise: amount });
  }

  return { events, allowed, escalated, blocked, rejected, totalAmountPaise };
}
