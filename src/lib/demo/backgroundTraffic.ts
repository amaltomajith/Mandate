import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchCatalog, type CatalogItem } from "./catalog";
import { MandateClient } from "./mandateClient";
import { createAdminClient, ensureAgentIdentity } from "./shared";

/**
 * "History only exists right after I click Run demo" was the real gap this
 * closes — a merchant (or a judge) clicking around the dashboard between
 * demo runs saw the same static handful of transactions. This fires a burst
 * of real, signed MCP calls of varied size against the real catalog,
 * attributed to a small pool of synthetic customers, so the Transactions
 * view, Agent trust, and policy audit all have something to look like a
 * living system with, not just a scripted narrative.
 *
 * Deliberately NOT "PaySim-calibrated" despite that phrase in the original
 * plan — PaySim is Track 02's fraud-detection dataset (removed entirely,
 * see HANDOVER.md §10) and has nothing to do with Mandate's own traffic.
 * The weighting below is grounded in this project's own real catalog
 * instead: cheaper items picked more often, expensive ones rarer, the
 * ordinary shape of e-commerce order sizes — not an invented statistical
 * model, and not secretly tied to a dataset this project deliberately
 * doesn't use for this.
 */

// Kept at or under the purchases domain's velocity limit (6 actions / 2 min
// per agent — see SEED_RULES). Velocity is scoped per_agent and this bot has
// its own identity, so it never competes with the demo agent's budget; but a
// burst larger than the limit would rate-limit itself halfway through and fill
// the dashboard with meaningless velocity blocks rather than ordinary traffic.
const BURST_SIZE = 6;

const SYNTHETIC_CUSTOMERS = [
  { name: "Priya Sharma", email: "priya.sharma@example.com" },
  { name: "Arjun Mehta", email: "arjun.mehta@example.com" },
  { name: "Fatima Khan", email: "fatima.khan@example.com" },
  { name: "Rohan Iyer", email: "rohan.iyer@example.com" },
  { name: "Ananya Gupta", email: "ananya.gupta@example.com" },
];

/** Higher = picked more often. Deliberately skewed toward the cheaper end
 *  of the real catalog — most background traffic should read as routine,
 *  with the occasional big-ticket item standing out precisely because it's
 *  rare (and, at ₹6,999, big enough to trip the real step-up rule). */
const ITEM_WEIGHTS: Record<string, number> = {
  "mouse-01": 6,
  "hub-01": 5,
  "yogamat-01": 5,
  "stand-01": 3,
  "keyboard-01": 2,
  "desk-01": 1,
};

interface ActionResult {
  decision: "allow" | "block" | "escalate";
  reasoning: string;
  traceId: string;
}

export interface BackgroundTrafficSummary {
  generated: number;
  allowed: number;
  escalated: number;
  blocked: number;
  totalAmountPaise: number;
}

function weightedPick(catalog: CatalogItem[]): CatalogItem {
  const weighted = catalog.map((item) => ({ item, weight: ITEM_WEIGHTS[item.sku] ?? 1 }));
  const total = weighted.reduce((sum, w) => sum + w.weight, 0);
  let roll = Math.random() * total;
  for (const w of weighted) {
    if (roll < w.weight) return w.item;
    roll -= w.weight;
  }
  return weighted[weighted.length - 1].item;
}

/** Idempotent by name, same pattern as seedData.ts's SEED_CUSTOMER — created
 *  once, reused on every later burst so the pool (and any future mandate
 *  linked to one of them) stays stable across clicks. */
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

/** `count` defaults to a full burst. Continuous mode passes 1, so the caller
 *  controls pacing between single transactions rather than this function
 *  firing a clump — see LIVE_INTERVAL_MS in BackgroundTrafficButton.tsx for
 *  why that pacing has to stay under the velocity rule's rate. */
export async function runBackgroundTraffic(count: number = BURST_SIZE): Promise<BackgroundTrafficSummary> {
  const db = createAdminClient();
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

  const { id: agentId, secretKeyBase64 } = await ensureAgentIdentity(db, {
    envIdVar: "BACKGROUND_AGENT_ID",
    envSecretVar: "BACKGROUND_AGENT_SECRET_KEY",
    name: "Background Traffic Bot",
    description: "Generates ordinary background transaction volume — not part of the scripted demo narrative.",
  });

  const [catalog, customers] = await Promise.all([fetchCatalog(db), ensureSyntheticCustomers(db)]);

  const client = new MandateClient(baseUrl, agentId, secretKeyBase64);
  await client.initialize("mandate-background-traffic");

  let allowed = 0;
  let escalated = 0;
  let blocked = 0;
  let totalAmountPaise = 0;

  for (let i = 0; i < count; i++) {
    const item = weightedPick(catalog);
    const customer = customers[Math.floor(Math.random() * customers.length)];
    const args = {
      actionType: "order.create",
      amount: item.priceInPaise,
      currency: "INR",
      category: item.category,
      customerId: customer.id,
      params: { receipt: `mandate-bgtraffic-${Date.now()}-${i}`, notes: { sku: item.sku, source: "background-traffic" } },
    };

    await client.callTool<ActionResult>("simulate_action", args);
    const enforced = await client.callTool<ActionResult>("enforce_action", args);

    totalAmountPaise += item.priceInPaise;
    if (enforced.decision === "allow") allowed++;
    else if (enforced.decision === "escalate") escalated++;
    else blocked++;
  }

  return { generated: count, allowed, escalated, blocked, totalAmountPaise };
}
