import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getMerchantBySlug } from "@/lib/merchant";
import { buildAgentSpec } from "@/lib/agentSpec";

export const runtime = "nodejs";

/**
 * The compatibility contract, as JSON.
 *
 * Public and unsigned on purpose: an agent needs to read this BEFORE it has an
 * identity, in the same way it needs the catalog before it has credentials.
 * Requiring a signature to learn how to sign would be a closed loop.
 *
 * Contains no secret and no policy configuration — it says how to talk to this
 * merchant, never how the merchant will judge what you say.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const db = createAdminClient();
  const merchant = await getMerchantBySlug(db, slug);
  if (!merchant) {
    return NextResponse.json({ error: "unknown_merchant", slug }, { status: 404 });
  }
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  return NextResponse.json(buildAgentSpec(merchant, baseUrl));
}
