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
 * Supabase's newer `sb_secret_...` key format mints a fresh internal JWT
 * per request at the gateway in front of PostgREST; a clock disagreement
 * between whichever internal service minted it and whichever verified it
 * surfaces as `"JWT issued at future"` — confirmed (via a direct out-of-band
 * probe against the same credentials, moments after hitting it) to be a
 * transient upstream hiccup, not a real credentials/config problem here.
 * Retried a few times with a short backoff so an isolated blip doesn't
 * surface as a broken dashboard; any other error still fails immediately,
 * on the first try, same as before.
 */
function isTransientJwtClockError(error: { message: string }): boolean {
  return /jwt/i.test(error.message) && /future|clock skew/i.test(error.message);
}

async function withRetry<T>(query: () => PromiseLike<SupabaseResult<T>>, attempts = 3): Promise<SupabaseResult<T>> {
  let result = await query();
  for (let attempt = 1; attempt < attempts && result.error && isTransientJwtClockError(result.error); attempt++) {
    await sleep(300 * attempt);
    result = await query();
  }
  return result;
}

export async function getDashboardData() {
  const supabase = createAdminClient();

  const [agents, rules, traces, escalations, alerts, mandates, customers, domains] = await Promise.all([
    withRetry(() => supabase.from("agents").select("*").order("trust_score", { ascending: false })),
    withRetry(() => supabase.from("policy_rules").select("*").order("created_at", { ascending: false })),
    withRetry(() => supabase.from("traces").select("*").order("created_at", { ascending: false }).limit(300)),
    withRetry(() => supabase.from("escalations").select("*").order("created_at", { ascending: false }).limit(50)),
    withRetry(() => supabase.from("alerts").select("*").order("created_at", { ascending: false }).limit(50)),
    withRetry(() => supabase.from("mandates").select("*").order("created_at", { ascending: false })),
    withRetry(() => supabase.from("customers").select("*").order("created_at", { ascending: false })),
    withRetry(() => supabase.from("policy_domains").select("*").order("created_at", { ascending: true })),
  ]);

  const errors = [agents, rules, traces, escalations, alerts, mandates, customers, domains]
    .map((r) => r.error)
    .filter((e): e is NonNullable<typeof e> => e !== null);

  if (errors.length > 0) {
    for (const e of errors) console.error("[dashboardData] Supabase query failed:", e.message, e);
  }

  return {
    agents: agents.data ?? [],
    rules: rules.data ?? [],
    traces: traces.data ?? [],
    escalations: escalations.data ?? [],
    alerts: alerts.data ?? [],
    mandates: mandates.data ?? [],
    customers: customers.data ?? [],
    domains: domains.data ?? [],
    loadError: errors[0]?.message ?? null,
  };
}

export type DashboardData = ReturnType<typeof getDashboardData> extends Promise<infer T> ? T : never;
