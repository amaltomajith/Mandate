"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireDashboardUser } from "./authGuard";
import { getCurrentMerchant } from "@/lib/merchant";

/**
 * Every mutation here matches on merchant as well as id.
 *
 * A row id alone is not authorization. These are addressed by a uuid that came
 * from the page, and a uuid is unguessable in practice — but "in practice" is
 * not a security boundary, and the extra predicate costs nothing. With it, the
 * worst case for a forged id is that the update matches no rows.
 */

/** Reversible — an agent under a paused mandate is blocked until this
 *  merchant explicitly resumes it (see reactivateMandate). */
export async function pauseMandate(mandateId: string) {
  await requireDashboardUser();
  const merchant = await getCurrentMerchant();
  const db = createAdminClient();
  const { error } = await db.from("mandates").update({ status: "paused" }).eq("id", mandateId).eq("merchant_id", merchant.id);
  if (error) throw error;
  revalidatePath("/dashboard");
}

export async function reactivateMandate(mandateId: string) {
  await requireDashboardUser();
  const merchant = await getCurrentMerchant();
  const db = createAdminClient();
  const { error } = await db
    .from("mandates")
    .update({ status: "active" })
    .eq("id", mandateId)
    .eq("merchant_id", merchant.id)
    .eq("status", "paused");
  if (error) throw error;
  revalidatePath("/dashboard");
}

/** Deliberately terminal — unlike pause, a real UPI Autopay revocation isn't
 *  something a merchant undoes; the agent would need a fresh mandate. */
export async function revokeMandate(mandateId: string) {
  await requireDashboardUser();
  const merchant = await getCurrentMerchant();
  const db = createAdminClient();
  const { error } = await db.from("mandates").update({ status: "revoked" }).eq("id", mandateId).eq("merchant_id", merchant.id);
  if (error) throw error;
  revalidatePath("/dashboard");
}


export interface MandateActivity {
  mandateId: string;
  /** Enforce-mode actions this mandate stood behind: this agent, acting for
   *  this customer. Derived from traces, never stored — same rule every other
   *  panel follows, and a stored counter is a second source of truth that
   *  drifts the moment a write fails after the action happened. */
  actions: number;
  /** Value of the ones that were allowed. Escalated and blocked actions are
   *  counted above but not here: a mandate that authorized ten attempts and
   *  cleared two did both of those things, and collapsing them would hide
   *  which. */
  settledPaise: number;
  lastUsed: string | null;
}

/**
 * What each mandate has actually authorized.
 *
 * The panel was a list of permissions with no evidence any of them were ever
 * exercised — which is a strange thing for a control plane to show, because the
 * interesting question about a standing authorization is not that it exists but
 * what has happened under it. A mandate covering forty actions and one covering
 * none look identical without this, and they are not remotely the same risk.
 *
 * A trace belongs to a mandate when the agent and the customer both match.
 * `customerId` lives inside the jsonb params rather than a column, so traces
 * written before it was persisted are invisible here — correct, since there is
 * no way to know who they were for.
 */
export async function mandateActivity(): Promise<MandateActivity[]> {
  await requireDashboardUser();
  const merchant = await getCurrentMerchant();
  const db = createAdminClient();

  const [{ data: mandates }, { data: traces }] = await Promise.all([
    db.from("mandates").select("id, agent_id, customer_id").eq("merchant_id", merchant.id),
    db
      .from("traces")
      .select("agent_id, params, decision, created_at")
      .eq("merchant_id", merchant.id)
      .eq("mode", "enforce"),
  ]);

  return (mandates ?? []).map((m) => {
    let actions = 0;
    let settledPaise = 0;
    let lastUsed: string | null = null;

    for (const t of traces ?? []) {
      if (t.agent_id !== m.agent_id) continue;
      const p = t.params as { amount?: number; customerId?: string } | null;
      if (!p?.customerId || p.customerId !== m.customer_id) continue;
      actions += 1;
      if (t.decision === "allow" && typeof p.amount === "number") settledPaise += p.amount;
      if (!lastUsed || t.created_at > lastUsed) lastUsed = t.created_at;
    }

    return { mandateId: m.id, actions, settledPaise, lastUsed };
  });
}
