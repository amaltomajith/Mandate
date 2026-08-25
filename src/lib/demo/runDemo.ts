import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateKeyPair } from "@/lib/webBotAuth/keys";
import type { Json } from "@/types/db";
import { MandateClient } from "./mandateClient";
import { SEED_CUSTOMER, SEED_RULES } from "./seedData";

export interface DemoStep {
  label: string;
  status: "ok" | "escalated" | "blocked" | "rejected" | "error";
  detail: string;
}

interface ActionResult {
  decision: "allow" | "block" | "escalate";
  reasoning: string;
  traceId: string;
}

/** Same idempotent upsert scripts/seed.ts does, so clicking the button when
 *  the CLI has already been run is a safe no-op, not a duplicate. */
async function ensureSeedData(db: ReturnType<typeof createAdminClient>): Promise<DemoStep> {
  let created = 0;
  for (const rule of SEED_RULES) {
    const { data: existing } = await db.from("policy_rules").select("id").eq("name", rule.name).maybeSingle();
    if (existing) continue;
    const { error } = await db
      .from("policy_rules")
      .insert({ type: rule.type, name: rule.name, params: rule.params as unknown as Json, status: "active", source: "human", rationale: rule.rationale });
    if (error) throw error;
    created++;
  }

  const { data: existingCustomer } = await db.from("customers").select("id").eq("name", SEED_CUSTOMER.name).maybeSingle();
  if (!existingCustomer) {
    const { error } = await db.from("customers").insert(SEED_CUSTOMER);
    if (error) throw error;
  }

  return {
    label: "Set up policy rules",
    status: "ok",
    detail: created > 0 ? `Created ${created} new rule(s).` : "Rules already existed — nothing to do.",
  };
}

/**
 * Reuses CHECKOUT_AGENT_ID/SECRET_KEY if they're already configured (e.g. from
 * `npm run gen-agent-key`). Otherwise registers a fresh, uniquely-named agent
 * on the spot and uses its secret immediately, in-memory, for this run only —
 * gen-agent-key's secret is deliberately never stored anywhere, so there's
 * nothing to "reuse" for a same-named agent that already exists; making a new
 * one avoids a unique-name collision instead of erroring.
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

export async function runDemoScript(): Promise<DemoStep[]> {
  const db = createAdminClient();
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const steps: DemoStep[] = [];

  steps.push(await ensureSeedData(db));
  const { id: agentId, secretKeyBase64, step: agentStep } = await ensureDemoAgent(db);
  steps.push(agentStep);

  const client = new MandateClient(baseUrl, agentId, secretKeyBase64);
  await client.initialize("mandate-dashboard-demo");

  async function purchase(label: string, amountPaise: number): Promise<void> {
    const args = {
      actionType: "order.create",
      amount: amountPaise,
      currency: "INR",
      category: "restock",
      params: { receipt: `mandate-demo-${Date.now()}`, notes: { label } },
    };
    await client.callTool<ActionResult>("simulate_action", args);
    const enforced = await client.callTool<ActionResult>("enforce_action", args);

    const amountLabel = `₹${(amountPaise / 100).toLocaleString("en-IN")}`;
    if (enforced.decision === "allow") {
      steps.push({ label: `${label} (${amountLabel})`, status: "ok", detail: enforced.reasoning });
    } else if (enforced.decision === "escalate") {
      steps.push({ label: `${label} (${amountLabel})`, status: "escalated", detail: enforced.reasoning });
    } else {
      steps.push({ label: `${label} (${amountLabel})`, status: "blocked", detail: enforced.reasoning });
    }
  }

  await purchase("Restock order #1", 100000);
  await purchase("Restock order #2", 150000);
  await purchase("Restock order #3", 200000);
  await purchase("Large restock order", 600000);

  const tampered = await client.sendTamperedRequest();
  steps.push({
    label: "Tampered request (live self-defense)",
    status: "rejected",
    detail: `HTTP ${tampered.status} — rejected at the protocol layer before it ever reached the policy engine.`,
  });

  return steps;
}
