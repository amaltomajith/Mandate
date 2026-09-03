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
 * The ONE identity the built-in traffic simulation signs as, per merchant.
 *
 * Note what this is not: it is not a way to act as an arbitrary agent. It
 * resolves the merchant's own simulation identity and nothing else. A trace can
 * only ever carry an agent id because that agent's key signed the request, and
 * the only keys reachable from here are ones this process minted for
 * merchant-owned scaffolding.
 *
 * Resolution order, and why:
 *
 *   1. The env pin (`SIM_AGENT_ID` / `SIM_AGENT_SECRET_KEY`) when it names a row
 *      belonging to THIS merchant. Deployment-controlled, survives restarts.
 *   2. No pin, but the merchant already has a managed identity: REFUSE. We hold
 *      no key for it, and the only ways forward would be to rewrite that row's
 *      public key or to register a second identity. The second is the bug this
 *      replaced; the first is machinery that, pointed at the wrong row, locks an
 *      agent out of its own identity. Provisioning is an operator action, so it
 *      lives in scripts/mint-sim-identity.ts and the error says so.
 *   3. No pin and no managed identity: bootstrap exactly one, marked managed.
 *      The partial unique index makes a second impossible thereafter.
 *
 * Step 2 is the fix for a real bug. The env pin is a single agent id and it
 * belongs to a single merchant, so on every OTHER tenant step 1 missed and the
 * old code fell through to registering a brand new agent -- with a
 * "(HH:MM:SS)" suffix to dodge the name clash -- once per server process,
 * forever. Three "Checkout Agent" rows on one tenant, all of them the
 * simulation, splitting its history and its velocity budget three ways. The
 * suffix was the load-bearing mistake: it made the name collision survivable
 * instead of fatal, so the duplication never surfaced as an error.
 *
 * WHERE THE PRIVATE KEY LIVES, precisely -- the old note here claimed "Mandate
 * never stores an agent's secret key", which was true of the database and false
 * of the process:
 *
 *   - No private key is ever written to any table. Only `public_key` is.
 *   - The secret for the merchant's OWN managed identity is held in memory, in
 *     `identityCache`, for the life of the process -- exactly as buyer/ holds
 *     its own key in its own process. It is the merchant signing as itself.
 *   - No third-party agent's private key is ever generated, stored, cached or
 *     reachable from here. An agent registered through the dashboard supplies
 *     only its public half, and there is no code path that could produce a
 *     signature on its behalf.
 *
 * Memoised per process so continuous traffic resolves once rather than per
 * transaction.
 */
const identityCache = new Map<string, Promise<AgentIdentity>>();

export async function ensureAgentIdentity(
  db: SupabaseClient,
  merchantId: string,
  opts: { envIdVar: string; envSecretVar: string; name: string; description: string }
): Promise<AgentIdentity> {
  const cached = identityCache.get(`${merchantId}:${opts.envIdVar}`);
  if (cached) return cached;

  // Cache the in-flight promise, not just the result, so concurrent callers
  // can't race each other into registering two agents.
  // Keyed by merchant as well as env var: two merchants both running the
  // simulation must not share one cached identity, or the second would
  // transact as the first.
  const pending = resolveAgentIdentity(db, merchantId, opts);
  identityCache.set(`${merchantId}:${opts.envIdVar}`, pending);
  // A failed lookup must not poison the cache for the rest of the process.
  pending.catch(() => identityCache.delete(`${merchantId}:${opts.envIdVar}`));
  return pending;
}

async function resolveAgentIdentity(
  db: SupabaseClient,
  merchantId: string,
  opts: { envIdVar: string; envSecretVar: string; name: string; description: string }
): Promise<AgentIdentity> {
  const envId = process.env[opts.envIdVar];
  const envSecret = process.env[opts.envSecretVar];
  if (envId && envSecret) {
    const { data } = await db.from("agents").select("id").eq("id", envId).eq("merchant_id", merchantId).maybeSingle();
    if (data) return { id: envId, secretKeyBase64: envSecret, reused: true };
  }

  // Scoped to `managed` rows. An agent registered through the dashboard belongs
  // to a third party, we have never held its key, and nothing here may touch it.
  const { data: existing, error: lookupError } = await db
    .from("agents")
    .select("id, name")
    .eq("merchant_id", merchantId)
    .eq("managed", true)
    .maybeSingle();
  if (lookupError) throw new Error(lookupError.message);

  if (existing) {
    // Refusing is the whole point. Signing as this row would need its private
    // key, which was never stored; the alternatives are to overwrite its public
    // key or to register a second identity, and the second is exactly the bug
    // that produced three "Checkout Agent" rows. An operator provisions this
    // deliberately, once.
    throw new Error(
      `This merchant already has a simulation identity ("${existing.name}", ${existing.id}), but ` +
        `${opts.envIdVar} / ${opts.envSecretVar} do not name it. Mandate never stores an agent's ` +
        `private key, so it cannot sign as that identity without one, and it will not register a ` +
        `second identity to work around that -- duplicate identities split trust and velocity and ` +
        `are the bug this check exists to prevent. Provision a key with:

` +
        `  npx tsx scripts/mint-sim-identity.ts <merchant-slug>

` +
        `then set ${opts.envIdVar} and ${opts.envSecretVar} from its output.`
    );
  }

  // First run for this merchant: bootstrap exactly one, and no timestamp suffix
  // to fall back on. The partial unique index makes a second one impossible.
  const { secretKey, publicKey } = generateKeyPair();
  const { data, error } = await db
    .from("agents")
    .insert({
      merchant_id: merchantId,
      name: opts.name,
      description: opts.description,
      public_key: publicKey,
      managed: true,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);

  return { id: data.id, secretKeyBase64: secretKey, reused: false };
}
