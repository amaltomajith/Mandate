import { NextRequest, NextResponse } from "next/server";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createMandateServer } from "@/lib/mcp/server";
import { verifySignedRequest } from "@/lib/webBotAuth/verify";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAlert, insertTrace } from "@/lib/mcp/traceHelpers";
import { getMerchantBySlug } from "@/lib/merchant";
import { recordNonce } from "@/lib/webBotAuth/nonceStore";

export const runtime = "nodejs";

/**
 * Key lookup, scoped to the merchant whose endpoint was addressed.
 *
 * This is what stops an agent registered with merchant A from acting on
 * merchant B: B's endpoint does not know A's keyid, so verification fails with
 * `unknown_keyid` before any policy runs. Scoping the lookup rather than
 * checking the agent's merchant afterwards means there is no window where a
 * cross-tenant request has been authenticated but not yet rejected.
 */
function lookupPublicKeyFor(merchantId: string) {
  return async (keyid: string): Promise<string | null> => {
    const db = createAdminClient();
    const { data } = await db
      .from("agents")
      .select("public_key")
      // A retired agent has no key here, so verification fails with the same
      // `unknown_keyid` a stranger gets -- refused at the protocol layer before
      // any policy runs, whether or not the agent cooperates.
      .eq("retired", false)
      .eq("id", keyid)
      .eq("merchant_id", merchantId)
      .maybeSingle();
    return data?.public_key ?? null;
  };
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
export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const merchant = await getMerchantBySlug(createAdminClient(), slug);
  if (!merchant) {
    return NextResponse.json({ error: "unknown_merchant", slug }, { status: 404 });
  }

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
    lookupPublicKey: lookupPublicKeyFor(merchant.id),
    recordNonce,
  });

  if (!verification.valid) {
    let attemptedMethod = "unknown";
    try {
      attemptedMethod = JSON.parse(bodyText)?.method ?? "unknown";
    } catch {
      // Not even valid JSON — still a protocol_reject, not a parse error we surface.
    }

    // Attributed to the merchant whose endpoint was addressed, not to any
    // identity the request claims. The signature failed, so nothing in it can
    // be trusted -- but the URL is not part of the claim, it is where the
    // request was actually sent. Attributing by the claimed keyid instead would
    // let anyone flood a competitor's audit trail by signing garbage with that
    // competitor's agent id, the same attack that keeps protocol rejects out of
    // the trust score.
    const trace = await insertTrace({
      merchantId: merchant.id,
      mode: "enforce",
      actionType: `protocol.${attemptedMethod}`,
      params: { reason: verification.reason, detail: verification.detail ?? null },
      agentId: null,
      decision: "protocol_reject",
      reasoning: `Rejected at the protocol layer before reaching the policy engine: ${verification.reason}.`,
    });
    await createAlert(merchant.id, trace.id, "high", `Rejected a malformed/tampered MCP request: ${verification.reason}`);

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

  // A fresh handler and a fresh server per request. Under 2026-07-28 there is
  // no session to reuse and nothing to keep between posts, which is why the
  // session store this route used to consult is gone rather than merely
  // unused. authInfo is strictly pass-through -- the handler never reads
  // headers or verifies anything itself, so the identity below is the one the
  // Ed25519 verification above established and nothing else.
  const handler = createMcpHandler(() => createMandateServer());
  try {
    return await handler.fetch(req, {
      parsedBody,
      authInfo: {
        token: verification.keyid,
        clientId: verification.keyid,
        scopes: [],
        extra: { agentId: verification.keyid },
      },
    });
  } finally {
    await handler.close();
  }
}

export async function GET() {
  // No server-initiated notifications in this deployment — the demo agent and
  // any MCP client that skips the standalone SSE stream work fine without this.
  return NextResponse.json(
    { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null },
    { status: 405 }
  );
}
