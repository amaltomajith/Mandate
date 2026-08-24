/**
 * Registers a new agent identity: generates a real Ed25519 keypair, stores the
 * public half in `agents.public_key`, and prints the secret half once — Mandate
 * never stores it. Run once per demo agent, save the printed secret into that
 * agent's own env (e.g. CHECKOUT_AGENT_SECRET_KEY for scripts/checkout-agent.ts).
 *
 * Usage: npx tsx scripts/gen-agent-key.ts "Checkout Agent" "Demo AI buyer agent"
 */
import "./lib/loadEnv";
import { createClient } from "@supabase/supabase-js";
import { generateKeyPair } from "../src/lib/webBotAuth/keys";

// Not importing src/lib/supabase/admin.ts here on purpose — it's guarded with
// `import "server-only"`, which throws outside Next's server-component bundler
// context (i.e. under plain tsx). Same service-role client, built locally instead.
function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set.");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function main() {
  const [name, description] = process.argv.slice(2);
  if (!name) {
    console.error('Usage: npx tsx scripts/gen-agent-key.ts "<agent name>" "[description]"');
    process.exit(1);
  }

  const { secretKey, publicKey } = generateKeyPair();
  const db = createAdminClient();

  const { data, error } = await db
    .from("agents")
    .insert({ name, description: description ?? null, public_key: publicKey })
    .select()
    .single();

  if (error) {
    console.error("Failed to register agent:", error.message);
    process.exit(1);
  }

  console.log(`\nAgent registered: ${data.name} (${data.id})`);
  console.log(`Public key (stored in Supabase): ${publicKey}`);
  console.log(`\nSecret key (save this now — it is never stored, this is the only time you'll see it):`);
  console.log(secretKey);
  console.log(`\nAgent id (use as keyid when signing): ${data.id}`);
}

main();
