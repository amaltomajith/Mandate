import type { SupabaseClient } from "@supabase/supabase-js";
import { generateKeyPair } from "@/lib/webBotAuth/keys";
import { decryptSecret, encryptSecret } from "@/lib/secrets";
import type { Agent, AgentKind } from "@/types/db";

/**
 * The merchant's own Selling and Buying agents.
 *
 * They are ordinary rows in `agents`, and they act the same way an outside
 * agent would: by signing a request to the Payment Wall. The only difference is
 * that Mandate holds their signing key, encrypted with MANDATE_SECRET_KEY, so
 * the worker can sign for them. The key never reaches a browser and the agent's
 * language model never sees it; the worker signs, the model only asks.
 */

type InhouseKind = Exclude<AgentKind, "external">;

const DEFINITIONS: Record<InhouseKind, { name: string; description: string }> = {
  selling: {
    name: "Selling agent",
    description: "Clears slow-moving stock: proposes price drops within the margin floor and sells through payment links.",
  },
  buying: {
    name: "Buying agent",
    description: "Restocks bestsellers: collects supplier quotes, drafts purchase orders and requests payouts.",
  },
};

export async function ensureInhouseAgents(db: SupabaseClient, merchantId: string): Promise<Record<InhouseKind, Agent>> {
  const out = {} as Record<InhouseKind, Agent>;
  for (const kind of ["selling", "buying"] as const) {
    const { data: existing, error } = await db
      .from("agents")
      .select("*")
      .eq("merchant_id", merchantId)
      .eq("kind", kind)
      .eq("retired", false)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (existing) {
      out[kind] = existing as Agent;
      continue;
    }
    const keys = generateKeyPair();
    const { data: created, error: insertError } = await db
      .from("agents")
      .insert({
        merchant_id: merchantId,
        kind,
        name: DEFINITIONS[kind].name,
        description: DEFINITIONS[kind].description,
        public_key: keys.publicKey,
        secret_key_enc: encryptSecret(keys.secretKey),
        managed: true,
      })
      .select("*")
      .single();
    if (insertError) throw new Error(insertError.message);
    out[kind] = created as Agent;
  }
  return out;
}

export interface AgentIdentity {
  agentId: string;
  secretKey: string;
  status: Agent["status"];
}

/** For the worker only. Throws if the agent is retired or has no stored key. */
export async function loadAgentIdentity(db: SupabaseClient, merchantId: string, kind: InhouseKind): Promise<AgentIdentity> {
  const { data, error } = await db
    .from("agents")
    .select("id, status, secret_key_enc")
    .eq("merchant_id", merchantId)
    .eq("kind", kind)
    .eq("retired", false)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.secret_key_enc) throw new Error(`No ${kind} agent with a stored key for this merchant.`);
  return { agentId: data.id, secretKey: decryptSecret(data.secret_key_enc), status: data.status };
}
