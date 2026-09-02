import { NextRequest, NextResponse } from "next/server";
import { verifySignedRequest } from "@/lib/webBotAuth/verify";
import { createAdminClient } from "@/lib/supabase/admin";
import { getMerchantBySlug } from "@/lib/merchant";

export const runtime = "nodejs";

/**
 * "Should I be working, and how fast?"
 *
 * The one place `agents.status` is read. It is a COOPERATIVE control: an agent
 * polls this, and a well-behaved one complies. It is not enforcement and this
 * file does not pretend otherwise — a hostile agent can simply not poll, and
 * the thing that stops it is a mandate, which runs inside the request path
 * where compliance is not required.
 *
 * Keeping the two apart is the point. An earlier version enforced `status` in
 * the evaluator, and that was wrong in a way worth remembering: a refused agent
 * keeps calling. It burns model tokens on decisions that cannot land, fills the
 * trace log with refusals, and — because those refusals are enforce-mode traces
 * — spends the agent's velocity budget in `getAggregates`. Pausing an agent
 * would have quietly rate-limited it, punishing the thing the control was meant
 * to protect.
 *
 * What this endpoint deliberately does NOT return: policy rules, thresholds,
 * caps, trust scores, the catalog. It answers whether to work, never anything
 * about how the work will be judged — publishing the latter is the map an
 * adversary would use to structure underneath it, which is the same reason
 * /catalog withholds thresholds.
 *
 * And it writes nothing. No trace, no alert, no velocity consumed. An agent
 * checking whether it should act has not acted, and a polling loop that
 * silently ate a rate budget would make the control unusable at exactly the
 * pace it recommends.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const db = createAdminClient();
  const merchant = await getMerchantBySlug(db, slug);
  if (!merchant) {
    return NextResponse.json({ error: "unknown_merchant", slug }, { status: 404 });
  }

  const url = new URL(req.url);

  // Same verification as /mcp, and scoped to this merchant's agents for the
  // same reason: an agent registered with merchant A must not be able to read
  // its status from B's endpoint, and scoping the key lookup means the failure
  // is `unknown_keyid` before anything else happens.
  const verification = await verifySignedRequest({
    method: req.method,
    path: url.pathname + url.search,
    authority: req.headers.get("host") ?? url.host,
    // A GET has no body; the digest covers the empty string, which still binds
    // the signature to this method, path and authority.
    body: "",
    headers: {
      "content-digest": req.headers.get("content-digest"),
      "signature-input": req.headers.get("signature-input"),
      signature: req.headers.get("signature"),
    },
    lookupPublicKey: async (keyid) => {
      const { data } = await db
        .from("agents")
        .select("public_key")
        .eq("id", keyid)
        .eq("merchant_id", merchant.id)
        .maybeSingle();
      return data?.public_key ?? null;
    },
  });

  if (!verification.valid) {
    // Deliberately not recorded as a protocol_reject trace. This endpoint is
    // outside the money path, and a failed poll is a misconfigured agent rather
    // than an attempt on anything — writing it to the audit trail would bury
    // real forged-request evidence under polling noise.
    return NextResponse.json(
      { error: "signature_verification_failed", reason: verification.reason },
      { status: 401 }
    );
  }

  const { data: agent } = await db
    .from("agents")
    .select("status, pace_ms, name")
    .eq("id", verification.keyid)
    .eq("merchant_id", merchant.id)
    .maybeSingle();

  if (!agent) {
    return NextResponse.json({ error: "unknown_agent" }, { status: 401 });
  }

  const paused = agent.status === "paused";
  return NextResponse.json(
    {
      status: agent.status,
      pace_ms: agent.pace_ms,
      message: paused
        ? `${merchant.name} has paused this agent. Stop transacting and poll again later — ` +
          `requests sent anyway will still be judged on their merits, but nobody is asking for them.`
        : `${merchant.name} is accepting actions from this agent. Please leave about ` +
          `${Math.round(agent.pace_ms / 1000)}s between them.`,
    },
    {
      status: 200,
      // Never cached. A pause that takes effect whenever a CDN felt like
      // revalidating is not a pause.
      headers: { "cache-control": "no-store" },
    }
  );
}
