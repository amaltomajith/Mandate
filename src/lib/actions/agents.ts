"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireDashboardUser } from "./authGuard";
import { getCurrentMerchant } from "@/lib/merchant";

/**
 * Stopping an agent, and starting it again.
 *
 * The blunt instrument a merchant wants during an incident. Mandates are the
 * precise tool -- one agent, one customer, revocable -- and they are the wrong
 * shape when the answer is "this thing is misbehaving, make it stop". Without
 * this the only route was revoking every mandate one at a time, and revoke is
 * deliberately terminal, so the choice was between tedium and a decision that
 * could not be taken back.
 *
 * Reversible by design. Nothing here destroys anything: the agent keeps its
 * identity, its keypair, its history and its trust score, and resuming puts it
 * exactly back where it was.
 */

async function setStatus(agentId: string, status: "active" | "paused") {
  await requireDashboardUser();
  const merchant = await getCurrentMerchant();
  const db = createAdminClient();

  // Scoped by merchant as well as id. A row id is not authorization, and one
  // merchant must not be able to stop another's agent even by accident.
  const { error } = await db
    .from("agents")
    .update({ status })
    .eq("id", agentId)
    .eq("merchant_id", merchant.id);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

/** Takes effect on the agent's next request. Anything already in flight was
 *  already decided -- a pause stops what comes next, it does not reach back. */
export async function pauseAgent(agentId: string) {
  await setStatus(agentId, "paused");
}

export async function resumeAgent(agentId: string) {
  await setStatus(agentId, "active");
}
