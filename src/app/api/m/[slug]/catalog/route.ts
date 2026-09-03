import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getMerchantBySlug } from "@/lib/merchant";
import { fetchCatalog } from "@/lib/demo/catalog";
import { verifySignedRequest } from "@/lib/webBotAuth/verify";
import { recordNonce } from "@/lib/webBotAuth/nonceStore";

export const runtime = "nodejs";

/**
 * The merchant's storefront, readable by a machine.
 *
 * This is what makes a merchant *transactable by an AI buyer* rather than only
 * governable: an outside agent can discover what is for sale and how to buy
 * it, without a human reading a docs page first. Deliberately public and
 * unauthenticated — a catalog nobody can read before they hold credentials is
 * a catalog no new buyer can find, and discovery has to come before the
 * signature does.
 *
 * `transact` is the half that matters. A price list alone tells an agent what
 * exists; this tells it where to send an order, how to prove who it is, and
 * which actions the merchant accepts.
 *
 * What is deliberately NOT here: the policy thresholds. Publishing "anything
 * above ₹5,000 needs approval" would tell an adversary precisely where to
 * structure underneath — the exact evasion the rate limiter exists to catch.
 * Agents are pointed at `simulate_action` instead, which answers "would this
 * specific action clear?" without revealing the shape of the rule that decides
 * it. Useful to an honest buyer, useless as a map for a dishonest one.
 *
 * SIGNING IS OPTIONAL, and the two answers differ. Unsigned, this serves the
 * merchant's full active catalog — discovery has to work before an agent holds
 * an identity, or nobody could ever become a customer. Signed by a known agent,
 * it serves that agent's SCOPED view: what this particular buyer may actually
 * transact. An agent that knows its own boundary does not waste round trips
 * proposing things that will be refused.
 *
 * A signature that is PRESENT but invalid is refused rather than quietly
 * downgraded to the public view. An agent that signed expects its own answer;
 * handing it the unscoped catalog instead would be actively misleading — it
 * would go on to propose purchases the engine then blocks, and the cause would
 * be invisible from its side.
 *
 * And filtering this listing is NOT the enforcement. An agent that names an
 * out-of-scope SKU directly is still blocked by the catalog_scope rule in the
 * engine. A menu that omits a dish is not a lock on the kitchen.
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const db = createAdminClient();
  const merchant = await getMerchantBySlug(db, slug);
  if (!merchant) {
    return NextResponse.json({ error: "unknown_merchant", slug }, { status: 404 });
  }

  const url = new URL(req.url);
  const signatureInput = req.headers.get("signature-input");
  let agentScope: string[] | null = null;
  let scopedFor: string | null = null;

  if (signatureInput) {
    const verification = await verifySignedRequest({
      method: req.method,
      path: url.pathname + url.search,
      authority: req.headers.get("host") ?? url.host,
      // A GET carries no body; the digest covers the empty string, which still
      // binds the signature to this method, path and authority.
      body: "",
      headers: {
        "content-digest": req.headers.get("content-digest"),
        "signature-input": signatureInput,
        signature: req.headers.get("signature"),
      },
      lookupPublicKey: async (keyid) => {
        const { data } = await db
          .from("agents")
          .select("public_key")
          // A retired agent has no key here, so verification fails with the same
          // `unknown_keyid` a stranger gets -- refused at the protocol layer before
          // any policy runs, whether or not the agent cooperates.
          .eq("retired", false)
          .eq("id", keyid)
          .eq("merchant_id", merchant.id)
          .maybeSingle();
        return data?.public_key ?? null;
      },
      recordNonce,
    });

    if (!verification.valid) {
      return NextResponse.json(
        { error: "signature_verification_failed", reason: verification.reason },
        { status: 401 }
      );
    }

    const { data: agent } = await db
      .from("agents")
      .select("id, catalog_scope")
      .eq("id", verification.keyid)
      .eq("merchant_id", merchant.id)
      .maybeSingle();
    agentScope = agent?.catalog_scope ?? null;
    scopedFor = agent?.id ?? null;
  }

  // ONE source of truth for what is for sale. This route used to run its own
  // query, and pass one flagged that as the real risk in the design -- adding
  // per-agent scope on top would have meant a second copy of the scope filter
  // too. The route only ever differed in sort order and response shape, and it
  // can do both itself.
  let products;
  try {
    products = await fetchCatalog(db, merchant.id, agentScope);
  } catch {
    return NextResponse.json({ error: "catalog_unavailable" }, { status: 503 });
  }
  products.sort((a, b) => a.priceInPaise - b.priceInPaise);

  // Built from the merchant this request resolved to, not hardcoded. A catalog
  // that names itself "Demo Storefront" and points at a global /api/mcp would
  // send an agent to the wrong endpoint with the wrong identity -- and it would
  // do it silently, because the JSON still looks perfectly well-formed.
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

  return NextResponse.json(
    {
      merchant: {
        name: merchant.name,
        currency: "INR",
        settlement: "razorpay",
      },

      transact: {
        protocol: "mcp",
        transport: "streamable-http",
        endpoint: `${baseUrl}/api/m/${merchant.slug}/mcp`,
        auth: {
          scheme: "web-bot-auth",
          algorithm: "ed25519",
          signs: ["@method", "@path", "@authority", "content-digest"],
          keyDirectory: `${baseUrl}/api/m/${merchant.slug}/wba-directory`,
          note: "Every request is signed. The keyid you sign with is your agent id; an unsigned or tampered request is rejected before any policy runs.",
        },
        actions: ["order.create", "refund.create", "subscription.create"],
        tools: [
          {
            name: "simulate_action",
            use: "Ask whether an action would be permitted, without doing it. Check here before committing to a basket — a refused action costs the buyer nothing but a wasted round trip.",
          },
          {
            name: "enforce_action",
            use: "Actually perform the action. Executes against Razorpay only if the merchant's policy permits it.",
          },
          {
            name: "explain",
            use: "Ask why a past decision went the way it did, in plain language.",
          },
        ],
      },

      // Stated rather than implied: an agent should expect that some actions
      // are held for a human, and that being held is not the same as being
      // refused. Without this an agent treats a non-allow as a failure and
      // abandons a sale the merchant was willing to make.
      terms: {
        outcomes: ["allow", "escalate", "block"],
        escalate:
          "Held for the merchant to approve. Not a refusal — it may still execute once a human decides.",
        block: "Refused outright by policy. Retrying the identical action will not change the answer.",
        advice: "Call simulate_action first to find what clears rather than guessing at limits.",
      },

      // Stated when it applies, so an agent knows it is looking at a subset
      // rather than at everything the merchant sells. Silence here would make a
      // narrow catalog indistinguishable from a small one.
      ...(scopedFor
        ? {
            scope: {
              agent: scopedFor,
              categories: agentScope,
              note:
                agentScope === null
                  ? "You may transact the merchant's full catalog."
                  : agentScope.length === 0
                    ? "You are currently scoped to no categories, so nothing here is transactable by you."
                    : `This is your scoped view. You may transact: ${agentScope.join(", ")}.`,
            },
          }
        : {}),

      catalog: products.map((p) => ({
        sku: p.sku,
        name: p.name,
        description: p.description,
        price: { amount: p.priceInPaise, currency: "INR", unit: "paise" },
        category: p.category,
      })),
    },
    {
      // A signed response is per-agent, so it must never land in a shared
      // cache. The unsigned public catalog stays cheap to poll.
      headers: {
        "cache-control": scopedFor ? "private, no-store" : "public, max-age=60",
      },
    }
  );
}
