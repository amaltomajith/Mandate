import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { PolicyRule as EngineRule, EvaluationAggregates } from "@/lib/policy/types";
import type { CapParams, VelocityParams } from "@/lib/policy/types";
import { computeTrustScore } from "@/lib/trust/score";
import type { Database, Decision, Json, TraceMode } from "@/types/db";

export async function getActiveRules(): Promise<EngineRule[]> {
  const db = createAdminClient();
  const { data, error } = await db
    .from("policy_rules")
    .select("id, type, name, params")
    .eq("status", "active");
  if (error) throw error;
  return data ?? [];
}

/** Pre-computes what the pure policy evaluator needs but can't fetch itself. */
export async function getAggregates(
  agentId: string,
  rules: EngineRule[],
  currency: string
): Promise<EvaluationAggregates> {
  const db = createAdminClient();
  const velocityCounts: Record<string, number> = {};
  const dailyAmountSoFar: Record<string, number> = {};

  const velocityRules = rules.filter((r) => r.type === "velocity");
  for (const rule of velocityRules) {
    const params = rule.params as VelocityParams;
    const since = new Date(Date.now() - params.window_seconds * 1000).toISOString();
    const { count, error } = await db
      .from("traces")
      .select("id", { count: "exact", head: true })
      .eq("agent_id", agentId)
      .eq("mode", "enforce")
      .gte("created_at", since);
    if (error) throw error;
    velocityCounts[rule.id] = count ?? 0;
  }

  const capRules = rules.filter((r) => r.type === "cap");
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  for (const rule of capRules) {
    const params = rule.params as CapParams;
    if (params.scope !== "per_day" || params.currency !== currency) continue;
    const { data, error } = await db
      .from("traces")
      .select("params")
      .eq("agent_id", agentId)
      .eq("mode", "enforce")
      .eq("decision", "allow")
      .gte("created_at", todayStart.toISOString());
    if (error) throw error;
    dailyAmountSoFar[rule.id] = (data ?? []).reduce((sum, row) => {
      const p = row.params as { amount?: number; currency?: string } | null;
      if (p?.currency !== currency) return sum;
      return sum + (p?.amount ?? 0);
    }, 0);
  }

  return { velocityCounts, dailyAmountSoFar };
}

export interface InsertTraceInput {
  parentTraceId?: string | null;
  mode: TraceMode;
  actionType: string;
  params: Json;
  agentId: string | null;
  decision: Decision;
  ruleFiredId?: string | null;
  reasoning?: string | null;
  razorpayResponse?: Json | null;
  illustrativeRiskScore?: number | null;
}

export async function insertTrace(input: InsertTraceInput) {
  const db = createAdminClient();
  const { data, error } = await db
    .from("traces")
    .insert({
      parent_trace_id: input.parentTraceId ?? null,
      mode: input.mode,
      action_type: input.actionType,
      params: input.params,
      agent_id: input.agentId,
      decision: input.decision,
      rule_fired_id: input.ruleFiredId ?? null,
      reasoning: input.reasoning ?? null,
      razorpay_response: input.razorpayResponse ?? null,
      illustrative_risk_score: input.illustrativeRiskScore ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function createEscalationForTrace(traceId: string) {
  const db = createAdminClient();
  const { error } = await db.from("escalations").insert({ trace_id: traceId });
  if (error) throw error;
}

export async function createAlert(
  traceId: string | null,
  severity: Database["public"]["Tables"]["alerts"]["Row"]["severity"],
  message: string
) {
  const db = createAdminClient();
  const { error } = await db.from("alerts").insert({ trace_id: traceId, severity, message });
  if (error) throw error;
}

/** Recomputes and persists an agent's trust score from its enforce-mode trace history. */
export async function recomputeTrust(agentId: string) {
  const db = createAdminClient();

  const [{ count: approvals }, { count: blocks }, { count: escalations }, { count: protocolRejects }, agentRow] =
    await Promise.all([
      db.from("traces").select("id", { count: "exact", head: true }).eq("agent_id", agentId).eq("mode", "enforce").eq("decision", "allow"),
      db.from("traces").select("id", { count: "exact", head: true }).eq("agent_id", agentId).eq("mode", "enforce").eq("decision", "block"),
      db.from("traces").select("id", { count: "exact", head: true }).eq("agent_id", agentId).eq("mode", "enforce").eq("decision", "escalate"),
      db.from("traces").select("id", { count: "exact", head: true }).eq("agent_id", agentId).eq("decision", "protocol_reject"),
      db.from("agents").select("created_at").eq("id", agentId).single(),
    ]);

  const accountAgeDays = agentRow.data
    ? (Date.now() - new Date(agentRow.data.created_at).getTime()) / (1000 * 60 * 60 * 24)
    : 0;

  const components = computeTrustScore({
    approvals: approvals ?? 0,
    blocks: blocks ?? 0,
    escalations: escalations ?? 0,
    protocolRejects: protocolRejects ?? 0,
    accountAgeDays,
  });

  const { error } = await db
    .from("agents")
    .update({ trust_score: components.score, trust_components: components as unknown as Json })
    .eq("id", agentId);
  if (error) throw error;

  return components;
}
