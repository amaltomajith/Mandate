/**
 * The Checkout/Upsell Agent demo — runs the exact scenario from HANDOVER.md's
 * "Demo script": a few normal purchases, one that breaches the step-up
 * threshold and gets escalated (not blocked), then a deliberately tampered
 * request that gets caught at the protocol layer before it ever reaches the
 * policy engine.
 *
 * Uses `order.create` (standard Razorpay test-mode keys) rather than
 * `payout.create` (RazorpayX) as the real-money-adjacent action — RazorpayX's
 * dashboard gates even test mode behind having a registered business, which
 * not everyone running this demo will have. `order.create` needs nothing but
 * the standard RAZORPAY_KEY_ID/SECRET and is a real, live Razorpay API call
 * (it'll show up in your test-mode Orders dashboard). `payout.create`'s code
 * path in src/lib/razorpay/actions.ts is untouched or unaffected — if you get
 * RazorpayX access later, `enforce_action` already supports it, this script
 * just doesn't call it by default. See HANDOVER.md §6.
 *
 * Prereqs:
 *   1. `npx tsx scripts/seed.ts` (policy rules)
 *   2. `npx tsx scripts/gen-agent-key.ts "Checkout Agent"` — copy the printed
 *      agent id and secret key into CHECKOUT_AGENT_ID / CHECKOUT_AGENT_SECRET_KEY
 *   3. `npm run dev` running, with real Razorpay test-mode keys set
 *
 * Usage: npx tsx scripts/checkout-agent.ts
 */
import "./lib/loadEnv";
import { MandateClient } from "../src/lib/demo/mandateClient";

const BASE_URL = process.env.MANDATE_APP_URL ?? "http://localhost:3000";
const AGENT_ID = process.env.CHECKOUT_AGENT_ID;
const SECRET_KEY = process.env.CHECKOUT_AGENT_SECRET_KEY;

interface ActionResult {
  decision: "allow" | "block" | "escalate";
  reasoning: string;
  traceId: string;
  wouldEscalate: boolean;
  razorpayResponse?: { id?: string } | null;
}

function log(step: string, result: ActionResult) {
  const icon = { allow: "✅", block: "⛔", escalate: "🟠" }[result.decision];
  console.log(`\n${icon} ${step} — ${result.decision.toUpperCase()}`);
  console.log(`   ${result.reasoning}`);
  console.log(`   trace: ${result.traceId}`);
  if (result.razorpayResponse?.id) {
    console.log(`   razorpay order: ${result.razorpayResponse.id} (check your test-mode dashboard)`);
  }
}

async function purchase(client: MandateClient, label: string, amountPaise: number) {
  const args = {
    actionType: "order.create",
    amount: amountPaise,
    currency: "INR",
    category: "restock",
    params: {
      receipt: `mandate-demo-${Date.now()}`,
      notes: { label },
    },
  };

  const simulated = await client.callTool<ActionResult>("simulate_action", args);
  log(`[simulate] ${label} (₹${amountPaise / 100})`, simulated);

  const enforced = await client.callTool<ActionResult>("enforce_action", args);
  log(`[enforce]  ${label} (₹${amountPaise / 100})`, enforced);
  return enforced;
}

async function main() {
  if (!AGENT_ID || !SECRET_KEY) {
    console.error("Set CHECKOUT_AGENT_ID and CHECKOUT_AGENT_SECRET_KEY (see scripts/gen-agent-key.ts).");
    process.exit(1);
  }

  const client = new MandateClient(BASE_URL, AGENT_ID, SECRET_KEY);

  console.log("Initializing MCP session...");
  await client.initialize("mandate-checkout-agent");

  console.log("\n--- Normal activity: a few purchases under every threshold ---");
  await purchase(client, "Restock order #1", 100000); // ₹1,000
  await purchase(client, "Restock order #2", 150000); // ₹1,500
  await purchase(client, "Restock order #3", 200000); // ₹2,000

  console.log("\n--- The graceful-failure moment: over the step-up threshold ---");
  const escalated = await purchase(client, "Large restock order", 600000); // ₹6,000
  if (escalated.decision === "escalate") {
    console.log("\n   -> Sitting in the dashboard's pending-escalations panel now.");
    console.log("   -> Approve it there to see the trace resolve and the alert log update.");
  }

  console.log("\n--- Live self-defense: a tampered request ---");
  const tampered = await client.sendTamperedRequest();
  console.log(`   HTTP ${tampered.status}: ${tampered.body}`);
  console.log("   -> Rejected at the protocol layer — logged as a protocol_reject trace, never reached the policy engine.");

  console.log("\nDemo script complete.");
}

main().catch((err) => {
  console.error("\nDemo script failed:", err);
  process.exit(1);
});
