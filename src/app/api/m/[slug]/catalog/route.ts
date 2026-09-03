import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getMerchantBySlug } from "@/lib/merchant";

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
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const db = createAdminClient();
  const merchant = await getMerchantBySlug(db, slug);
  if (!merchant) {
    return NextResponse.json({ error: "unknown_merchant", slug }, { status: 404 });
  }

  // Active only. This mirrors fetchCatalog() rather than calling it, because
  // this route serves a different shape -- but the FILTER has to stay identical
  // or a product the merchant retired keeps being advertised to buyers. If one
  // of these two changes, change the other.
  const { data: products, error } = await db
    .from("products")
    .select("sku, name, description, price_paise, category")
    .eq("merchant_id", merchant.id)
    .eq("active", true)
    .order("price_paise", { ascending: true });

  if (error) {
    return NextResponse.json({ error: "catalog_unavailable" }, { status: 503 });
  }

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

      catalog: (products ?? []).map((p) => ({
        sku: p.sku,
        name: p.name,
        description: p.description,
        price: { amount: p.price_paise, currency: "INR", unit: "paise" },
        category: p.category,
      })),
    },
    {
      // Cheap for an agent to poll, without going stale for long after a
      // catalog change.
      headers: { "cache-control": "public, max-age=60" },
    }
  );
}
