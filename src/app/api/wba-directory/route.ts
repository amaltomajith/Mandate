import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * Public key directory — the "operator-published keys" half of Web Bot Auth.
 * Mirrors `agents.public_key` for anything that wants to verify Mandate agent
 * signatures independently. Rewritten to /.well-known/http-message-signatures-directory
 * (see next.config.ts) to match the path shape real Web Bot Auth deployments use.
 */
export async function GET() {
  const db = createAdminClient();
  const { data, error } = await db.from("agents").select("id, name, public_key, key_algorithm, key_registered_at");
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
