/**
 * Provision the simulation identity for one merchant.
 *
 * The simulation signs as the merchant's own traffic generator, which means it
 * needs a private key. Mandate never stores one, so somebody has to put it in
 * the environment — and that somebody is an operator running this, once, not
 * the server deciding for itself at boot.
 *
 * That distinction is the whole design. An earlier draft had the server rotate
 * the managed row's public key on every restart so it could always sign. It
 * worked, and it was the wrong shape: automatic key rewriting is one mistargeted
 * row away from locking a real third-party agent out of its own identity, and
 * it hides a provisioning gap behind machinery instead of reporting it. Now the
 * server refuses and says to run this.
 *
 * Writes ONLY the public half to the database. The private half is printed once
 * and never persisted anywhere by this script.
 *
 *   npx tsx scripts/mint-sim-identity.ts <merchant-slug>
 */
import "./lib/loadEnv";
import { createClient } from "@supabase/supabase-js";
import { generateKeyPair } from "../src/lib/webBotAuth/keys";

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const SIM_AGENT_NAME = "Checkout Agent";

async function main() {
  const slug = process.argv[2];
  if (!slug) {
    const { data } = await db.from("merchants").select("slug, name").order("created_at");
    console.error("Usage: npx tsx scripts/mint-sim-identity.ts <merchant-slug>\n");
    console.error("Merchants on this deployment:");
    for (const m of data ?? []) console.error(`  ${m.slug}  (${m.name})`);
    process.exit(1);
  }

  const { data: merchant, error: mErr } = await db
    .from("merchants")
    .select("id, name, slug")
    .eq("slug", slug)
    .maybeSingle();
  if (mErr) throw new Error(mErr.message);
  if (!merchant) throw new Error(`No merchant with slug "${slug}".`);

  const { data: existing, error: lookupErr } = await db
    .from("agents")
    .select("id, name")
    .eq("merchant_id", merchant.id)
    .eq("managed", true)
    .maybeSingle();
  if (lookupErr) throw new Error(lookupErr.message);

  const { secretKey, publicKey } = generateKeyPair();
  let agentId: string;

  if (existing) {
    // Deliberate, operator-initiated, and scoped to a managed row. The identity
    // keeps its id, so every trace already attributed to it stays attributed to
    // it and its trust score carries forward instead of restarting at 50.
    const { error } = await db
      .from("agents")
      .update({ public_key: publicKey })
      .eq("id", existing.id)
      .eq("merchant_id", merchant.id)
      .eq("managed", true);
    if (error) throw new Error(error.message);
    agentId = existing.id;
    console.log(`Re-keyed the existing managed identity "${existing.name}" (history preserved).`);
  } else {
    const { data, error } = await db
      .from("agents")
      .insert({
        merchant_id: merchant.id,
        name: SIM_AGENT_NAME,
        description: "An AI buyer agent transacting on behalf of customers.",
        public_key: publicKey,
        managed: true,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    agentId = data.id;
    console.log(`Created a managed identity for ${merchant.slug}.`);
  }

  console.log(`\nPaste into .env.local (it is gitignored — do not commit these):\n`);
  console.log(`SIM_AGENT_ID=${agentId}`);
  console.log(`SIM_AGENT_SECRET_KEY=${secretKey}`);
  console.log(
    `\nThe private half above is not stored anywhere. Lose it and you re-run this,` +
      `\nwhich re-keys the same identity rather than creating a second one.`
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
