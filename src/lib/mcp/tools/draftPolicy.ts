import "server-only";
import { z } from "zod";
import { getLLM, LLM_MODEL } from "@/lib/llm/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { evaluatePolicy } from "@/lib/policy/engine";
import { getActiveRules } from "@/lib/mcp/traceHelpers";
import type { PolicyRuleType } from "@/types/db";
import type { Json } from "@/types/db";

// Groq's `json_schema` structured-output mode is model-gated (not guaranteed on
// every model); the broadly-supported `json_object` mode plus validating the
// result ourselves is more portable across whichever Groq model ends up
// configured, so validation happens here rather than being delegated to the API.
const DraftShape = z.object({
  type: z.enum(["cap", "velocity", "category_block", "step_up"]),
  name: z.string(),
  rationale: z.string(),
  cap: z.object({ max_amount: z.number(), currency: z.string(), scope: z.enum(["per_transaction", "per_day"]) }).optional(),
  velocity: z.object({ max_count: z.number(), window_seconds: z.number(), scope: z.enum(["per_agent", "per_customer"]) }).optional(),
  category_block: z.object({ categories: z.array(z.string()) }).optional(),
  step_up: z.object({ threshold_amount: z.number(), currency: z.string() }).optional(),
});
type DraftShape = z.infer<typeof DraftShape>;

export interface DraftPolicyResult {
  ruleId: string;
  type: PolicyRuleType;
  name: string;
  rationale: string;
  params: Json;
  conflictsWith: { id: string; name: string; type: string }[];
  backtest: { tracesEvaluated: number; wouldHaveChangedDecision: number };
}

const SYSTEM_PROMPT = `You turn plain-language policy requests or regulatory notices into one structured spend-control rule for a payments control plane. Read the input and produce exactly one rule of type "cap" (a spend ceiling), "velocity" (a rate limit), "category_block" (blocks a category outright), or "step_up" (requires human approval above a threshold). Respond with ONLY a JSON object shaped like:

{
  "type": "cap" | "velocity" | "category_block" | "step_up",
  "name": string,
  "rationale": string,
  "cap": { "max_amount": number, "currency": string, "scope": "per_transaction" | "per_day" },
  "velocity": { "max_count": number, "window_seconds": number, "scope": "per_agent" | "per_customer" },
  "category_block": { "categories": string[] },
  "step_up": { "threshold_amount": number, "currency": string }
}

Only include the ONE key ("cap", "velocity", "category_block", or "step_up") matching your chosen "type" — omit the other three. Fill in realistic numbers inferred from the text. Amounts are in paise (INR smallest unit) unless the text clearly implies another currency. Respond with the JSON object only, no other text.`;

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
  const llm = getLLM();
  const response = await llm.chat.completions.create({
    model: LLM_MODEL,
    response_format: { type: "json_object" },
    temperature: 0.2,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: text },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? "{}";
  let draft: DraftShape;
  try {
    draft = DraftShape.parse(JSON.parse(raw));
  } catch (err) {
    throw new Error(`draft_policy: model did not return a valid rule shape: ${err instanceof Error ? err.message : err}`);
  }

  const params = draft[draft.type];
  if (!params) throw new Error(`draft_policy: model chose type "${draft.type}" but didn't include its params object.`);

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
