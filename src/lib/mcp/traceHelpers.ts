import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { PolicyRule as EngineRule, EvaluationAggregates } from "@/lib/policy/types";
import type { CapParams, VelocityParams } from "@/lib/policy/types";
import { matchesDomain } from "@/lib/policy/domains";
import { computeTrustScore } from "@/lib/trust/score";
import type { Database, Decision, Json, Mandate, PolicyDomain, TraceMode } from "@/types/db";

/**
 * A Supabase `PostgrestError` is a plain object, not an `Error` instance —
 * `throw error` on one worked fine for a dashboard server action (whose
 * callers already guard with `err instanceof Error ? err.message :
 * "Action failed."`), but an MCP tool handler's thrown error goes through
 * the SDK's own `error instanceof Error ? error.message : String(error)`
 * fallback, and `String()` on a plain object is the literal text
 * "[object Object]" — a real bug that surfaced as a genuinely useless error
 * message the first time a Supabase call inside a tool handler failed.
 */
function assertNoSupabaseError(error: { message: string } | null): asserts error is null {
  if (error) throw new Error(error.message);
}

export async function getActiveRules(): Promise<EngineRule[]> {
  const db = createAdminClient();
  const { data, error } = await db
    .from("policy_rules")
    .select("id, type, name, domain_id, params")
    .eq("status", "active");
  assertNoSupabaseError(error);
  return data ?? [];
}

/** Every merchant-defined policy domain — real rows, not a hardcoded list.
 *  See src/lib/policy/domains.ts for how an action resolves to one of these. */
export async function getActiveDomains(): Promise<PolicyDomain[]> {
  const db = createAdminClient();
  const { data, error } = await db.from("policy_domains").select("*");
  assertNoSupabaseError(error);
  return data ?? [];
}

/** Pre-computes what the pure policy evaluator needs but can't fetch itself.
 *  Scoped to the SAME resolved domain as the action being evaluated (see
 *  src/lib/policy/domains.ts) by filtering traces with `matchesDomain` in
 *  application code — domains route on action type OR category, and
 *  category lives inside a trace's `params` JSON, not an indexed column, so
 *  this can't be pushed down as a simple `.in()` filter. Without this scope,
 *  a mandate action would count toward a purchases-domain velocity limit
 *  and vice versa, which would make "independently governed domains" a lie. */
export async function getAggregates(
  agentId: string,
  rules: EngineRule[],
  currency: string,
  domain: PolicyDomain
): Promise<EvaluationAggregates> {
  const db = createAdminClient();
  const velocityCounts: Record<string, number> = {};
  const dailyAmountSoFar: Record<string, number> = {};

  const velocityRules = rules.filter((r) => r.type === "velocity");
  for (const rule of velocityRules) {
    const params = rule.params as VelocityParams;
    const since = new Date(Date.now() - params.window_seconds * 1000).toISOString();
    const { data, error } = await db
      .from("traces")
      .select("action_type, params")
      .eq("agent_id", agentId)
      .eq("mode", "enforce")
      .gte("created_at", since);
    assertNoSupabaseError(error);
    velocityCounts[rule.id] = (data ?? []).filter((t) => {
      const p = t.params as { category?: string } | null;
      return matchesDomain(t.action_type, p?.category, domain);
    }).length;
  }

  const capRules = rules.filter((r) => r.type === "cap");
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  for (const rule of capRules) {
    const params = rule.params as CapParams;
    if (params.scope !== "per_day" || params.currency !== currency) continue;
    const { data, error } = await db
      .from("traces")
      .select("action_type, params")
      .eq("agent_id", agentId)
      .eq("mode", "enforce")
      .eq("decision", "allow")
      .gte("created_at", todayStart.toISOString());
    assertNoSupabaseError(error);
    dailyAmountSoFar[rule.id] = (data ?? []).reduce((sum, row) => {
      const p = row.params as { amount?: number; currency?: string; category?: string } | null;
      if (p?.currency !== currency) return sum;
      if (!matchesDomain(row.action_type, p?.category, domain)) return sum;
      return sum + (p?.amount ?? 0);
    }, 0);
  }

  return { velocityCounts, dailyAmountSoFar };
}

export interface MandateGateResult {
  blocked: boolean;
  mandate: Mandate | null;
  reasoning: string | null;
}

/**
 * A mandate is a standing authorization for one agent to act on one
 * customer's behalf — the thing "Mandate" is named for. This is a separate,
 * more fundamental gate than the per-transaction policy engine: a merchant
 * revoking (or pausing) an agent's mandate must stop that agent cold on its
 * very next action, regardless of what any cap/velocity/category rule would
 * otherwise have allowed. Only ever checked for actions carrying a
 * `customerId` — an action with no customer to attribute a mandate to
 * simply isn't gated by one.
 */
export async function checkMandateGate(agentId: string, customerId: string): Promise<MandateGateResult> {
  const db = createAdminClient();
  const { data, error } = await db
    .from("mandates")
    .select("*")
    .eq("agent_id", agentId)
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  assertNoSupabaseError(error);

  if (!data || data.status === "active") return { blocked: false, mandate: data, reasoning: null };

  const reason =
    data.status === "revoked"
      ? "The merchant has revoked this agent's mandate for this customer — no further actions are authorized."
      : data.status === "paused"
        ? "The merchant has paused this agent's mandate for this customer — actions are on hold until it's resumed."
        : "This agent's mandate for this customer has expired.";

  return { blocked: true, mandate: data, reasoning: reason };
}

/** Called after a real `subscription.create` succeeds — this is what actually
 *  turns a Razorpay subscription into a Mandate row the merchant can see,
 *  pause, or revoke. Silently no-ops without a customerId: a subscription
 *  with nobody to attribute it to isn't a governable mandate. */
export async function recordMandateFromSubscription(
  agentId: string,
  customerId: string | null | undefined,
  razorpayRef: string,
  rawPayload: Json
): Promise<void> {
  if (!customerId) return;
  const db = createAdminClient();
  const { error } = await db.from("mandates").insert({
    agent_id: agentId,
    customer_id: customerId,
    type: "upi_autopay",
    status: "active",
    razorpay_ref: razorpayRef,
    raw_payload: rawPayload,
  });
  assertNoSupabaseError(error);
}

export interface InsertTraceInput {
  parentTraceId?: string | null;
  mode: TraceMode;
  actionType: string;
  params: Json;
  agentId: string | null;
  decision: Decision;
  ruleFiredId?: string | null;
  // Snapshotted once, here, at the moment a decision is made — never
  // recomputed later. See supabase/migrations/0005_traces_domain_snapshot.sql
  // for why: without this, editing a domain's routing after the fact would
  // silently reclassify every past transaction along with it.
  domainId?: string | null;
  reasoning?: string | null;
  razorpayResponse?: Json | null;
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
      domain_id: input.domainId ?? null,
      reasoning: input.reasoning ?? null,
      razorpay_response: input.razorpayResponse ?? null,
    })
    .select()
    .single();
  assertNoSupabaseError(error);
  return data;
}

export async function createEscalationForTrace(traceId: string) {
  const db = createAdminClient();
  const { error } = await db.from("escalations").insert({ trace_id: traceId });
  assertNoSupabaseError(error);
}

export async function createAlert(
  traceId: string | null,
  severity: Database["public"]["Tables"]["alerts"]["Row"]["severity"],
  message: string
) {
  const db = createAdminClient();
  const { error } = await db.from("alerts").insert({ trace_id: traceId, severity, message });
  assertNoSupabaseError(error);
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
  assertNoSupabaseError(error);

  return components;
}
