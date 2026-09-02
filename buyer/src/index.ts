import { BuyerAgent } from "./agent.js";
import { pause, rule, say } from "./log.js";

/**
 * Entry point.
 *
 *   npm --prefix buyer start          browse continuously
 *   npm --prefix buyer run once       one purchase, then stop
 *
 * Continuous mode is the interesting one to watch: the agent works through a
 * budget, meets counter-offers, accepts some and declines others, and stops on
 * its own when there is nothing left worth buying.
 */
const once = process.argv.includes("--once");
const GAP_MS = Number(process.env.BUYER_GAP_MS ?? 8000);

async function main() {
  const agent = new BuyerAgent();
  await agent.introduce();

  if (once) {
    await agent.buyOnce();
    rule();
    return;
  }

  // Paced deliberately. The merchant enforces a rate limit, and hitting it
  // would make this agent look rejected when it is merely impatient — and a
  // demo that scrolls faster than anyone can read demonstrates nothing.
  for (;;) {
    const keepGoing = await agent.buyOnce();
    if (!keepGoing) break;
    await pause(GAP_MS);
  }
  rule();
  say("Done shopping.");
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
