import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Dashboard reads go through the service-role client (Clerk gates the routes;
 * see HANDOVER.md §5b). Supabase-js doesn't throw on a failed query — it
 * returns `{ data: null, error }` — so without checking `error` explicitly,
 * a real failure (e.g. a network/TLS problem between this server and
 * Supabase) silently renders as "no data yet" instead of a visible error.
 * That's exactly what happened once already: the banner showed 0/3 done
 * after a TLS interception issue broke every query, and nothing said why.
 */

interface SupabaseResult<T> {
  data: T | null;
  error: { message: string } | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Two known-transient failure shapes, retried; everything else still fails
 * immediately, on the first try, same as before:
 *
 * 1. Supabase's newer `sb_secret_...` key format mints a fresh internal JWT
 *    per request at the gateway in front of PostgREST; a clock disagreement
 *    between whichever internal service minted it and whichever verified it
 *    surfaces as `"JWT issued at future"` — confirmed (via a direct
 *    out-of-band probe against the same credentials, moments after hitting
 *    it) to be a transient upstream hiccup, not a real credentials/config
 *    problem here.
 * 2. A raw network/TLS exception below Supabase's own layer — surfaces as
 *    `"TypeError: fetch failed"` (undici's generic wrapper) with no `cause`
 *    Supabase-js preserves. Reproduced directly against this exact project:
 *    a bare request intermittently fails the TLS handshake and succeeds on
 *    the very next attempt, no config change involved — a one-off network
 *    blip, not a broken project. Distinct from #1's message shape, so it
 *    needed its own check rather than a broader regex on the same pattern.
 */
function isTransientJwtClockError(error: { message: string }): boolean {
  return /jwt/i.test(error.message) && /future|clock skew/i.test(error.message);
}

function isTransientNetworkError(error: { message: string }): boolean {
  return /fetch failed|econnreset|etimedout|enotfound|socket hang up/i.test(error.message);
}

async function withRetry<T>(query: () => PromiseLike<SupabaseResult<T>>, attempts = 3): Promise<SupabaseResult<T>> {
  let result = await query();
  for (
    let attempt = 1;
    attempt < attempts && result.error && (isTransientJwtClockError(result.error) || isTransientNetworkError(result.error));
    attempt++
  ) {
    await sleep(300 * attempt);
    result = await query();
  }
  return result;
}

export async function getDashboardData() {
  const supabase = createAdminClient();

  const [agents, rules, traces, escalations, alerts, mandates, customers] = await Promise.all([
    withRetry(() => supabase.from("agents").select("*").order("trust_score", { ascending: false })),
    withRetry(() => supabase.from("policy_rules").select("*").order("created_at", { ascending: false })),
    withRetry(() => supabase.from("traces").select("*").order("created_at", { ascending: false }).limit(300)),
    withRetry(() => supabase.from("escalations").select("*").order("created_at", { ascending: false }).limit(50)),
    withRetry(() => supabase.from("alerts").select("*").order("created_at", { ascending: false }).limit(50)),
    withRetry(() => supabase.from("mandates").select("*").order("created_at", { ascending: false })),
    withRetry(() => supabase.from("customers").select("*").order("created_at", { ascending: false })),
  ]);

  const errors = [agents, rules, traces, escalations, alerts, mandates, customers]
    .map((r) => r.error)
    .filter((e): e is NonNullable<typeof e> => e !== null);

  if (errors.length > 0) {
    for (const e of errors) {
      // supabase-js flattens a raw network/TLS exception down to just
      // `{ message }` — the underlying reason (ECONNREFUSED, a cert error,
      // ENOTFOUND, ...) normally lives on the original error's `.cause`, but
      // gets dropped in that flattening. Logging it separately when present
      // is the difference between "TypeError: fetch failed" (tells you
      // nothing) and the actual OS-level reason underneath it.
      const cause = (e as { cause?: unknown }).cause;
      console.error("[dashboardData] Supabase query failed:", e.message, cause ? { cause } : e);
    }
  }

  return {
    agents: agents.data ?? [],
    rules: rules.data ?? [],
    traces: traces.data ?? [],
    escalations: escalations.data ?? [],
    alerts: alerts.data ?? [],
    mandates: mandates.data ?? [],
    customers: customers.data ?? [],
    loadError: errors[0]?.message ?? null,
  };
}

export type DashboardData = ReturnType<typeof getDashboardData> extends Promise<infer T> ? T : never;
