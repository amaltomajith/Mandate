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
export async function getDashboardData() {
  const supabase = createAdminClient();

  const [agents, rules, traces, escalations, alerts] = await Promise.all([
    supabase.from("agents").select("*").order("trust_score", { ascending: false }),
    supabase.from("policy_rules").select("*").order("created_at", { ascending: false }),
    supabase.from("traces").select("*").order("created_at", { ascending: false }).limit(300),
    supabase.from("escalations").select("*").order("created_at", { ascending: false }).limit(50),
    supabase.from("alerts").select("*").order("created_at", { ascending: false }).limit(50),
  ]);

  const errors = [agents, rules, traces, escalations, alerts]
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
    loadError: errors[0]?.message ?? null,
  };
}

export type DashboardData = ReturnType<typeof getDashboardData> extends Promise<infer T> ? T : never;
