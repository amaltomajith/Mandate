import "./env";
import { createAdminClient } from "@/lib/supabase/admin";
import { tick } from "./tick";

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

let stopping = false;
process.on("SIGINT", () => {
  stopping = true;
  console.log("[worker] stopping after this pass...");
});
process.on("SIGTERM", () => {
  stopping = true;
});

async function main() {
  const db = createAdminClient();
  console.log(`[worker] up. ${once ? "one pass" : `a pass every ${tickMs / 1000}s`}${slug ? `, merchant ${slug}` : ""}.`);
  do {
    const started = Date.now();
    try {
      await tick(db, slug);
    } catch (err) {
      // Includes a paused Supabase project or a network blip: log and try again.
      console.error("[worker] pass failed:", err instanceof Error ? err.message : err);
    }
    if (once || stopping) break;
    await new Promise((r) => setTimeout(r, Math.max(1000, tickMs - (Date.now() - started))));
  } while (!stopping);
  console.log("[worker] stopped.");
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
