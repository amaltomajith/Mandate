import { NextRequest, NextResponse } from "next/server";
import { getOrCreateSession, endSession } from "@/lib/mcp/sessionStore";
import { verifySignedRequest } from "@/lib/webBotAuth/verify";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAlert, insertTrace } from "@/lib/mcp/traceHelpers";

export const runtime = "nodejs";

async function lookupPublicKey(keyid: string): Promise<string | null> {
  const db = createAdminClient();
  const { data } = await db.from("agents").select("public_key").eq("id", keyid).maybeSingle();
  return data?.public_key ?? null;
}

/**
 * Every request — `initialize` included — is Web Bot Auth-verified BEFORE it
 * reaches the MCP transport or the policy engine at all. A failed verification
 * never becomes a policy decision — it's logged as `protocol_reject` and rejected
 * here. This is the "live self-defense" layer from the build plan.
 *
 * See sessionStore.ts for why sessions (not a fresh transport per request) are
 * required for Streamable HTTP to work at all.
 */
export async function POST(req: NextRequest) {
  const bodyText = await req.text();
  const url = new URL(req.url);

  const verification = await verifySignedRequest({
    method: req.method,
    path: url.pathname + url.search,
    authority: req.headers.get("host") ?? url.host,
    body: bodyText,
    headers: {
      "content-digest": req.headers.get("content-digest"),
      "signature-input": req.headers.get("signature-input"),
      signature: req.headers.get("signature"),
    },
    lookupPublicKey,
  });

  if (!verification.valid) {
    let attemptedMethod = "unknown";
    try {
      attemptedMethod = JSON.parse(bodyText)?.method ?? "unknown";
    } catch {
      // Not even valid JSON — still a protocol_reject, not a parse error we surface.
    }

    const trace = await insertTrace({
      mode: "enforce",
      actionType: `protocol.${attemptedMethod}`,
      params: { reason: verification.reason, detail: verification.detail ?? null },
      agentId: null,
      decision: "protocol_reject",
      reasoning: `Rejected at the protocol layer before reaching the policy engine: ${verification.reason}.`,
    });
    await createAlert(trace.id, "high", `Rejected a malformed/tampered MCP request: ${verification.reason}`);

    return NextResponse.json(
      { error: "signature_verification_failed", reason: verification.reason },
      { status: 401 }
    );
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(bodyText);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const sessionId = req.headers.get("mcp-session-id");
  const transport = await getOrCreateSession(sessionId);

  return transport.handleRequest(req, {
    parsedBody,
    authInfo: {
      token: verification.keyid,
      clientId: verification.keyid,
      scopes: [],
      extra: { agentId: verification.keyid },
    },
  });
}

export async function DELETE(req: NextRequest) {
  const sessionId = req.headers.get("mcp-session-id");
  if (sessionId) endSession(sessionId);
  return new NextResponse(null, { status: 204 });
}

export async function GET() {
  // No server-initiated notifications in this deployment — the demo agent and
  // any MCP client that skips the standalone SSE stream work fine without this.
  return NextResponse.json(
    { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null },
    { status: 405 }
  );
}
