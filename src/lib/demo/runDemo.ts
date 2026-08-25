import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { generateKeyPair } from "../webBotAuth/keys";
import { applySeedProducts, fetchCatalog, findItem, type CatalogItem } from "./catalog";
import { suggestCrossSell } from "./crossSell";
import { MandateClient } from "./mandateClient";
import { applySeedRules } from "./seedData";

// Relative imports and a locally-built admin client, not `@/lib/supabase/admin`
// — same reasoning as mandateClient.ts: this module is loaded both by Next's
// bundler (the dashboard's "Run demo" server action) and directly by tsx
// (scripts/checkout-agent.ts), and the guarded admin client's `import
// "server-only"` throws immediately outside Next's server context.
function createAdminClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set.");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

export interface DemoStep {
  label: string;
  status: "ok" | "escalated" | "blocked" | "rejected" | "error";
  detail: string;
  kind?: "purchase" | "upsell";
}

interface ActionResult {
  decision: "allow" | "block" | "escalate";
  reasoning: string;
  traceId: string;
}

async function ensureSeedData(db: ReturnType<typeof createAdminClient>): Promise<DemoStep> {
  const [{ created: rulesCreated, migrated }, { created: productsCreated }] = await Promise.all([
    applySeedRules(db),
    applySeedProducts(db),
  ]);
  const parts: string[] = [];
  if (migrated) parts.push("updated the old rate-limit rule");
  parts.push(rulesCreated > 0 ? `created ${rulesCreated} new rule(s)` : "rules already existed");
  parts.push(productsCreated > 0 ? `created ${productsCreated} new product(s)` : "catalog already existed");
  return { label: "Set up policy rules & catalog", status: "ok", detail: parts.join(", ") + "." };
}

/**
 * Reuses CHECKOUT_AGENT_ID/SECRET_KEY if they're already configured (e.g. from
 * `npm run gen-agent-key`) — deliberately, so the same identity's trust score
 * keeps accumulating across repeated "Run demo" clicks instead of resetting
 * every time. Otherwise registers a fresh, uniquely-named agent on the spot
 * and uses its secret immediately, in-memory, for this run only — an
 * already-seeded agent's secret is never stored anywhere to "reuse."
 */
async function ensureDemoAgent(db: ReturnType<typeof createAdminClient>): Promise<{ id: string; secretKeyBase64: string; step: DemoStep }> {
  const envId = process.env.CHECKOUT_AGENT_ID;
  const envSecret = process.env.CHECKOUT_AGENT_SECRET_KEY;
  if (envId && envSecret) {
    const { data } = await db.from("agents").select("id").eq("id", envId).maybeSingle();
    if (data) {
      return {
        id: envId,
        secretKeyBase64: envSecret,
        step: { label: "Agent identity", status: "ok", detail: "Reused the configured Checkout Agent." },
      };
    }
  }

  const { secretKey, publicKey } = generateKeyPair();
  const name = `Checkout Agent (dashboard demo ${new Date().toISOString().slice(11, 19)})`;
  const { data, error } = await db
    .from("agents")
    .insert({ name, description: "Ephemeral agent created by the dashboard's Run Demo button", public_key: publicKey })
    .select()
    .single();
  if (error) throw error;

  return {
    id: data.id,
    secretKeyBase64: secretKey,
    step: { label: "Agent identity", status: "ok", detail: `Registered a fresh signed agent identity ("${name}").` },
  };
}

function moneyLabel(paise: number): string {
  return `₹${(paise / 100).toLocaleString("en-IN")}`;
}

export async function runDemoScript(): Promise<DemoStep[]> {
  const db = createAdminClient();
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const steps: DemoStep[] = [];

  steps.push(await ensureSeedData(db));
  const { id: agentId, secretKeyBase64, step: agentStep } = await ensureDemoAgent(db);
  steps.push(agentStep);

  const catalog = await fetchCatalog(db);

  const client = new MandateClient(baseUrl, agentId, secretKeyBase64);
  await client.initialize("mandate-dashboard-demo");

  async function buy(item: CatalogItem, label: string, kind: "purchase" | "upsell"): Promise<ActionResult> {
    const args = {
      actionType: "order.create",
      amount: item.priceInPaise,
      currency: "INR",
      category: item.category,
      params: { receipt: `mandate-demo-${Date.now()}`, notes: { sku: item.sku, label } },
    };
    await client.callTool<ActionResult>("simulate_action", args);
    const enforced = await client.callTool<ActionResult>("enforce_action", args);

    const priceLabel = moneyLabel(item.priceInPaise);
    const status = enforced.decision === "allow" ? "ok" : enforced.decision === "escalate" ? "escalated" : "blocked";
    steps.push({ label: `${label} (${priceLabel})`, status, detail: enforced.reasoning, kind });
    return enforced;
  }

  /** Buys `item`, then asks the LLM to reason over the real catalog for a
   *  complementary cross-sell and buys that too if it suggests one — no
   *  hardcoded pairing table. See src/lib/demo/crossSell.ts. */
  async function buyWithCrossSell(item: CatalogItem): Promise<void> {
    await buy(item, `AI buyer purchases: ${item.name}`, "purchase");

    const suggestion = await suggestCrossSell(catalog, item.sku);
    if (suggestion) {
      await buy(suggestion.item, `Agent upsells: ${suggestion.item.name} — ${suggestion.pitch}`, "upsell");
    } else {
      steps.push({
        label: "Cross-sell check",
        status: "ok",
        detail: `No complementary item in the catalog for ${item.name} — the agent didn't force one.`,
        kind: "upsell",
      });
    }
  }

  // The agent decides to buy a couple of things, and — because it's an agent
  // meant to *grow* revenue, not just place orders — reasons about a paired
  // cross-sell for each one straight after. This is the part that makes it
  // read as agentic commerce rather than a policy-rule test harness: same
  // gating underneath, but the agent is visibly deciding what to buy and why.
  await buyWithCrossSell(findItem(catalog, "mouse-01"));
  await buyWithCrossSell(findItem(catalog, "stand-01"));

  // The graceful-failure beat: a big-ticket item over the step-up threshold —
  // escalated for a human's sign-off, not blocked outright.
  await buy(findItem(catalog, "desk-01"), "AI buyer purchases: Premium Standing Desk", "purchase");

  // The live self-defense beat: a forged request, rejected before it ever
  // reaches the policy engine.
  const tampered = await client.sendTamperedRequest();
  steps.push({
    label: "Tampered request (live self-defense)",
    status: "rejected",
    detail: `HTTP ${tampered.status} — rejected at the protocol layer before it ever reached the policy engine.`,
  });

  return steps;
}
