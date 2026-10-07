import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { signRequest } from "@/lib/webBotAuth/sign";

/**
 * The agents' only way to move money: an MCP client for the Payment Wall.
 *
 * The wall is an MCP server like any other, with one difference: it will not
 * talk to a caller it cannot identify. So the transport's `fetch` is wrapped to
 * sign every request with the agent's Ed25519 key (RFC 9421 style, covering the
 * method, path, authority and a digest of the body). The model never sees the
 * key or the signature. It sees `simulate_action` and `enforce_action`, and the
 * decision that comes back.
 */

export interface WallIdentity {
  baseUrl: string;
  /** The merchant's slug: the tenant the path names, and part of what is signed. */
  slug: string;
  agentId: string;
  secretKey: string;
}

export function signingFetch(identity: WallIdentity): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : "";
    const signed = signRequest({
      secretKeyBase64: identity.secretKey,
      keyid: identity.agentId,
      method,
      path: url.pathname + url.search,
      authority: url.host,
      body,
    });
    const headers = new Headers(init?.headers);
    for (const [k, v] of Object.entries(signed)) headers.set(k, v);
    return fetch(url, { ...init, headers });
  };
}

export async function connectWall(identity: WallIdentity): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`/api/m/${identity.slug}/mcp`, identity.baseUrl), {
    fetch: signingFetch(identity),
  });
  const client = new Client({ name: `mandate-${identity.agentId.slice(0, 8)}`, version: "0.3.0" });
  await client.connect(transport);
  return client;
}

/** The wall's reply to simulate_action / enforce_action. */
export interface WallOutcome {
  decision: "allow" | "block" | "escalate";
  ruleFired: { id: string; name: string; type: string } | null;
  reasoning: string;
  traceId: string;
  wouldEscalate: boolean;
  razorpayResponse: Record<string, unknown> | null;
  executionError?: string;
  dryRun?: boolean;
}

export function parseWallResult(result: unknown): WallOutcome {
  const r = result as { content?: { type: string; text?: string }[]; isError?: boolean };
  const text = r.content?.find((c) => c.type === "text")?.text;
  if (!text) throw new Error("The wall returned no content.");
  if (r.isError) throw new Error(`The wall refused the call: ${text}`);
  return JSON.parse(text) as WallOutcome;
}
