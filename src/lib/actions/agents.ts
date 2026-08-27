"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireDashboardUser } from "./authGuard";
import { generateKeyPair } from "@/lib/webBotAuth/keys";

export interface RegisteredAgent {
  id: string;
  name: string;
  secretKeyBase64: string;
}

/**
 * The dashboard-native version of `scripts/gen-agent-key.ts` — same real
 * Ed25519 keypair, same guarantee (the secret half is returned to the
 * caller exactly once and never stored anywhere; only the public half goes
 * into `agents.public_key`). Closes the inconsistency the domains feature
 * surfaced: domains stopped being hardcoded and became dashboard-creatable,
 * but agents still required a terminal. A registered agent still needs its
 * own real MCP client to actually call in and sign requests — this creates
 * the identity, not a bot that uses it.
 */
export async function registerAgent(name: string, description?: string): Promise<RegisteredAgent> {
  await requireDashboardUser();

  const trimmedName = name.trim();
  if (!trimmedName) throw new Error("An agent needs a name.");

  const { secretKey, publicKey } = generateKeyPair();
  const db = createAdminClient();

  const { data, error } = await db
    .from("agents")
    .insert({ name: trimmedName, description: description?.trim() || null, public_key: publicKey })
    .select("id, name")
    .single();
  if (error) throw error;

  revalidatePath("/dashboard");
  return { id: data.id, name: data.name, secretKeyBase64: secretKey };
}
