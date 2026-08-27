"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireDashboardUser } from "./authGuard";

const PALETTE = ["#4f9dff", "#a78bfa", "#34d399", "#f5b342", "#f87171", "#22d3ee", "#fb923c"];

export interface CreateDomainInput {
  name: string;
  description?: string;
  matchActionTypes: string[];
  matchCategories: string[];
}

/** A merchant defining a new policy domain — the "drag a new node onto the
 *  canvas" moment. Positioned near the origin with a small random offset so
 *  several created in a row don't stack exactly on top of each other; the
 *  merchant drags it wherever from there (see moveDomain). */
export async function createDomain(input: CreateDomainInput) {
  await requireDashboardUser();
  const db = createAdminClient();

  const name = input.name.trim();
  if (!name) throw new Error("A domain needs a name.");

  const { count } = await db.from("policy_domains").select("id", { count: "exact", head: true });
  const color = PALETTE[(count ?? 0) % PALETTE.length];

  const { error } = await db.from("policy_domains").insert({
    name,
    description: input.description?.trim() || null,
    match_action_types: input.matchActionTypes,
    match_categories: input.matchCategories,
    position_x: 40 + Math.random() * 200,
    position_y: 40 + Math.random() * 120,
    color,
  });
  if (error) throw error;
  revalidatePath("/dashboard");
}

export async function updateDomainRouting(
  domainId: string,
  fields: { name?: string; description?: string; matchActionTypes?: string[]; matchCategories?: string[] }
) {
  await requireDashboardUser();
  const db = createAdminClient();

  const update: {
    name?: string;
    description?: string | null;
    match_action_types?: string[];
    match_categories?: string[];
  } = {};
  if (fields.name !== undefined) update.name = fields.name.trim();
  if (fields.description !== undefined) update.description = fields.description.trim() || null;
  if (fields.matchActionTypes !== undefined) update.match_action_types = fields.matchActionTypes;
  if (fields.matchCategories !== undefined) update.match_categories = fields.matchCategories;

  const { error } = await db.from("policy_domains").update(update).eq("id", domainId);
  if (error) throw error;
  revalidatePath("/dashboard");
}

/** Persists a drag on the canvas. Called on drop, not per pointer-move, so
 *  dragging doesn't spam server actions — see PolicyDomainsCanvas.tsx. */
export async function moveDomain(domainId: string, x: number, y: number) {
  await requireDashboardUser();
  const db = createAdminClient();
  const { error } = await db.from("policy_domains").update({ position_x: x, position_y: y }).eq("id", domainId);
  if (error) throw error;
}

/** Only allowed for a domain with no rules attached and that isn't the
 *  catch-all default — same "don't delete history out from under an
 *  explanation" reasoning as deletePolicyRule, plus a domain with zero rules
 *  can't have fired on anything either. */
export async function deleteDomain(domainId: string) {
  await requireDashboardUser();
  const db = createAdminClient();

  const { data: domain, error: domainError } = await db.from("policy_domains").select("is_default").eq("id", domainId).single();
  if (domainError) throw domainError;
  if (domain.is_default) throw new Error("The default domain can't be deleted — every action needs somewhere to land.");

  const { count, error: countError } = await db
    .from("policy_rules")
    .select("id", { count: "exact", head: true })
    .eq("domain_id", domainId);
  if (countError) throw countError;
  if (count && count > 0) {
    throw new Error(`This domain has ${count} rule(s) attached — reassign or delete those first.`);
  }

  const { error } = await db.from("policy_domains").delete().eq("id", domainId);
  if (error) throw error;
  revalidatePath("/dashboard");
}
