import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { generateKeyPair } from "../webBotAuth/keys";

// Relative imports and a locally-built admin client, not `@/lib/supabase/admin`
// — this module is loaded both by Next's bundler (dashboard server actions)
// and directly by tsx (CLI scripts), and the guarded admin client's `import
// "server-only"` throws immediately outside Next's server context.
//
// Shared between src/lib/demo/runDemo.ts (the scripted narrative demo) and
// src/lib/demo/backgroundTraffic.ts (volume generation) — both need the
// exact same "reuse a configured agent identity, else register a fresh one"
// logic, and having it in two places risked them drifting apart.

export function createAdminClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set.");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

export function moneyLabel(paise: number): string {
  return `₹${(paise / 100).toLocaleString("en-IN")}`;
}

export interface AgentIdentity {
  id: string;
  secretKeyBase64: string;
  reused: boolean;
}

/**
 * Reuses the agent identity named by `envIdVar`/`envSecretVar` if it's
 * configured (e.g. via `npm run gen-agent-key`) and still exists — so that
 * identity's trust score keeps accumulating across repeated clicks instead
 * of resetting every time. Otherwise registers a fresh, uniquely-named
 * agent on the spot and uses its secret immediately, in-memory, for this
 * call only — an already-seeded agent's secret is never stored anywhere to
 * "reuse," so without the env vars set, every call gets its own new agent.
 */
export async function ensureAgentIdentity(
  db: SupabaseClient,
  opts: { envIdVar: string; envSecretVar: string; name: string; description: string }
): Promise<AgentIdentity> {
  const envId = process.env[opts.envIdVar];
  const envSecret = process.env[opts.envSecretVar];
  if (envId && envSecret) {
    const { data } = await db.from("agents").select("id").eq("id", envId).maybeSingle();
    if (data) return { id: envId, secretKeyBase64: envSecret, reused: true };
  }

  const { secretKey, publicKey } = generateKeyPair();
  const name = `${opts.name} (${new Date().toISOString().slice(11, 19)})`;
  const { data, error } = await db
    .from("agents")
    .insert({ name, description: opts.description, public_key: publicKey })
    .select()
    .single();
  if (error) throw error;

  return { id: data.id, secretKeyBase64: secretKey, reused: false };
}
