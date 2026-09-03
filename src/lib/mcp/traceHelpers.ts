import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { PolicyRule as EngineRule, EvaluationAggregates } from "@/lib/policy/types";
import type { CapParams, VelocityParams } from "@/lib/policy/types";
import { computeTrustScore, TRUST_WINDOW_SIZE } from "@/lib/trust/score";
import type { Database, Decision, Json, Mandate, TraceMode } from "@/types/db";

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

/** Mirrors `appliesTo` in the engine. A rule scoped to specific action types
 *  must have its aggregate scoped the same way, or a "50k/day of payment
 *  links" cap would be measured against every order the agent placed today
 *  and fire immediately. The engine decides *whether* a rule applies; this
 *  decides *what it counts*, and the two have to agree. */
function scopedActionTypes(rule: EngineRule): string[] | null {
  const scope = (rule.params as { action_types?: unknown } | null)?.action_types;
  return Array.isArray(scope) && scope.length > 0 ? (scope as string[]) : null;
}

export async function getActiveRules(merchantId: string): Promise<EngineRule[]> {
  const db = createAdminClient();
  const { data, error } = await db
    .from("policy_rules")
    .select("id, type, name, params")
    .eq("merchant_id", merchantId)
    .eq("status", "active");
  assertNoSupabaseError(error);
  return data ?? [];
}

/** Pre-computes what the pure policy evaluator needs but can't fetch itself:
 *  rolling counts for velocity rules and today's spend for per-day caps.
 *
 *  `customerId` is what makes a `scope: "per_customer"` velocity rule mean
 *  anything. That scope has been in the schema since the start, and
 *  `draft_policy` offers it to the model as a rule it can generate — but the
 *  count was only ever filtered by agent, so a per-customer rule behaved
 *  identically to a per-agent one and nothing said so. No active rule used it,
 *  so nothing was wrong in practice; it was a trapdoor waiting for the first
 *  merchant who wrote "don't contact the same customer twice a week". */
export async function getAggregates(
  merchantId: string,
  agentId: string,
  rules: EngineRule[],
  currency: string,
  customerId?: string
): Promise<EvaluationAggregates> {
  const db = createAdminClient();
  const velocityCounts: Record<string, number> = {};
  const dailyAmountSoFar: Record<string, number> = {};

  const velocityRules = rules.filter((r) => r.type === "velocity");
  for (const rule of velocityRules) {
    const params = rule.params as VelocityParams;
    const since = new Date(Date.now() - params.window_seconds * 1000).toISOString();

    // A per-customer rule counts what this customer has been subjected to,
    // across every agent — "don't hit this person repeatedly" is a fact about
    // the person, and scoping it to one agent would let a second identity
    // reset the count. A per-agent rule counts what this agent has done.
    // Scoped by merchant before anything else. Without it, one merchant's
    // traffic would consume another's rate budget -- and unlike a display bug,
    // that one silently changes whether money moves.
    let query = db
      .from("traces")
      .select("id")
      .eq("merchant_id", merchantId)
      .eq("mode", "enforce")
      .gte("created_at", since);
    const velocityScope = scopedActionTypes(rule);
    if (velocityScope) query = query.in("action_type", velocityScope);
    if (params.scope === "per_customer") {
      // Nothing to count against when the action names no customer: an
      // unattributed action cannot have hit anyone too often. Leaving the
      // filter off here would silently make it a per-agent rule again, which
      // is the exact bug this replaced.
      if (!customerId) {
        velocityCounts[rule.id] = 0;
        continue;
      }
      // customerId lives inside the jsonb params rather than a column. Traces
      // written before it was persisted have none, so they are invisible to
      // this count -- correct, since there is no way to know who they were for.
      query = query.eq("params->>customerId", customerId);
    } else {
      query = query.eq("agent_id", agentId);
    }

    const { data, error } = await query;
    assertNoSupabaseError(error);
    velocityCounts[rule.id] = (data ?? []).length;
  }

  const capRules = rules.filter((r) => r.type === "cap");
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  for (const rule of capRules) {
    const params = rule.params as CapParams;
    if (params.scope !== "per_day" || params.currency !== currency) continue;
    let capQuery = db
      .from("traces")
      .select("action_type, params")
      .eq("merchant_id", merchantId)
      .eq("agent_id", agentId)
      .eq("mode", "enforce")
      .eq("decision", "allow")
      .gte("created_at", todayStart.toISOString());
    const capScope = scopedActionTypes(rule);
    if (capScope) capQuery = capQuery.in("action_type", capScope);
    const { data, error } = await capQuery;
    assertNoSupabaseError(error);
    dailyAmountSoFar[rule.id] = (data ?? []).reduce((sum, row) => {
      const p = row.params as { amount?: number; currency?: string } | null;
      if (p?.currency !== currency) return sum;
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
  merchantId: string,
  agentId: string,
  customerId: string | null | undefined,
  razorpayRef: string,
  rawPayload: Json
): Promise<void> {
  if (!customerId) return;
  const db = createAdminClient();
  const { error } = await db.from("mandates").insert({
    merchant_id: merchantId,
    agent_id: agentId,
    customer_id: customerId,
    type: "upi_autopay",
    status: "active",
    razorpay_ref: razorpayRef,
    raw_payload: rawPayload,
  });
  assertNoSupabaseError(error);
}

/** Current trust score for an agent, for `trust_floor` rules. Returns
 *  undefined rather than a default if the agent can't be read — the evaluator
 *  skips trust rules on undefined, which fails open. That is the right
 *  direction here: a transient read failure should not start refusing an
 *  agent's traffic as though it had a bad reputation. */
export async function getAgentTrustScore(agentId: string): Promise<number | undefined> {
  const db = createAdminClient();
  const { data, error } = await db.from("agents").select("trust_score").eq("id", agentId).maybeSingle();
  if (error || !data) return undefined;
  return data.trust_score;
}

/**
 * The two per-agent facts the engine reads, in one round trip.
 *
 * Kept together because they are fetched at the same moment for the same
 * decision, and two queries where one will do is two chances for them to
 * disagree about which agent they are describing.
 *
 * The three-state return is load-bearing. `undefined` for scope means "no agent
 * row" -- the engine then skips the rule rather than treating the absence as
 * permission. `null` means the row exists and is explicitly unscoped. Mapping a
 * missing row to `null` would turn "we could not find this agent" into "this
 * agent may buy anything", which is the wrong direction for a failure in the
 * money path.
 */
export async function getAgentPolicyFacts(
  agentId: string
): Promise<{ trustScore?: number; catalogScope?: string[] | null }> {
  const db = createAdminClient();
  const { data, error } = await db
    .from("agents")
    .select("trust_score, catalog_scope")
    .eq("id", agentId)
    .maybeSingle();
  if (error || !data) return {};
  return { trustScore: data.trust_score, catalogScope: data.catalog_scope };
}

export interface InsertTraceInput {
  merchantId: string;
  parentTraceId?: string | null;
  mode: TraceMode;
  actionType: string;
  params: Json;
  agentId: string | null;
  decision: Decision;
  ruleFiredId?: string | null;
  reasoning?: string | null;
  razorpayResponse?: Json | null;
}

export async function insertTrace(input: InsertTraceInput) {
  const db = createAdminClient();
  const { data, error } = await db
    .from("traces")
    .insert({
      merchant_id: input.merchantId,
      parent_trace_id: input.parentTraceId ?? null,
      mode: input.mode,
      action_type: input.actionType,
      params: input.params,
      agent_id: input.agentId,
      decision: input.decision,
      rule_fired_id: input.ruleFiredId ?? null,
      reasoning: input.reasoning ?? null,
      razorpay_response: input.razorpayResponse ?? null,
    })
    .select()
    .single();
  assertNoSupabaseError(error);
  return data;
}

export async function createEscalationForTrace(merchantId: string, traceId: string) {
  const db = createAdminClient();
  const { error } = await db.from("escalations").insert({ merchant_id: merchantId, trace_id: traceId });
  assertNoSupabaseError(error);
}

export async function createAlert(
  merchantId: string,
  traceId: string | null,
  severity: Database["public"]["Tables"]["alerts"]["Row"]["severity"],
  message: string
) {
  const db = createAdminClient();
  const { error } = await db.from("alerts").insert({ merchant_id: merchantId, trace_id: traceId, severity, message });
  assertNoSupabaseError(error);
}

/** Recomputes and persists an agent's trust score from its enforce-mode trace
 *  history. `TRUST_WINDOW_SIZE` is imported rather than redeclared — see its
 *  doc comment in trust/score.ts for why that file owns it. */
export async function recomputeTrust(agentId: string) {
  const db = createAdminClient();

  // Fetched as rows rather than counted per decision type: counting would need
  // one query per type AND couldn't be limited to a window, since a count with
  // a limit still counts every matching row. Fifty decision strings is a
  // trivial payload.
  const [recent, agentRow] = await Promise.all([
    db
      .from("traces")
      .select("decision")
      .eq("agent_id", agentId)
      .eq("mode", "enforce")
      .order("created_at", { ascending: false })
      .limit(TRUST_WINDOW_SIZE),
    db.from("agents").select("created_at").eq("id", agentId).single(),
  ]);
  assertNoSupabaseError(recent.error);

  const decisions = recent.data ?? [];
  const approvals = decisions.filter((d) => d.decision === "allow").length;
  const blocks = decisions.filter((d) => d.decision === "block").length;
  const escalations = decisions.filter((d) => d.decision === "escalate").length;

  const accountAgeDays = agentRow.data
    ? (Date.now() - new Date(agentRow.data.created_at).getTime()) / (1000 * 60 * 60 * 24)
    : 0;

  const components = computeTrustScore({ approvals, blocks, escalations, accountAgeDays });

  const { error } = await db
    .from("agents")
    .update({ trust_score: components.score, trust_components: components as unknown as Json })
    .eq("id", agentId);
  assertNoSupabaseError(error);

  return components;
}
