import type { SupabaseClient } from "@supabase/supabase-js";
import type { MerchantSettings } from "@/types/db";
import { evaluatePolicy } from "./engine";
import { guardrailRules } from "./guardrails";
import type { CapParams, EvaluationAggregates, PolicyRule, VelocityParams } from "./types";

/**
 * The policy time machine.
 *
 * Takes what really happened (the wall's recorded decisions) and asks what a
 * proposed policy would have decided instead, using the same pure evaluator the
 * live wall uses. Nothing is saved or sent; it only answers "if I change this,
 * what would have been different last month?".
 *
 * Two promises, and one limit stated out loud:
 *   - Totals build up as the day goes, per policy: a daily cap counts only what
 *     THAT policy would have allowed, so a stricter cap does not borrow the
 *     history of a looser one.
 *   - The replay is checked against reality: `fidelity` says how often replaying
 *     today's policy reproduces the decision that was actually made.
 *   - Rules that need facts the history does not hold (a payee's status then, a
 *     product's cost, the week's revenue, an agent's score at that moment) are NOT
 *     replayed, on either side, and are named in `notReplayed`. Guessing them
 *     would be a confident claim about something nobody knows.
 */

export type Verdict = "allow" | "block" | "escalate";

export interface PastAction {
  id: string;
  at: Date;
  actionType: string;
  amount: number;
  currency: string;
  category?: string;
  agentId: string;
  customerId?: string;
  payeeId?: string;
  /** What the wall actually decided at the time. */
  actual: string;
}

export interface Change {
  id: string;
  at: Date;
  actionType: string;
  amount: number;
  currency: string;
  from: Verdict;
  to: Verdict;
  actual: string;
  reasoning: string;
}

export interface Tally {
  allow: number;
  block: number;
  escalate: number;
  allowPaise: number;
  blockPaise: number;
  escalatePaise: number;
}

export interface ReplayResult {
  evaluated: number;
  current: Tally;
  draft: Tally;
  changed: Change[];
  /** The biggest changes by amount, for display. */
  top: Change[];
  transitions: Record<string, { count: number; valuePaise: number }>;
  fidelity: { matched: number; total: number };
  notReplayed: string[];
}

const REPLAYABLE = new Set<PolicyRule["type"]>(["category_block", "cap", "velocity", "step_up"]);
const TOP = 20;

const scopeOf = (r: PolicyRule): string[] | null => {
  const s = (r.params as { action_types?: unknown } | null)?.action_types;
  return Array.isArray(s) && s.length > 0 ? (s as string[]) : null;
};
const inScope = (r: PolicyRule, actionType: string) => {
  const s = scopeOf(r);
  return s ? s.includes(actionType) : actionType !== "price.change";
};
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const empty = (): Tally => ({ allow: 0, block: 0, escalate: 0, allowPaise: 0, blockPaise: 0, escalatePaise: 0 });

/** Runs one policy over the history, in order, with its own running totals. */
function run(history: PastAction[], rules: PolicyRule[]): { verdict: Verdict; reasoning: string }[] {
  const out: { verdict: Verdict; reasoning: string }[] = [];
  const allowed: PastAction[] = [];
  history.forEach((a, i) => {
    const velocityCounts: Record<string, number> = {};
    const dailyAmountSoFar: Record<string, number> = {};
    for (const r of rules) {
      if (r.type === "velocity") {
        const p = r.params as VelocityParams;
        const from = a.at.getTime() - p.window_seconds * 1000;
        const scope = scopeOf(r);
        velocityCounts[r.id] = history.slice(0, i).filter((h) => {
          if (h.at.getTime() < from) return false;
          if (scope && !scope.includes(h.actionType)) return false;
          if (p.scope === "per_customer") return !!a.customerId && h.customerId === a.customerId;
          return h.agentId === a.agentId;
        }).length;
      } else if (r.type === "cap") {
        const p = r.params as CapParams;
        if (p.scope === "per_transaction" || p.currency !== a.currency) continue;
        if (p.scope === "per_payee_per_day" && !a.payeeId) {
          dailyAmountSoFar[r.id] = 0;
          continue;
        }
        dailyAmountSoFar[r.id] = allowed
          .filter((h) => h.currency === p.currency && h.actionType !== "price.change" && sameDay(h.at, a.at) && inScope(r, h.actionType) && (p.scope === "per_day" ? h.agentId === a.agentId : p.scope === "per_payee_per_day" ? h.payeeId === a.payeeId : true))
          .reduce((n, h) => n + h.amount, 0);
      }
    }
    const aggregates: EvaluationAggregates = { velocityCounts, dailyAmountSoFar };
    const match = evaluatePolicy({ actionType: a.actionType, amount: a.amount, currency: a.currency, category: a.category, agentId: a.agentId, customerId: a.customerId }, rules, aggregates);
    const verdict: Verdict = match?.decision === "block" ? "block" : match?.decision === "escalate" ? "escalate" : "allow";
    if (verdict === "allow") allowed.push(a);
    out.push({ verdict, reasoning: match?.reasoning ?? "Nothing in the policy objects." });
  });
  return out;
}

function tally(vs: Verdict[], history: PastAction[]): Tally {
  const t = empty();
  vs.forEach((v, i) => {
    t[v]++;
    t[`${v}Paise` as "allowPaise" | "blockPaise" | "escalatePaise"] += history[i].amount;
  });
  return t;
}

export function replayPolicy(actions: PastAction[], current: PolicyRule[], draft: PolicyRule[], _days = 30): ReplayResult {
  void _days;
  const history = [...actions].sort((a, b) => a.at.getTime() - b.at.getTime());
  const notReplayed = [...new Set([...current, ...draft].filter((r) => !REPLAYABLE.has(r.type)).map((r) => r.name))];
  const cur = run(history, current.filter((r) => REPLAYABLE.has(r.type)));
  const dra = run(history, draft.filter((r) => REPLAYABLE.has(r.type)));

  const changed: Change[] = [];
  const transitions: ReplayResult["transitions"] = {};
  history.forEach((a, i) => {
    if (cur[i].verdict === dra[i].verdict) return;
    changed.push({ id: a.id, at: a.at, actionType: a.actionType, amount: a.amount, currency: a.currency, from: cur[i].verdict, to: dra[i].verdict, actual: a.actual, reasoning: dra[i].reasoning });
    const k = `${cur[i].verdict}>${dra[i].verdict}`;
    transitions[k] = { count: (transitions[k]?.count ?? 0) + 1, valuePaise: (transitions[k]?.valuePaise ?? 0) + a.amount };
  });

  return {
    evaluated: history.length,
    current: tally(cur.map((c) => c.verdict), history),
    draft: tally(dra.map((c) => c.verdict), history),
    changed,
    top: [...changed].sort((a, b) => b.amount - a.amount).slice(0, TOP),
    transitions,
    fidelity: { matched: history.filter((a, i) => a.actual === cur[i].verdict).length, total: history.length },
    notReplayed,
  };
}

/**
 * Today's active rules against the same rules with the guardrails swapped for ones
 * built from `draft` settings, over the last `days` of real decisions. Reads only.
 */
export async function replayGuardrails(db: SupabaseClient, merchantId: string, draft: MerchantSettings, days = 30): Promise<ReplayResult> {
  const { data: rules, error } = await db.from("policy_rules").select("id, type, name, params").eq("merchant_id", merchantId).eq("status", "active");
  if (error) throw new Error(error.message);
  const current = (rules ?? []) as PolicyRule[];
  const idByKey = new Map<string, string>();
  for (const r of current) {
    const key = (r.params as { key?: string; managed?: string } | null)?.key;
    if ((r.params as { managed?: string } | null)?.managed === "guardrails" && key) idByKey.set(key, r.id);
  }
  const drafted: PolicyRule[] = [
    ...current.filter((r) => (r.params as { managed?: string } | null)?.managed !== "guardrails"),
    ...guardrailRules(draft).map((g) => ({ id: idByKey.get(g.key) ?? `draft:${g.key}`, type: g.type, name: g.name, params: g.params } as PolicyRule)),
  ];

  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data: traces, error: te } = await db
    .from("traces")
    .select("id, action_type, params, decision, agent_id, created_at")
    .eq("merchant_id", merchantId)
    .eq("mode", "enforce")
    .in("decision", ["allow", "block", "escalate"])
    .gte("created_at", since)
    .order("created_at", { ascending: true })
    .limit(2000);
  if (te) throw new Error(te.message);
  const actions: PastAction[] = [];
  for (const t of traces ?? []) {
    const p = t.params as { amount?: number; currency?: string; category?: string; customerId?: string; payeeId?: string } | null;
    if (!p || typeof p.amount !== "number" || typeof p.currency !== "string") continue;
    actions.push({ id: t.id, at: new Date(t.created_at), actionType: t.action_type, amount: p.amount, currency: p.currency, category: p.category, agentId: t.agent_id ?? "", customerId: p.customerId, payeeId: p.payeeId, actual: t.decision });
  }
  return replayPolicy(actions, current, drafted, days);
}
