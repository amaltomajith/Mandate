import "server-only";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMandateServer } from "./server";

/**
 * MCP's Streamable HTTP transport is session-based: an `initialize` call gets a
 * `mcp-session-id`, and every later call in that session must reuse the same
 * transport instance (it's the transport that tracks whether `initialize` already
 * happened). A brand-new transport per HTTP request — the simplest possible
 * serverless pattern — breaks that: `tools/call` would arrive at a transport that
 * has never seen `initialize` and gets rejected.
 *
 * This in-memory map is the fix: sessions live as long as this Node process does.
 * That's correct for a single warm process (local dev, and a Vercel function that
 * hasn't cold-started) and is a known, accepted limitation the moment you scale to
 * multiple instances — at that point session state needs to move to Supabase or
 * Redis. Documented in HANDOVER.md; not a gap Claude Code invented, it's the actual
 * tradeoff Streamable HTTP makes on serverless.
 */
const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

export async function getOrCreateSession(
  sessionId: string | null
): Promise<WebStandardStreamableHTTPServerTransport> {
  if (sessionId) {
    const existing = sessions.get(sessionId);
    if (existing) return existing;
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (newSessionId) => {
      sessions.set(newSessionId, transport);
    },
    onsessionclosed: (closedSessionId) => {
      sessions.delete(closedSessionId);
    },
  });

  const server = createMandateServer();
  await server.connect(transport);
  return transport;
}

export function endSession(sessionId: string): void {
  sessions.delete(sessionId);
}
