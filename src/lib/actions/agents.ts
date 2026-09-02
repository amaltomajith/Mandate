"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireDashboardUser } from "./authGuard";
import { getCurrentMerchant } from "@/lib/merchant";
import { buildAgentSpec, type AgentSpec } from "@/lib/agentSpec";
import type { Agent } from "@/types/db";

/**
 * The merchant's side of managing agents.
 *
 * Every mutation here matches on merchant as well as id. A row id is not
 * authorization — the handover records treating one as such as a real bug, and
 * the cost of the extra predicate is nothing, so the worst case for a forged id
 * is an update that matches no rows.
 *
 * No function here accepts a merchant id from the caller. The tenant always
 * comes from the Clerk session, because a merchant id in a client payload is a
 * merchant id a client can change.
 */

/** Kept in step with migration 0012's check constraint. Rejected here too, so a
 *  bad value produces a sentence rather than a database error. */
const MAX_PACE_MS = 3_600_000;

async function merchantScope() {
  await requireDashboardUser();
  return { merchant: await getCurrentMerchant(), db: createAdminClient() };
}

/**
 * Pause or resume an agent — COOPERATIVELY.
 *
 * This does not refuse the agent's requests. It changes what
 * `/api/m/<slug>/agent-control` tells it, and a well-behaved agent stops
 * calling. That is the entire mechanism, and it is deliberately not
 * enforcement: to actually prevent an agent acting, pause or revoke its
 * mandate, which runs inside the request path where compliance is not required.
 */
export async function setAgentStatus(agentId: string, status: "active" | "paused") {
  const { merchant, db } = await merchantScope();
  const { error } = await db
    .from("agents")
    .update({ status })
    .eq("id", agentId)
    .eq("merchant_id", merchant.id);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

/** How long the merchant would like between this agent's actions. A request,
 *  honoured by agents that poll; velocity rules remain the enforced limit. */
export async function setAgentPace(agentId: string, paceMs: number) {
  const { merchant, db } = await merchantScope();
  if (!Number.isFinite(paceMs) || paceMs < 0 || paceMs > MAX_PACE_MS) {
    throw new Error(`Pace has to be between 0 and ${MAX_PACE_MS / 1000} seconds.`);
  }
  const { error } = await db
    .from("agents")
    .update({ pace_ms: Math.round(paceMs) })
    .eq("id", agentId)
    .eq("merchant_id", merchant.id);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

export interface RegisterAgentInput {
  name: string;
  description?: string;
  persona?: string;
  publicKey: string;
  endpointUrl?: string;
}

/**
 * Registers a third-party agent.
 *
 * The merchant supplies a name and the agent's PUBLIC key; the agent keeps the
 * private half and this system never sees it. There is no self-service path on
 * purpose — an agent that could register itself could grant itself an identity,
 * and the whole trust model rests on the merchant deciding who may act.
 *
 * The returned id is what the agent signs with. `keyid` IS the agent id: there
 * is no separate credential to hand back, and an earlier version of this flow
 * dropped that id on the floor, producing credentials that could never work.
 */
export async function registerAgent(input: RegisterAgentInput): Promise<Agent> {
  const { merchant, db } = await merchantScope();

  const name = input.name.trim();
  const publicKey = input.publicKey.trim();
  if (name.length < 2) throw new Error("Give the agent a name you'll recognise.");

  // Shape-checked before it reaches the database. A key that is not 32 bytes of
  // base64 can never verify a signature, so accepting it would create an agent
  // that is guaranteed to fail at its first request with a confusing error.
  let decoded: Buffer;
  try {
    decoded = Buffer.from(publicKey, "base64");
  } catch {
    throw new Error("That public key isn't valid base64.");
  }
  if (decoded.length !== 32) {
    throw new Error(
      `An Ed25519 public key is 32 bytes; that one decodes to ${decoded.length}. ` +
        "Paste the public half, not the private key or a fingerprint."
    );
  }

  const { data: clash } = await db
    .from("agents")
    .select("id")
    .eq("merchant_id", merchant.id)
    .eq("public_key", publicKey)
    .maybeSingle();
  if (clash) throw new Error("That key is already registered — it has an agent id already.");

  const { data, error } = await db
    .from("agents")
    .insert({
      merchant_id: merchant.id,
      name,
      description: input.description?.trim() || null,
      persona: input.persona?.trim() || null,
      endpoint_url: input.endpointUrl?.trim() || null,
      public_key: publicKey,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);

  revalidatePath("/dashboard");
  return data;
}

/**
 * An agent's definition, for moving it to another merchant or another machine.
 *
 * Deliberately carries NO key material, not even the public half — the point of
 * an export is the shape of the agent, and the importing side generates a fresh
 * keypair. Exporting a key would encourage carrying one between environments,
 * which is exactly the habit this identity model exists to avoid.
 */
export async function exportAgent(agentId: string): Promise<Record<string, unknown>> {
  const { merchant, db } = await merchantScope();
  const { data, error } = await db
    .from("agents")
    .select("name, description, persona, endpoint_url, pace_ms")
    .eq("id", agentId)
    .eq("merchant_id", merchant.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Agent not found.");

  return {
    mandateAgentDefinition: 1,
    name: data.name,
    description: data.description,
    persona: data.persona,
    endpointUrl: data.endpoint_url,
    paceMs: data.pace_ms,
    note:
      "No key material is included, by design. Generate a fresh keypair on the " +
      "importing side and register its public half with the new merchant.",
  };
}

/** The compatibility contract for this merchant, with real URLs. */
export async function agentSpec(): Promise<AgentSpec> {
  const { merchant } = await merchantScope();
  return buildAgentSpec(merchant, process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000");
}

export interface AgentActivity {
  agentId: string;
  lastSeen: string | null;
  /**
   * Silent for several of its own pace intervals.
   *
   * Computed here rather than in the component: `Date.now()` during render is
   * impure, and the server already holds both halves of the comparison. There
   * is a floor so a fast pace does not report every agent as stale in the
   * ordinary gap between two actions.
   */
  stale: boolean;
  recent: {
    traceId: string;
    at: string;
    decision: string;
    reasoning: string | null;
    amountPaise: number | null;
    /** The agent's own stated reason, when it sent one. Untrusted text,
     *  sanitised at write time. */
    agentReason: string | null;
  }[];
}

/**
 * What each agent has been doing lately.
 *
 * `lastSeen` is derived from the trace log rather than stored on the agent row.
 * A stored timestamp is a second source of truth that drifts the moment a write
 * fails after the action happened — and "last seen" drifting means an agent
 * looks alive when it is not, which is the wrong direction for a field a
 * merchant uses to decide whether something is stuck.
 */
export async function agentActivity(): Promise<AgentActivity[]> {
  const { merchant, db } = await merchantScope();

  const { data: agents } = await db.from("agents").select("id, pace_ms").eq("merchant_id", merchant.id);
  if (!agents?.length) return [];

  const { data: traces } = await db
    .from("traces")
    .select("id, agent_id, created_at, decision, reasoning, params")
    .eq("merchant_id", merchant.id)
    .eq("mode", "enforce")
    .not("agent_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(200);

  return agents.map((agent) => {
    const mine = (traces ?? []).filter((t) => t.agent_id === agent.id);
    const lastSeen = mine[0]?.created_at ?? null;
    const staleAfterMs = Math.max(5 * 60_000, (agent.pace_ms || 30_000) * 6);
    return {
      agentId: agent.id,
      lastSeen,
      stale: !!lastSeen && Date.now() - new Date(lastSeen).getTime() > staleAfterMs,
      recent: mine.slice(0, 5).map((t) => {
        const p = t.params as { amount?: number; notes?: { agent_reason?: string } } | null;
        return {
          traceId: t.id,
          at: t.created_at,
          decision: t.decision,
          reasoning: t.reasoning,
          amountPaise: typeof p?.amount === "number" ? p.amount : null,
          agentReason: p?.notes?.agent_reason ?? null,
        };
      }),
    };
  });
}
