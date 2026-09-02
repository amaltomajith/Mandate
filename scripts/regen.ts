/**
 * Rebuilds demo history at a pace the policy engine considers ordinary.
 *
 * The active velocity rule allows 20 actions per 2 minutes per agent. A tick is
 * one purchase plus a ~30% chance of an upsell, so roughly 1.3 actions. Running
 * ticks back to back blows through that limit, the guardrail fires on every
 * subsequent action, and the trust score collapses -- which is what happened
 * the last time this was regenerated in a hurry. Ten seconds between ticks
 * keeps it near 8 actions/minute, comfortably inside the budget, so the history
 * that comes out is a record of a system behaving normally rather than one
 * being rate-limited.
 */
import "./lib/loadEnv";
import { createClient } from "@supabase/supabase-js";
import { runSimulation, ensureSomeActiveMandates } from "../src/lib/demo/simulation";
import { merchantForScript } from "./lib/merchant";

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const TICKS = Number(process.argv[2] ?? 80);
const GAP_MS = 10_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function trust(): Promise<number> {
  const { data } = await db.from("agents").select("trust_score").limit(1).single();
  return data?.trust_score ?? 0;
}

async function main() {
  const merchant = await merchantForScript(db);
  const mandates = await ensureSomeActiveMandates(merchant.id);
  console.log(`active mandates: ${mandates}`);
  console.log(`running ${TICKS} ticks, ${GAP_MS / 1000}s apart (~${Math.round((60000 / GAP_MS) * 1.3)} actions/min)`);

  let allowed = 0, escalated = 0, blocked = 0, rejected = 0, upsells = 0;
  for (let i = 1; i <= TICKS; i++) {
    const s = await runSimulation(merchant, 1);
    allowed += s.allowed; escalated += s.escalated; blocked += s.blocked; rejected += s.rejected;
    upsells += s.events.filter((e) => e.isUpsell).length;
    if (i % 10 === 0) {
      console.log(`  ${String(i).padStart(3)}/${TICKS}  trust ${(await trust()).toFixed(1)}  allow ${allowed} esc ${escalated} block ${blocked} forged ${rejected} upsell ${upsells}`);
    }
    if (i < TICKS) await sleep(GAP_MS);
  }
  console.log(`\ndone. trust ${(await trust()).toFixed(1)}`);
  console.log(`allow ${allowed} · escalate ${escalated} · block ${blocked} · forged ${rejected} · upsells ${upsells}`);
  const attachable = allowed - upsells;
  console.log(`upsell attach rate: ${attachable > 0 ? Math.round((upsells / attachable) * 100) : 0}%`);
}

main().catch((e) => { console.error(e); process.exit(1); });
