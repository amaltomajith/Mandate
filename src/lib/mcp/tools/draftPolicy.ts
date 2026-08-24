import "server-only";
import { Type } from "@google/genai";
import { getGemini, GEMINI_MODEL } from "@/lib/gemini/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { evaluatePolicy } from "@/lib/policy/engine";
import { getActiveRules } from "@/lib/mcp/traceHelpers";
import type { PolicyRuleType } from "@/types/db";
import type { Json } from "@/types/db";

const DRAFT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    type: { type: Type.STRING, enum: ["cap", "velocity", "category_block", "step_up"] },
    name: { type: Type.STRING },
    rationale: { type: Type.STRING },
    cap: {
      type: Type.OBJECT,
      nullable: true,
      properties: {
        max_amount: { type: Type.NUMBER },
        currency: { type: Type.STRING },
        scope: { type: Type.STRING, enum: ["per_transaction", "per_day"] },
      },
    },
    velocity: {
      type: Type.OBJECT,
      nullable: true,
      properties: {
        max_count: { type: Type.INTEGER },
        window_seconds: { type: Type.INTEGER },
        scope: { type: Type.STRING, enum: ["per_agent", "per_customer"] },
      },
    },
    category_block: {
      type: Type.OBJECT,
      nullable: true,
      properties: { categories: { type: Type.ARRAY, items: { type: Type.STRING } } },
    },
    step_up: {
      type: Type.OBJECT,
      nullable: true,
      properties: {
        threshold_amount: { type: Type.NUMBER },
        currency: { type: Type.STRING },
      },
    },
  },
  required: ["type", "name", "rationale"],
};

interface DraftShape {
  type: PolicyRuleType;
  name: string;
  rationale: string;
  cap?: { max_amount: number; currency: string; scope: "per_transaction" | "per_day" };
  velocity?: { max_count: number; window_seconds: number; scope: "per_agent" | "per_customer" };
  category_block?: { categories: string[] };
  step_up?: { threshold_amount: number; currency: string };
}

export interface DraftPolicyResult {
  ruleId: string;
  type: PolicyRuleType;
  name: string;
  rationale: string;
  params: Json;
  conflictsWith: { id: string; name: string; type: string }[];
  backtest: { tracesEvaluated: number; wouldHaveChangedDecision: number };
}

/**
 * NL -> structured rule -> auto-backtest, always landing as `pending_review`.
 * Nothing this produces ever becomes `active` on its own — see HANDOVER.md
 * "human-in-the-loop gate" for why that's a hard requirement, not a nicety.
 */
export async function draftPolicy(
  text: string,
  source: "human" | "horizon",
  sourceLabel?: string
): Promise<DraftPolicyResult> {
  const ai = getGemini();
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: `You turn plain-language policy requests or regulatory notices into one structured spend-control rule for a payments control plane. Read the input and produce exactly one rule of type "cap" (a spend ceiling), "velocity" (a rate limit), "category_block" (blocks a category outright), or "step_up" (requires human approval above a threshold). Fill in only the object matching the chosen "type" (cap/velocity/category_block/step_up) with realistic numbers inferred from the text; leave the others out. Amounts are in paise (INR smallest unit) unless the text clearly implies another currency.

Input:
${text}`,
    config: {
      responseMimeType: "application/json",
      responseSchema: DRAFT_SCHEMA,
    },
  });

  const draft = JSON.parse(response.text ?? "{}") as DraftShape;
  const params = draft[draft.type] ?? {};

  const db = createAdminClient();
  const existingRules = await getActiveRules();
  const conflictsWith = existingRules
    .filter((r) => r.type === draft.type)
    .map((r) => ({ id: r.id, name: r.name, type: r.type }));

  const { data: inserted, error } = await db
    .from("policy_rules")
    .insert({
      type: draft.type,
      name: draft.name,
      params: params as unknown as Json,
      status: "pending_review",
      source,
      rationale: sourceLabel ? `${draft.rationale}\n\nSource: ${sourceLabel}` : draft.rationale,
    })
    .select()
    .single();
  if (error) throw error;

  // Backtest: replay the candidate rule (alone) against recent enforce traces and
  // count how many would have gotten a different decision than they actually did.
  const { data: recentTraces, error: tracesError } = await db
    .from("traces")
    .select("id, action_type, params, decision, agent_id")
    .eq("mode", "enforce")
    .order("created_at", { ascending: false })
    .limit(50);
  if (tracesError) throw tracesError;

  let wouldHaveChangedDecision = 0;
  for (const t of recentTraces ?? []) {
    const p = t.params as { amount?: number; currency?: string; category?: string } | null;
    if (!p?.amount || !p?.currency) continue;
    const candidateMatch = evaluatePolicy(
      {
        actionType: t.action_type,
        amount: p.amount,
        currency: p.currency,
        category: p.category,
        agentId: t.agent_id ?? "",
      },
      [{ id: inserted.id, type: inserted.type, name: inserted.name, params: inserted.params }],
      { velocityCounts: {}, dailyAmountSoFar: {} }
    );
    const candidateDecision = candidateMatch?.decision ?? "allow";
    if (candidateDecision !== t.decision) wouldHaveChangedDecision += 1;
  }

  return {
    ruleId: inserted.id,
    type: inserted.type,
    name: inserted.name,
    rationale: inserted.rationale ?? draft.rationale,
    params: inserted.params,
    conflictsWith,
    backtest: {
      tracesEvaluated: recentTraces?.length ?? 0,
      wouldHaveChangedDecision,
    },
  };
}
