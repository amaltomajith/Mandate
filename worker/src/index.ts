import "./env";
import { createAdminClient } from "@/lib/supabase/admin";
import { tick } from "./tick";
import { createStopSignal, reportAlive } from "./lifecycle";
import { log } from "./log";
import { stopAllWhatsApp } from "./channels/whatsapp";

/**
 * The worker: a long-running process that lets each merchant's Buying and
 * Selling agents act on a timer.
 *
 *   npm run worker                    run forever, a pass every WORKER_TICK_SECONDS (default 60)
 *   npm run worker -- --once          one pass, then exit
 *   npm run worker -- --slug my-shop  only that merchant
 *
 * It must NOT run on a serverless host: it keeps connections open (and, with
 * WhatsApp, a socket), and a pass can take longer than a function is allowed to
 * live. Run it on your own machine or a small VPS.
 */

const args = process.argv.slice(2);
const once = args.includes("--once");
const slugIndex = args.indexOf("--slug");
const slug = slugIndex >= 0 ? args[slugIndex + 1] : undefined;
const tickMs = Math.max(10, Number(process.env.WORKER_TICK_SECONDS ?? 60)) * 1000;

const stop = createStopSignal();
// First signal: finish the pass in progress, then exit. Second signal: leave now.
function onSignal(name: string) {
  if (stop.stopping) {
    log.warn("signal again, leaving now", { signal: name });
    process.exit(1);
  }
  log.info("finishing this pass, then stopping (signal again to leave now)", { signal: name });
  stop.stop();
}
process.on("SIGINT", () => onSignal("SIGINT"));
process.on("SIGTERM", () => onSignal("SIGTERM"));

async function main() {
  const db = createAdminClient();
  log.info("worker up", { mode: once ? "one pass" : "loop", every_s: once ? null : tickMs / 1000, merchant: slug ?? "all" });
  do {
    const started = Date.now();
    try {
      await reportAlive(db, { slug: slug ?? null });
      const reports = await tick(db, slug, tickMs);
      await reportAlive(db, { slug: slug ?? null, merchants: reports.length });
      log.debug("pass finished", { merchants: reports.length, ms: Date.now() - started });
    } catch (err) {
      // Includes a paused Supabase project or a network blip: log and try again.
      log.error("pass failed", { err: err instanceof Error ? err.message : String(err), ms: Date.now() - started });
    }
    if (once || stop.stopping) break;
    // Wakes the moment a stop is requested instead of sleeping out the rest of the minute.
    await stop.sleep(Math.max(1000, tickMs - (Date.now() - started)));
  } while (!stop.stopping);
  await stopAllWhatsApp();
  log.info("worker stopped");
}

main().catch((err) => {
  log.error("fatal", { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
