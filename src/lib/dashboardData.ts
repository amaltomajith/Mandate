import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Dashboard reads now go through the service-role client rather than an
 * RLS-scoped one — Clerk gates access to these Server Components at the proxy
 * layer, so Supabase's own `authenticated`-role RLS policies are no longer the
 * access boundary for this app (they're vestigial but harmless; MCP writes
 * already used the service role). See HANDOVER.md "auth" section.
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

  return {
    agents: agents.data ?? [],
    rules: rules.data ?? [],
    traces: traces.data ?? [],
    escalations: escalations.data ?? [],
    alerts: alerts.data ?? [],
  };
}

export type DashboardData = ReturnType<typeof getDashboardData> extends Promise<infer T> ? T : never;
