import { signRequest } from "../webBotAuth/sign";

// Relative import, not the `@/` alias, on purpose — this module is loaded
// both by Next's bundler (server actions) and directly by tsx (the CLI
// script), and tsx doesn't reliably resolve tsconfig path aliases the way
// Next's bundler does.
//
// No `import "server-only"` here on purpose — this module is imported both by
// scripts/checkout-agent.ts (plain tsx, no Next.js bundler present) and by
// src/lib/demo/runDemo.ts (a real server action). "server-only" throws
// immediately outside Next's server bundling context, which would break the
// CLI script. It's still never imported from client components in practice.

/** What a counter-offer looks like on the wire, from the buyer's side. */
export interface InputRequestSpec {
  method?: string;
  params?: {
    message?: string;
    mode?: string;
    url?: string;
    requestedSchema?: unknown;
  };
}

/**
 * Decides how to answer a counter-offer. Returns the `inputResponses` map the
 * retry carries, keyed the same way the server keyed its `inputRequests`.
 *
 * Returning `null` declines the whole round: the client stops and surfaces the
 * InputRequiredResult to its caller rather than retrying. That is a real buyer
 * outcome, not an error.
 */
/** The raw shape a tools/call returns, before it is unwrapped. */
export interface RawToolResult {
  content?: { type: string; text?: string }[];
  isError?: boolean;
  resultType?: string;
  inputRequests?: Record<string, InputRequestSpec>;
  requestState?: string;
}

export type InputRequiredHandler = (
  requests: Record<string, InputRequestSpec>
) => Promise<Record<string, unknown> | null>;

/**
 * Minimal hand-rolled MCP client, protocol revision 2026-07-28 — deliberately
 * not `@modelcontextprotocol/client`. This IS the thing being governed (a
 * third-party-style agent calling Mandate), so it signs its own requests with
 * Web Bot Auth exactly like an external agent would have to, and speaks the
 * wire protocol directly rather than trusting a client SDK to do it correctly
 * underneath. The point of the demo is that protocol surface being checked.
 *
 * Two things changed with 2026-07-28 and both simplify this:
 *
 * There is no `initialize` handshake and no `Mcp-Session-Id`, so every call is
 * a single self-contained signed POST. The client holds no connection state.
 *
 * Server-to-client interaction is MRTR: instead of the server pushing an
 * `elicitation/create` request down a held-open stream, it *returns* an
 * `input_required` result, and the client retries the ORIGINAL call with its
 * answers. That means the retry is its own signed POST with its own body, so
 * it gets verified from scratch — there is no window where a half-finished
 * exchange is trusted, and a replayed retry from another agent fails at the
 * signature rather than somewhere deeper.
 */
export class MandateClient {
  private nextId = 1;

  constructor(
    private readonly baseUrl: string,
    /** The merchant whose endpoint this client talks to. The path is part of
     *  the signature base, so a client pointed at the wrong merchant fails
     *  verification rather than acting on the wrong tenant. */
    private readonly slug: string,
    private readonly agentId: string,
    private readonly secretKeyBase64: string,
    /** Advertised per request in the `_meta` envelope. A client that declares
     *  no elicitation capability must still be able to transact — the server
     *  answers it with plain suggestions instead of a counter-offer — so this
     *  defaults to off and the fallback path is the one exercised unless a
     *  caller opts in. */
    private readonly supportsElicitation = false
  ) {}

  /** The per-request `_meta` envelope 2026-07-28 carries in place of the
   *  handshake. Capabilities travel on every call rather than being negotiated
   *  once, which is what lets a stateless server answer each request correctly
   *  without remembering who is asking. */
  private envelope(): Record<string, unknown> {
    return {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "mandate-agent", version: "0.2.0" },
      "io.modelcontextprotocol/clientCapabilities": this.supportsElicitation ? { elicitation: {} } : {},
    };
  }

  private async post(body: unknown, expectResponse: boolean): Promise<unknown> {
    // 2026-07-28 requires the JSON-RPC method to be mirrored in an `Mcp-Method`
    // header, and rejects the request when the two disagree. Not signed
    // directly, and it does not need to be: the body is covered by
    // content-digest, so an altered header cannot change what executes -- it
    // can only produce a mismatch the server refuses outright.
    // `Mcp-Name` mirrors params.name the same way for tool and prompt calls.
    const envelopeBody = body as { method?: string; params?: { name?: string } } | null;
    const method = envelopeBody?.method;
    const name = envelopeBody?.params?.name;
    const url = new URL(`/api/m/${this.slug}/mcp`, this.baseUrl);
    const bodyText = JSON.stringify(body);
    const authority = url.host;

    const signed = signRequest({
      secretKeyBase64: this.secretKeyBase64,
      keyid: this.agentId,
      method: "POST",
      path: url.pathname + url.search,
      authority,
      body: bodyText,
    });

    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(method ? { "mcp-method": method } : {}),
      ...(name ? { "mcp-name": name } : {}),
      ...signed,
    };


    const res = await fetch(url, { method: "POST", headers, body: bodyText });

    if (!expectResponse) {
      if (!res.ok) throw new Error(`Notification failed: ${res.status} ${await res.text()}`);
      return undefined;
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`MCP request failed: ${res.status} ${text}`);
    }
    return res.json();
  }

  /**
   * No-op. 2026-07-28 removed the `initialize` handshake — capabilities and
   * protocol version ride in every request's `_meta` envelope instead.
   *
   * Kept as a method, and kept called, because the alternative is silence: a
   * reader who knows the 2025 protocol will look for the handshake, and a
   * method that says why there isn't one is worth more than its absence.
   */
  async initialize(_clientName: string): Promise<void> {
    void _clientName;
  }

  /**
   * Calls a tool, answering counter-offers along the way.
   *
   * When the server returns an `input_required` result, `onInputRequired`
   * decides how to answer and the ORIGINAL call is re-posted with those answers
   * plus the server's `requestState` echoed back verbatim. The server
   * re-evaluates everything on that retry — it does not resume a cached
   * decision — so the second post can legitimately reach a different outcome
   * than the first, and that is the point rather than a flaw.
   *
   * Rounds are bounded. A server that kept asking would otherwise spin a buyer
   * agent forever, and an unbounded retry loop driving real money actions is
   * not a loop anyone should ship.
   */
  /**
   * One post, no retry loop. Returns the raw result so a caller can inspect an
   * `input_required` and decide what to do with it by hand.
   *
   * `callTool` is the ergonomic path; this is the one tests use, because
   * proving the invariant means driving the two posts separately — changing a
   * cap between them, replaying the same state twice, sending someone else's
   * answers. A helper that always completes the round trip cannot express any
   * of that.
   */
  async callOnce(
    name: string,
    args: Record<string, unknown>,
    extra?: { inputResponses?: Record<string, unknown>; requestState?: string }
  ): Promise<RawToolResult> {
    const params: Record<string, unknown> = { name, arguments: args, _meta: this.envelope() };
    if (extra?.inputResponses) params.inputResponses = extra.inputResponses;
    if (extra?.requestState !== undefined) params.requestState = extra.requestState;

    const response = (await this.post(
      { jsonrpc: "2.0", id: this.nextId++, method: "tools/call", params },
      true
    )) as { result?: RawToolResult; error?: { message: string } };

    if (response.error) throw new Error(`Tool ${name} failed: ${response.error.message}`);
    if (!response.result) throw new Error(`Tool ${name} returned no result`);
    return response.result;
  }

  /** Unwraps a completed (non-input_required) result into its JSON payload. */
  static unwrap<T>(result: RawToolResult, name = "tool"): T {
    const textPart = result.content?.find((c) => c.type === "text");
    if (!textPart?.text) throw new Error(`${name} returned no text content`);
    if (result.isError) throw new Error(`${name} returned an error: ${textPart.text}`);
    return JSON.parse(textPart.text) as T;
  }

  async callTool<T = unknown>(
    name: string,
    args: Record<string, unknown>,
    onInputRequired?: InputRequiredHandler,
    maxRounds = 3
  ): Promise<T> {
    let inputResponses: Record<string, unknown> | undefined;
    let requestState: string | undefined;

    for (let round = 0; round < maxRounds; round++) {
      const result = await this.callOnce(name, args, { inputResponses, requestState });

      if (result.resultType === "input_required") {
        if (!onInputRequired) {
          throw new Error(
            `Tool ${name} asked for input, but this client was given no handler to answer with.`
          );
        }
        const answers = await onInputRequired(result.inputRequests ?? {});
        // A declined round is a real outcome. Surfacing the input_required
        // result lets the caller see what was offered and that it said no,
        // rather than collapsing a decision into an exception.
        if (answers === null) return result as T;
        inputResponses = answers;
        requestState = result.requestState;
        continue;
      }

      return MandateClient.unwrap<T>(result, `Tool ${name}`);
    }

    throw new Error(`Tool ${name} still wanted input after ${maxRounds} rounds.`);
  }

  /** Deliberately sends a request with a corrupted signature — used to trigger and
   *  demonstrate the protocol-layer self-defense rejection, not a real tool call. */
  async sendTamperedRequest(): Promise<{ status: number; body: string }> {
    const url = new URL(`/api/m/${this.slug}/mcp`, this.baseUrl);
    const body = {
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/call",
      params: { name: "enforce_action", arguments: { actionType: "order.create" } },
    };
    const bodyText = JSON.stringify(body);
    const signed = signRequest({
      secretKeyBase64: this.secretKeyBase64,
      keyid: this.agentId,
      method: "POST",
      path: url.pathname,
      authority: url.host,
      body: bodyText,
    });

    // Tamper with the body after signing — content-digest now won't match.
    const tamperedBody = bodyText.replace("order.create", "order.create ");

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...signed,
      },
      body: tamperedBody,
    });
    return { status: res.status, body: await res.text() };
  }
}
