import type { Merchant } from "@/types/db";

/**
 * What a conforming agent has to do, generated from this merchant's live
 * configuration.
 *
 * Written from the merchant row rather than hardcoded so the slug and every URL
 * in it are real and copy-pasteable. A specification that documents
 * `/api/m/<your-slug>/mcp` is one the reader has to translate, and a reader who
 * translates is a reader who gets it wrong.
 *
 * It contains no secret and never will. The signing section tells the reader to
 * generate a keypair locally and send only the public half — a spec that
 * handed out a private key would be teaching the opposite of what this product
 * argues.
 */

export interface AgentSpecRule {
  id: string;
  must: string;
  why: string;
}

export interface AgentSpec {
  merchant: { name: string; slug: string };
  endpoints: {
    mcp: string;
    catalog: string;
    keyDirectory: string;
    agentControl: string;
  };
  protocol: { revision: string; transport: string; signing: string };
  rules: AgentSpecRule[];
  keygen: string;
}

export function buildAgentSpec(merchant: Merchant, baseUrl: string): AgentSpec {
  const base = `${baseUrl}/api/m/${merchant.slug}`;

  return {
    merchant: { name: merchant.name, slug: merchant.slug },
    endpoints: {
      mcp: `${base}/mcp`,
      catalog: `${base}/catalog`,
      keyDirectory: `${base}/wba-directory`,
      agentControl: `${base}/agent-control`,
    },
    protocol: {
      revision: "2026-07-28",
      transport: "streamable-http, one signed POST per message",
      signing: "web-bot-auth, ed25519, RFC 9421-shaped",
    },
    keygen:
      "Generate locally and send only the public half. We never see, store or " +
      "want your private key — it is your identity, not a credential we issue.",
    rules: [
      {
        id: "keypair",
        must: "Hold your own Ed25519 keypair and register only the public half.",
        why: "There is no API key here. The keyid you sign with IS your agent id, so possession of the private key is what proves who you are.",
      },
      {
        id: "sign-every-request",
        must: 'Sign every POST over the canonical base: "@method", "@path", "@authority", "content-digest".',
        why: "Verification happens before the policy engine sees anything. A tampered body fails even with a valid signature attached, because the digest covers it.",
      },
      {
        id: "protocol-version",
        must: "Send MCP-Protocol-Version: 2026-07-28, matching the _meta envelope on each request.",
        why: "There is no handshake to negotiate it on. Under this revision every message stands alone.",
      },
      {
        id: "header-mirroring",
        must: "Mirror Mcp-Method and Mcp-Name to the body.",
        why: "A request whose headers and body disagree is refused with -32020. The body is digest-covered, so a mismatched header cannot change what executes — only get you rejected.",
      },
      {
        id: "elicitation",
        must: 'Declare elicitation in io.modelcontextprotocol/clientCapabilities to receive counter-offers.',
        why: "Without it you get the same pre-cleared candidates as a suggestions array on the ordinary result. That path works and is supported; you simply cannot be asked mid-call.",
      },
      {
        id: "request-state",
        must: "Echo requestState back VERBATIM on a retry. Never parse, edit or rebuild it.",
        why: "It is our sealed state: integrity-protected, bound to your agent id, and none of your business. Altering it fails verification and looks like an attempt to forge one.",
      },
      {
        id: "retry-shape",
        must: "Answer an input_required result by retrying the ORIGINAL tools/call as a fresh signed POST carrying inputResponses.",
        why: "The retry is re-verified and re-judged from scratch. It can legitimately reach a different answer than the first post, because rules and rate budgets move.",
      },
      {
        id: "outcomes",
        must: "Handle allow, block, escalate, counter-offer and protocol_reject.",
        why: "An escalation is a human being asked, not an error. Retrying it is the wrong response; reporting it and moving on is the right one.",
      },
      {
        id: "agent-control",
        must: "Poll agent-control before each cycle and honour status and pace_ms.",
        why: "This is cooperative, not enforced — we do not refuse your calls when you are paused. Complying saves you tokens and keeps you welcome; ignoring it is visible to us.",
      },
      {
        id: "catalog",
        must: "Fetch products from /catalog over HTTP and ground every SKU against it.",
        why: "Discovery comes before the signature, which is why the catalog is public. An action naming a product we do not sell is refused.",
      },
      {
        id: "simulate-first",
        must: "Probe with simulate_action before enforce_action.",
        why: "Simulation costs you no rate budget and leaves no mark. A refusal found by simulating costs a round trip; one found by enforcing costs a refusal on your record.",
      },
    ],
  };
}
