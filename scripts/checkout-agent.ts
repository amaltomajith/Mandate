/**
 * The Checkout/Upsell Agent demo — runs the exact scenario from HANDOVER.md's
 * "Demo script": an AI buyer that establishes a real UPI Autopay mandate,
 * purchases from a small catalog and proposes cross-sells (the part that
 * makes this read as agentic *commerce*, not just a policy-rule test
 * harness), one purchase that breaches the step-up threshold and gets
 * escalated (not blocked), an attempt to structure around that same
 * threshold by splitting a purchase into rapid small chunks (caught by a
 * rate-limit rule instead), a merchant revoking the mandate that immediately
 * blocks the agent's next action, and finally a deliberately tampered
 * request that gets caught at the protocol layer before it ever reaches the
 * policy engine.
 *
 * Shares its catalog/upsell logic and MCP client with the dashboard's
 * one-click "Run demo" button — see src/lib/demo/runDemo.ts, which this
 * script is a thin CLI wrapper around.
 *
 * Uses `order.create`, which works on standard Razorpay test-mode keys.
 *
 * Prereqs:
 *   1. `npx tsx scripts/seed.ts` (policy domains + rules)
 *   2. `npm run dev` running, with real Razorpay test-mode keys set
 *
 * No manual agent registration step: the run registers its own agent identity
 * on first use and reuses it afterwards (ensureAgentIdentity in
 * src/lib/demo/shared.ts). Setting CHECKOUT_AGENT_ID / CHECKOUT_AGENT_SECRET_KEY
 * pins it to a specific existing agent instead, which is optional.
 *
 * Usage: npx tsx scripts/checkout-agent.ts
 */
import "./lib/loadEnv";
import { runDemoScript } from "../src/lib/demo/runDemo";

const ICONS = { ok: "✅", escalated: "🟠", blocked: "⛔", rejected: "🛡️", error: "❌" } as const;

async function main() {
  console.log(
    "Running the Mandate demo (seed → agent → mandate → catalog purchases + upsells → escalation → structuring attempt caught → mandate revoked → tampered request)...\n"
  );

  const steps = await runDemoScript();
  for (const step of steps) {
    const tag = step.kind === "upsell" ? " [upsell]" : "";
    console.log(`${ICONS[step.status]} ${step.label}${tag}`);
    console.log(`   ${step.detail}`);
  }

  const escalation = steps.find((s) => s.status === "escalated");
  if (escalation) {
    console.log("\n-> Sitting in the dashboard's pending-escalations panel now.");
    console.log("-> Approve it there to see the trace resolve and the alert log update.");
  }

  console.log("\nDemo script complete.");
}

main().catch((err) => {
  console.error("\nDemo script failed:", err);
  process.exit(1);
});
