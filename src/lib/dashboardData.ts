import "server-only";
import { createClient } from "@/lib/supabase/server";

/** Auth-scoped reads for the dashboard — goes through RLS (see migrations/0001_init.sql). */
export async function getDashboardData() {
  const supabase = await createClient();

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
