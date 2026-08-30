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
 * configured (register one from the dashboard's Agent trust panel, which now
 * hands back the id and secret together) and still exists — so that identity's
 * trust score keeps accumulating instead of resetting.
 *
 * Without those env vars there is nothing to reuse: Mandate never stores an
 * agent's secret key, so a previously-registered identity cannot be signed as
 * again. A fresh one is registered instead — but memoised per process, which
 * matters more than it looks. Continuous background traffic calls this once
 * per transaction; without the cache that is a brand-new agent row for every
 * single order, burying the real agents in the roster and resetting the trust
 * score to 50 forever. Cached, an unpinned bot gets one identity per server
 * run; pinned via env, one identity permanently.
 */
const identityCache = new Map<string, Promise<AgentIdentity>>();

export async function ensureAgentIdentity(
  db: SupabaseClient,
  opts: { envIdVar: string; envSecretVar: string; name: string; description: string }
): Promise<AgentIdentity> {
  const cached = identityCache.get(opts.envIdVar);
  if (cached) return cached;

  // Cache the in-flight promise, not just the result, so concurrent callers
  // can't race each other into registering two agents.
  const pending = resolveAgentIdentity(db, opts);
  identityCache.set(opts.envIdVar, pending);
  // A failed lookup must not poison the cache for the rest of the process.
  pending.catch(() => identityCache.delete(opts.envIdVar));
  return pending;
}

async function resolveAgentIdentity(
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
  // Only disambiguate when the plain name is already taken. The timestamp
  // suffix used to be unconditional, which leaked demo scaffolding into what
  // is meant to read as a merchant's real agent roster — "Background Traffic
  // Bot (06:59:50)" is not a name anyone would give an agent.
  const { data: clash } = await db.from("agents").select("id").eq("name", opts.name).maybeSingle();
  const name = clash ? `${opts.name} (${new Date().toISOString().slice(11, 19)})` : opts.name;
  const { data, error } = await db
    .from("agents")
    .insert({ name, description: opts.description, public_key: publicKey })
    .select()
    .single();
  if (error) throw error;

  return { id: data.id, secretKeyBase64: secretKey, reused: false };
}
