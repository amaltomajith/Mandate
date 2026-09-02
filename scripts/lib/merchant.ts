import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The merchant a script operates on.
 *
 * Scripts run outside Clerk, so there is no signed-in user to resolve a tenant
 * from. They take one by slug instead — MANDATE_MERCHANT_SLUG, defaulting to
 * the `demo` merchant migration 0010 created. It throws on an unknown slug
 * rather than falling back to "the first one", because a maintenance script
 * silently operating on the wrong tenant is the worst possible failure mode
 * for this kind of tool.
 */
export async function merchantForScript(db: SupabaseClient): Promise<{ id: string; slug: string }> {
  const slug = process.env.MANDATE_MERCHANT_SLUG ?? "demo";
  const { data, error } = await db.from("merchants").select("id, slug").eq("slug", slug).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`No merchant with slug "${slug}". Set MANDATE_MERCHANT_SLUG, or run migration 0010.`);
  return data;
}
