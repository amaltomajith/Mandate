import "server-only";
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/db";

let cached: SupabaseClient<Database> | null = null;

/**
 * Service-role client — bypasses RLS. Server-only (MCP tool implementations,
 * dashboard server actions for approvals). Never import this from client code.
 * Lazily constructed so `next build` doesn't fail when env vars aren't set yet.
 */
export function createAdminClient(): SupabaseClient<Database> {
  if (cached) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Supabase admin client requested but NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set."
    );
  }

  cached = createSupabaseClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return cached;
}
