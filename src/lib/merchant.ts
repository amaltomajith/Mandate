import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireDashboardUser } from "@/lib/actions/authGuard";
import { applySeedRules } from "@/lib/demo/seedData";
import { applySeedProducts } from "@/lib/demo/catalog";
import type { Merchant } from "@/types/db";

/**
 * Which merchant's data a request is allowed to touch.
 *
 * There are two ways in, and they resolve the tenant differently on purpose.
 *
 * A human arrives through Clerk, and the merchant is looked up by their Clerk
 * user id. A new user gets a new merchant, seeded with the default policy rules
 * and catalog, so their dashboard is a working shop with no activity in it
 * rather than an empty page where nothing can happen.
 *
 * An agent arrives through MCP, and the merchant is read off the agent row that
 * the Ed25519 signature already proved. That is the important half: the tenant
 * comes from cryptography, not from a field in the request body. An agent
 * cannot name a merchant, so it cannot name someone else's.
 *
 * Nothing here trusts a merchant id passed in from outside, and there is no
 * function that takes one.
 */

/** Turns a display name into a URL-safe slug, with a short random suffix so two
 *  merchants called "My Shop" cannot collide on the unique index. */
function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const suffix = Math.random().toString(36).slice(2, 8);
  return base ? `${base}-${suffix}` : `merchant-${suffix}`;
}

/**
 * The one-time claim of the pre-tenancy data.
 *
 * Migration 0010 put everything that existed into a merchant with slug `demo`
 * and left `clerk_user_id` null. Handing that to whoever signs in first would
 * mean a stranger cloning this repo and signing into a deployment inherits the
 * operator's traces, rules and agents — so it does not happen unless the person
 * running the instance explicitly turns it on.
 *
 * Set MANDATE_CLAIM_DEMO_MERCHANT=true, sign in once, and the demo merchant is
 * yours. Then remove the variable. It is off by default, and it can only ever
 * fire once, because after the claim there is no unclaimed merchant left.
 */
async function tryClaimDemoMerchant(db: SupabaseClient, clerkUserId: string): Promise<Merchant | null> {
  if (process.env.MANDATE_CLAIM_DEMO_MERCHANT !== "true") return null;

  const { data, error } = await db
    .from("merchants")
    .update({ clerk_user_id: clerkUserId })
    .is("clerk_user_id", null)
    .eq("slug", "demo")
    .select()
    .maybeSingle();
  if (error) {
    console.warn("[merchant] demo claim failed:", error.message);
    return null;
  }
  if (data) {
    console.warn(
      `[merchant] Clerk user ${clerkUserId} claimed the demo merchant. ` +
        "Remove MANDATE_CLAIM_DEMO_MERCHANT from the environment now — it has done its job."
    );
  }
  return data ?? null;
}

async function provisionMerchant(db: SupabaseClient, clerkUserId: string, email: string): Promise<Merchant> {
  const name = email.includes("@") ? `${email.split("@")[0]}'s storefront` : "New storefront";

  const { data, error } = await db
    .from("merchants")
    .insert({ clerk_user_id: clerkUserId, name, slug: slugify(name) })
    .select()
    .single();
  if (error) throw new Error(`Could not create a merchant: ${error.message}`);

  // A merchant with no rules governs nothing and a merchant with no catalog has
  // nothing to sell, so a brand new account would render a dashboard where
  // every panel is empty and no action is possible. Seeding both is what makes
  // "new account" mean "no activity yet" rather than "nothing works".
  await applySeedRules(db, data.id);
  await applySeedProducts(db, data.id);
  return data;
}

/**
 * The signed-in user's merchant, created on first sight.
 *
 * Every dashboard read and every server action goes through this. It throws
 * rather than returning null when nobody is signed in, so a caller that forgets
 * to check cannot accidentally run unscoped.
 */
export async function getCurrentMerchant(): Promise<Merchant> {
  const user = await requireDashboardUser();
  const db = createAdminClient();

  const { data: existing, error } = await db
    .from("merchants")
    .select("*")
    .eq("clerk_user_id", user.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (existing) return existing;

  const claimed = await tryClaimDemoMerchant(db, user.id);
  if (claimed) return claimed;

  return provisionMerchant(db, user.id, user.email);
}

/**
 * The merchant an agent belongs to.
 *
 * Called only with an agent id that came out of Web Bot Auth signature
 * verification, never from request content. Throws if the agent has no row —
 * an unattributable action must not fall back to a default tenant, because the
 * only safe thing to do with an action whose owner is unknown is refuse it.
 */
export async function getMerchantIdForAgent(db: SupabaseClient, agentId: string): Promise<string> {
  const { data, error } = await db.from("agents").select("merchant_id").eq("id", agentId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`Unknown agent ${agentId} — cannot resolve a merchant.`);
  return data.merchant_id;
}

/** Public lookup for the unauthenticated storefront endpoints. Returns null
 *  rather than throwing: an unknown slug is a 404, not a server error. */
export async function getMerchantBySlug(db: SupabaseClient, slug: string): Promise<Merchant | null> {
  const { data } = await db.from("merchants").select("*").eq("slug", slug).maybeSingle();
  return data ?? null;
}
