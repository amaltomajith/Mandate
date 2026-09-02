/**
 * Registers the external buyer with a merchant. One-shot; kept because a
 * third-party agent genuinely has to be registered by the merchant before it
 * can transact -- there is no self-service path, by design.
 *
 * Usage: npx tsx scripts/register-buyer.ts <base64-public-key>
 */
import "./lib/loadEnv";
import { createClient } from "@supabase/supabase-js";
import { merchantForScript } from "./lib/merchant";
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
async function main() {
  const publicKey = process.argv[2];
  if (!publicKey) throw new Error("Pass the buyer's base64 public key.");
  const m = await merchantForScript(db);
  const { data: existing } = await db.from("agents").select("id").eq("merchant_id", m.id).eq("public_key", publicKey).maybeSingle();
  if (existing) { console.log(`already registered: ${existing.id}`); return; }
  const { data, error } = await db.from("agents").insert({
    merchant_id: m.id,
    name: "Autonomous Buyer",
    description: "A third-party AI buying agent. Runs outside this codebase; holds only its keypair.",
    public_key: publicKey,
  }).select().single();
  if (error) throw error;
  console.log(`registered with ${m.slug}`);
  console.log(`BUYER_AGENT_ID=${data.id}`);
}
main().catch((e)=>{console.error(e);process.exit(1);});
