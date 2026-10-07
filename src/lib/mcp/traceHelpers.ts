import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { PolicyRule as EngineRule, EvaluationAggregates } from "@/lib/policy/types";
import type { CapParams, VelocityParams, PayoutBudgetParams } from "@/lib/policy/types";
import { computeTrustScore, TRUST_WINDOW_SIZE } from "@/lib/trust/score";
import type { Database, Decision, Json, TraceMode } from "@/types/db";

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
  customerId?: string,
  /** The payee a payout names, for `per_payee_per_day` caps. */
  payeeId?: string
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
    if (params.scope === "per_transaction" || params.currency !== currency) continue;
    // A price change is not money moving, so it never counts toward a daily
    // total even under a rule that names no action types.
    let capQuery = db
      .from("traces")
      .select("action_type, params")
      .eq("merchant_id", merchantId)
      .eq("mode", "enforce")
      .eq("decision", "allow")
      .neq("action_type", "price.change")
      .gte("created_at", todayStart.toISOString());
    // per_day is per agent (the original meaning); the other two scopes are
    // deliberately wider than one agent.
    if (params.scope === "per_day") capQuery = capQuery.eq("agent_id", agentId);
    if (params.scope === "per_payee_per_day") {
      // No payee on this action means there is nothing for the cap to count
      // against, the same reasoning as the per-customer velocity scope.
      if (!payeeId) {
        dailyAmountSoFar[rule.id] = 0;
        continue;
      }
      capQuery = capQuery.eq("params->>payeeId", payeeId);
    }
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

  // Payout budgets read the ledger rather than the traces: a payout that was
  // escalated and later approved is real money out and only the ledger knows it.
  const payoutBudget: Record<string, { spent: number; revenue: number }> = {};
  for (const rule of rules.filter((r) => r.type === "payout_budget")) {
    const params = rule.params as PayoutBudgetParams;
    if (params.currency !== currency) continue;
    const since = new Date(Date.now() - (params.period_days ?? 7) * 86_400_000).toISOString();
    const [paid, sold] = await Promise.all([
      db.from("payouts").select("amount_paise").eq("merchant_id", merchantId).in("status", ["queued", "processing", "processed"]).gte("created_at", since),
      // Sample-store sales never fund payouts; see sample.ts.
      db
        .from("sales")
        .select("amount_paise")
        .eq("merchant_id", merchantId)
        .gte("captured_at", since)
        .or("razorpay_payment_id.is.null,razorpay_payment_id.not.like.sample_%"),
    ]);
    assertNoSupabaseError(paid.error);
    assertNoSupabaseError(sold.error);
    payoutBudget[rule.id] = {
      spent: (paid.data ?? []).reduce((n, r) => n + Number(r.amount_paise), 0),
      revenue: (sold.data ?? []).reduce((n, r) => n + Number(r.amount_paise), 0),
    };
  }

  return { velocityCounts, dailyAmountSoFar, payoutBudget };
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
 * The per-agent facts the wall reads, in one round trip.
 *
 * Kept together because they are fetched at the same moment for the same
 * decision, and several queries where one will do is several chances for them to
 * disagree about which agent they are describing.
 *
 * The three-state return for scope is load-bearing. `undefined` means "no agent
 * row" -- the engine then skips the rule rather than treating the absence as
 * permission. `null` means the row exists and is explicitly unscoped. Mapping a
 * missing row to `null` would turn "we could not find this agent" into "this
 * agent may buy anything", which is the wrong direction for a failure in the
 * money path.
 */
export async function getAgentPolicyFacts(agentId: string): Promise<{
  trustScore?: number;
  catalogScope?: string[] | null;
  status?: Database["public"]["Tables"]["agents"]["Row"]["status"];
  retired?: boolean;
  kind?: Database["public"]["Tables"]["agents"]["Row"]["kind"];
}> {
  const db = createAdminClient();
  const { data, error } = await db
    .from("agents")
    .select("trust_score, catalog_scope, status, retired, kind")
    .eq("id", agentId)
    .maybeSingle();
  // Fail closed. Without this row the paused flag, the in-house role limits and
  // dry-run would all read as "not set" and every protection keyed on them would
  // quietly switch off. A request that cannot establish who is asking is refused.
  if (error) throw new Error(`Could not read the acting agent: ${error.message}`);
  if (!data) throw new Error("Unknown agent.");
  return { trustScore: data.trust_score, catalogScope: data.catalog_scope, status: data.status, retired: data.retired, kind: data.kind };
}

export interface InsertTraceInput {
  /** Supplied when the caller needs the id before the money moves (it is the
   *  payout's idempotency key). */
  id?: string;
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
      ...(input.id ? { id: input.id } : {}),
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

/** Records what happened after the wall said yes. The trace is written BEFORE
 *  the money moves, so a crash between the two leaves a record of an allowed
 *  action rather than money gone with no trace of why. */
export async function updateTraceOutcome(
  merchantId: string,
  traceId: string,
  patch: { razorpayResponse: Json | null; reasoning?: string }
) {
  const db = createAdminClient();
  const { error } = await db
    .from("traces")
    .update({
      razorpay_response: patch.razorpayResponse,
      ...(patch.reasoning ? { reasoning: patch.reasoning } : {}),
    })
    .eq("id", traceId)
    .eq("merchant_id", merchantId);
  assertNoSupabaseError(error);
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
