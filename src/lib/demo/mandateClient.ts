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

/**
 * Minimal hand-rolled MCP Streamable HTTP client — deliberately not the
 * `@modelcontextprotocol/sdk` client transport. This IS the thing being governed
 * (a third-party-style agent calling Mandate's MCP server), so it signs its own
 * requests with Web Bot Auth exactly like an external agent would have to, and
 * speaks the wire protocol directly rather than trusting a client SDK to do it
 * "correctly" underneath — the whole point of the demo is showing that protocol
 * surface being checked.
 *
 * Shared between `scripts/checkout-agent.ts` (CLI) and the dashboard's one-click
 * "Run demo" button (`src/lib/demo/runDemo.ts`) — same client, two callers.
 */
export class MandateClient {
  private sessionId: string | null = null;
  private nextId = 1;

  constructor(
    private readonly baseUrl: string,
    private readonly agentId: string,
    private readonly secretKeyBase64: string
  ) {}

  private async post(body: unknown, expectResponse: boolean): Promise<unknown> {
    const url = new URL("/api/mcp", this.baseUrl);
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
      ...signed,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    const res = await fetch(url, { method: "POST", headers, body: bodyText });

    const returnedSessionId = res.headers.get("mcp-session-id");
    if (returnedSessionId) this.sessionId = returnedSessionId;

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

  async initialize(clientName: string): Promise<void> {
    await this.post(
      {
        jsonrpc: "2.0",
        id: this.nextId++,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: clientName, version: "0.1.0" },
        },
      },
      true
    );

    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, false);
  }

  async callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    const response = (await this.post(
      { jsonrpc: "2.0", id: this.nextId++, method: "tools/call", params: { name, arguments: args } },
      true
    )) as {
      result?: { content?: { type: string; text?: string }[]; isError?: boolean };
      error?: { message: string };
    };

    if (response.error) throw new Error(`Tool ${name} failed: ${response.error.message}`);
    const textPart = response.result?.content?.find((c) => c.type === "text");
    if (!textPart?.text) throw new Error(`Tool ${name} returned no text content`);
    if (response.result?.isError) throw new Error(`Tool ${name} returned an error: ${textPart.text}`);
    return JSON.parse(textPart.text) as T;
  }

  /** Deliberately sends a request with a corrupted signature — used to trigger and
   *  demonstrate the protocol-layer self-defense rejection, not a real tool call. */
  async sendTamperedRequest(): Promise<{ status: number; body: string }> {
    const url = new URL("/api/mcp", this.baseUrl);
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
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      },
      body: tamperedBody,
    });
    return { status: res.status, body: await res.text() };
  }
}
