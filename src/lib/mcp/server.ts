import "server-only";
import { McpServer } from "@modelcontextprotocol/server";
import type { ServerContext } from "@modelcontextprotocol/server";
import { ActionInput, DraftPolicyInput, ExplainInput } from "./schemas";
import { runActionEvaluation } from "./tools/actionEvaluator";
import { explainTrace } from "./tools/explain";
import { draftPolicy } from "./tools/draftPolicy";
import { createAdminClient } from "@/lib/supabase/admin";
import { getMerchantIdForAgent } from "@/lib/merchant";

/**
 * MCP server, protocol revision 2026-07-28.
 *
 * Migrated from the v1 `@modelcontextprotocol/sdk` package, which topped out at
 * 2025-11-25 and had no MRTR. v2 ships as split `@modelcontextprotocol/server`
 * and `/client` packages with no v1 compatibility layer, so this was a
 * replacement rather than an upgrade — see SPIKE.md for what that cost.
 *
 * The shape that matters here: 2026-07-28 has no `initialize` handshake and no
 * `Mcp-Session-Id`. Every client message is its own signed HTTP POST, and a
 * fresh server instance serves it. That suits this project unusually well,
 * because Web Bot Auth already re-verifies every request — there was never any
 * state worth keeping between them.
 */

function requireAgentId(ctx: ServerContext): string {
  const agentId = ctx.http?.authInfo?.extra?.agentId;
  if (typeof agentId !== "string") {
    // Should be unreachable — the route handler rejects unsigned and invalid
    // requests before the handler ever sees them. Defense in depth.
    throw new Error("No verified agent identity on this request.");
  }
  return agentId;
}

/** The tenant for a tool call, derived from the agent the signature proved.
 *  Taking it from the verified identity rather than the tool input means no
 *  tool has a parameter an agent could use to reach into another merchant. */
async function merchantOf(ctx: ServerContext): Promise<string> {
  return getMerchantIdForAgent(createAdminClient(), requireAgentId(ctx));
}

function toolResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

/** One fresh server per request. Under 2026-07-28 that is the only model —
 *  `createMcpHandler` calls this factory for every inbound request. */
export function createMandateServer(): McpServer {
  const server = new McpServer({ name: "mandate", version: "0.2.0" });

  server.registerTool(
    "simulate_action",
    {
      title: "Simulate a money action",
      description:
        "Runs a proposed money action (order.create, refund.create, subscription.create, payment_link.create) through Mandate's policy engine WITHOUT moving money. Returns the decision (allow/block/escalate), which rule fired if any, and a trace id. Use this before enforce_action to preview what will happen. Costs no rate budget.",
      inputSchema: ActionInput,
    },
    async (input, ctx) => toolResult(await runActionEvaluation(requireAgentId(ctx), input, "simulate"))
  );

  server.registerTool(
    "enforce_action",
    {
      title: "Enforce a money action",
      description:
        "Runs a proposed money action through the same policy engine as simulate_action. If the decision is 'allow', executes the real Razorpay test-mode call. If 'block' or 'escalate', no money moves.",
      inputSchema: ActionInput,
    },
    async (input, ctx) => toolResult(await runActionEvaluation(requireAgentId(ctx), input, "enforce"))
  );

  server.registerTool(
    "explain",
    {
      title: "Explain a decision",
      description:
        "Returns a plain-language explanation of one past decision, grounded in its trace and the policy rule that fired (if any).",
      inputSchema: ExplainInput,
    },
    async (input, ctx) => toolResult(await explainTrace(await merchantOf(ctx), input.traceId))
  );

  server.registerTool(
    "draft_policy",
    {
      title: "Draft a policy from natural language",
      description:
        "Turns a natural-language policy request or regulatory notice into a structured candidate rule, checks it against existing active rules, and backtests it against recent decisions. Always lands as pending_review — a human must approve it in the dashboard before it takes effect.",
      inputSchema: DraftPolicyInput,
    },
    async (input, ctx) =>
      toolResult(await draftPolicy(await merchantOf(ctx), input.text, input.source, input.sourceLabel))
  );

  return server;
}
