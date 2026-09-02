import { BuyerAgent } from "./agent.js";
import { askIfIShouldWork } from "./control.js";
import { config } from "./config.js";
import { indent, pause, rule, say } from "./log.js";

/**
 * Entry point.
 *
 *   npm --prefix buyer start                       browse continuously
 *   npm --prefix buyer run once                    one purchase, then stop
 *   npm --prefix buyer start -- --pace=5000        override the pace, in ms
 *   npm --prefix buyer start -- --max-actions=3    hard ceiling on a run
 *
 * Continuous mode is the interesting one to watch: the agent works through a
 * budget, meets counter-offers, accepts some and declines others, and stops on
 * its own when there is nothing left worth buying.
 */
const args = process.argv.slice(2);
const once = args.includes("--once");

function flag(name: string, fallback: number): number {
  const raw = args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) ? value : fallback;
}

/** CLI overrides the environment; the merchant's pace overrides both, because
 *  it is their shop. `--max-actions` overrides nothing — it is a ceiling, and a
 *  ceiling a remote server can raise is not one. */
const paceOverride = flag("pace", NaN);
const maxActions = flag("max-actions", config.maxActions);
const HOW_LONG_TO_WAIT_WHILE_PAUSED_MS = 20_000;

async function main() {
  const agent = new BuyerAgent();
  await agent.introduce();

  if (once) {
    const control = await askIfIShouldWork();
    if (control.status === "paused") {
      say(control.unreachable ? "Standing down." : "The merchant has asked me to pause.");
      indent(control.message);
      rule();
      return;
    }
    await agent.buyOnce();
    rule();
    return;
  }

  // Ask first, every cycle. The merchant's answer is checked before any model
  // call and before any MCP call, so a paused agent costs nobody anything --
  // which is the entire reason a cooperative pause is worth honouring.
  //
  // Bounded by maxActions regardless. A runaway loop spending real money must
  // not depend on a remote server being reachable in order to stop.
  let actions = 0;
  while (actions < maxActions) {
    const control = await askIfIShouldWork();

    if (control.status === "paused") {
      say(control.unreachable ? "Standing down — I could not ask." : "Asked to pause.");
      indent(control.message);
      indent(`waiting ${HOW_LONG_TO_WAIT_WHILE_PAUSED_MS / 1000}s, then asking again`);
      await pause(HOW_LONG_TO_WAIT_WHILE_PAUSED_MS);
      continue;
    }

    const keepGoing = await agent.buyOnce();
    actions++;
    if (!keepGoing) break;

    const gap = Number.isFinite(paceOverride) ? paceOverride : control.paceMs;
    if (gap > 0) {
      indent(`pacing ${Math.round(gap / 1000)}s, as asked`);
      await pause(gap);
    }
  }

  if (actions >= maxActions) {
    say(`Reached my own limit of ${maxActions} actions. Stopping.`);
  }
  rule();
  say("Done shopping.");
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
