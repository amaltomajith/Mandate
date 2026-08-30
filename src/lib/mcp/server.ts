import "server-only";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { ActionInput, DraftPolicyInput, ExplainInput } from "./schemas";
import { runActionEvaluation } from "./tools/actionEvaluator";
import { explainTrace } from "./tools/explain";
import { draftPolicy } from "./tools/draftPolicy";

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

function requireAgentId(extra: ToolExtra): string {
  const agentId = extra.authInfo?.extra?.agentId;
  if (typeof agentId !== "string") {
    // Should be unreachable — the route handler rejects unsigned/invalid requests
    // before an MCP transport ever sees them. This is a defense-in-depth check.
    throw new Error("No verified agent identity on this request.");
  }
  return agentId;
}

function toolResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

/** One fresh server per request — this deployment is stateless (see route.ts). */
export function createMandateServer(): McpServer {
  const server = new McpServer({ name: "mandate", version: "0.1.0" });

  server.registerTool(
    "simulate_action",
    {
      title: "Simulate a money action",
      description:
        "Runs a proposed money action (order.create, refund.create, subscription.create) through Mandate's policy engine WITHOUT moving money. Returns the decision (allow/block/escalate), which rule fired if any, and a trace id. Use this before enforce_action to preview what will happen.",
      inputSchema: ActionInput,
    },
    async (input, extra) => toolResult(await runActionEvaluation(requireAgentId(extra), input, "simulate"))
  );

  server.registerTool(
    "enforce_action",
    {
      title: "Enforce a money action",
      description:
        "Runs a proposed money action through the same policy engine as simulate_action. If the decision is 'allow', executes the real Razorpay/RazorpayX test-mode call. If 'block' or 'escalate', no money moves.",
      inputSchema: ActionInput,
    },
    async (input, extra) => toolResult(await runActionEvaluation(requireAgentId(extra), input, "enforce"))
  );

  server.registerTool(
    "explain",
    {
      title: "Explain a decision",
      description: "Returns a plain-language explanation of one past decision, grounded in its trace and the policy rule that fired (if any).",
      inputSchema: ExplainInput,
    },
    async (input) => toolResult(await explainTrace(input.traceId))
  );

  server.registerTool(
    "draft_policy",
    {
      title: "Draft a policy from natural language",
      description:
        "Turns a natural-language policy request or regulatory notice into a structured candidate rule, checks it against existing active rules, and backtests it against recent decisions. Always lands as pending_review — a human must approve it in the dashboard before it takes effect.",
      inputSchema: DraftPolicyInput,
    },
    async (input) => toolResult(await draftPolicy(input.text, input.source, input.sourceLabel))
  );

  return server;
}
