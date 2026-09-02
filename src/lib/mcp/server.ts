import "server-only";
import { McpServer, inputRequired, acceptedContent } from "@modelcontextprotocol/server";
import type { ServerContext, CallToolResult, InputRequiredResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ActionInput, DraftPolicyInput, ExplainInput } from "./schemas";
import { runActionEvaluation } from "./tools/actionEvaluator";
import { explainTrace } from "./tools/explain";
import { draftPolicy } from "./tools/draftPolicy";
import { createAdminClient } from "@/lib/supabase/admin";
import { getMerchantIdForAgent } from "@/lib/merchant";
import { runGovernedAction } from "./tools/governedAction";
import { offerStateCodec, counterOffersConfigured, type OfferState } from "./requestState";

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

/**
 * Whether this caller can answer a question mid-call.
 *
 * Read from the per-request `_meta` envelope, not from a session — under
 * 2026-07-28 capabilities travel with every request, which is what lets a
 * stateless server answer each one correctly without remembering the caller.
 *
 * A client that declares nothing gets the fallback path, and that is the common
 * case rather than the exception: most MCP clients today do not implement
 * elicitation. The fallback has to be a real product behaviour, not a stub.
 */
function supportsElicitation(ctx: ServerContext): boolean {
  // The envelope is typed as an opaque bag by the SDK (a deliberately neutral
  // shape that stays assignable to `_meta`), so the key is read by name.
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const caps = envelope?.["io.modelcontextprotocol/clientCapabilities"];
  return typeof caps === "object" && caps !== null && "elicitation" in caps;
}

/** The buyer's answer to a counter-offer. Shaped, not trusted: the SDK hands
 *  these over unvalidated by design, so anything other than an explicit `true`
 *  is a decline. */
const CounterAnswer = z.object({ accept: z.boolean(), reason: z.string().optional() });

function readAcceptance(ctx: ServerContext): { accepted: boolean; reason?: string } {
  const answer = acceptedContent(ctx.mcpReq.inputResponses, "counter_offer", CounterAnswer);
  return { accepted: answer?.accept === true, reason: answer?.reason };
}

/** One fresh server per request. Under 2026-07-28 that is the only model —
 *  `createMcpHandler` calls this factory for every inbound request. */
export function createMandateServer(): McpServer {
  const server = new McpServer(
    { name: "mandate", version: "0.2.0" },
    // Verifies the sealed requestState a retry echoes back. Without this the
    // SDK would hand the handler whatever the client sent; with it, a state
    // that was tampered with, expired, or minted for a different agent never
    // reaches the handler at all.
    counterOffersConfigured() ? { requestState: { verify: offerStateCodec().verify } } : undefined
  );

  server.registerTool(
    "simulate_action",
    {
      title: "Simulate a money action",
      description:
        "Runs a proposed money action (order.create, refund.create, subscription.create, payment_link.create) through Mandate's policy engine WITHOUT moving money. Returns the decision (allow/block/escalate), which rule fired if any, and a trace id. Use this before enforce_action to preview what will happen. Costs no rate budget.",
      inputSchema: ActionInput,
    },
    // Simulate never starts a round trip: a preview that stops to ask a
    // question is not a preview.
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
    async (input, ctx): Promise<CallToolResult | InputRequiredResult> => {
      const agentId = requireAgentId(ctx);
      const offerState = counterOffersConfigured()
        ? ctx.mcpReq.requestState<OfferState>()
        : undefined;

      const result = await runGovernedAction(agentId, input, "enforce", {
        supportsElicitation: supportsElicitation(ctx),
        offerState: offerState ?? undefined,
        ...(offerState
          ? (() => {
              const a = readAcceptance(ctx);
              return { accepted: a.accepted, buyerReason: a.reason };
            })()
          : {}),
      });

      if (result.kind === "result") {
        return toolResult({
          ...result.outcome,
          ...(result.suggestions ? { suggestions: result.suggestions } : {}),
          ...(result.counterOffer ? { counterOffer: result.counterOffer } : {}),
        });
      }

      // Nothing has executed at this point, and there is no path from here to
      // Razorpay — the parent was evaluated in simulate mode. The buyer's
      // answer arrives as a second signed POST that re-enters this handler and
      // re-runs every check from scratch.
      return inputRequired({
        inputRequests: {
          counter_offer: inputRequired.elicit({
            message:
              `${result.offer.reason} Add ${result.offer.name} for ` +
              `${(result.offer.amountPaise / 100).toLocaleString("en-IN", { style: "currency", currency: "INR" })}?`,
            requestedSchema: {
              type: "object",
              properties: {
                accept: { type: "boolean", title: `Add ${result.offer.name}?` },
              },
              required: ["accept"],
            },
          }),
        },
        requestState: await offerStateCodec().mint(result.state, ctx),
      });
    }
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
