import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getMerchantBySlug } from "@/lib/merchant";

export const runtime = "nodejs";

/**
 * Public key directory — the "operator-published keys" half of Web Bot Auth.
 * Mirrors `agents.public_key` for anything that wants to verify Mandate agent
 * signatures independently. Rewritten to /.well-known/http-message-signatures-directory
 * (see next.config.ts) to match the path shape real Web Bot Auth deployments use.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const db = createAdminClient();
  const merchant = await getMerchantBySlug(db, slug);
  if (!merchant) {
    return NextResponse.json({ error: "unknown_merchant", slug }, { status: 404 });
  }
  // One merchant's agents only. Publishing every tenant's keys from a single
  // directory would let anyone enumerate who else uses this deployment.
  const { data, error } = await db
    .from("agents")
    .select("id, name, public_key, key_algorithm, key_registered_at")
    .eq("merchant_id", merchant.id);
  if (error) {
    return NextResponse.json({ error: "directory_unavailable" }, { status: 503 });
  }

  return NextResponse.json({
    keys: (data ?? []).map((agent) => ({
      keyid: agent.id,
      name: agent.name,
      alg: agent.key_algorithm,
      publicKey: agent.public_key,
      encoding: "base64",
      registeredAt: agent.key_registered_at,
    })),
  });
}
