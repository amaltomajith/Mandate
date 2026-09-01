import "server-only";
import { z } from "zod";
import { getLLM } from "@/lib/llm/client";
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
  type: z.enum(["cap", "velocity", "category_block", "step_up", "trust_floor"]),
  name: z.string(),
  rationale: z.string(),
  cap: z.object({ max_amount: z.number(), currency: z.string(), scope: z.enum(["per_transaction", "per_day"]) }).optional(),
  velocity: z.object({ max_count: z.number(), window_seconds: z.number(), scope: z.enum(["per_agent", "per_customer"]) }).optional(),
  category_block: z.object({ categories: z.array(z.string()) }).optional(),
  trust_floor: z.object({ min_score: z.number(), action: z.enum(["escalate", "block"]).optional() }).optional(),
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

/**
 * The type descriptions here name the *dimension* each rule controls, not the
 * verb a merchant might use about it, because the short version got that
 * wrong. "category_block (blocks a category outright)" put the word "block"
 * next to a rule type, and "Block any single order above 25,000 rupees" then
 * came back as a category_block on both models measured -- an identical
 * failure across a 2B local model and a 120B hosted one, which is the shape of
 * a prompt problem rather than a capability one.
 *
 * A merchant says "block", "stop", "don't allow", and "cap" interchangeably
 * about an amount ceiling. What separates the rule types is what they measure:
 * an amount, a count over time, a named category, a trust score. Saying so
 * explicitly, and saying which words do NOT decide it, is the fix.
 */
const SYSTEM_PROMPT = `You turn plain-language policy requests or regulatory notices into one structured spend-control rule for a payments control plane. Read the input and produce exactly one rule.

Choose the type by WHAT THE RULE MEASURES, not by which verb the request uses. Merchants say "block", "stop", "don't allow", "limit" and "cap" interchangeably; those words never decide the type on their own.

- "cap" — a money ceiling on an amount. Use this for any limit expressed in currency, including when the request says "block anything above X". Per transaction, or per day.
- "velocity" — a limit on HOW MANY actions within a time window. Use this whenever a count and a period both appear.
- "category_block" — refuses named product or merchant categories such as "gambling", "crypto", "alcohol". Only for named categories. NEVER for an amount, however the request is phrased.
- "step_up" — requires a human to approve above an amount. Use this when the request asks for approval, sign-off, review, or "check with me" rather than outright refusal.
- "trust_floor" — holds an agent whose trust score is below a minimum, regardless of amount.

Respond with ONLY a JSON object shaped like:

{
  "type": "cap" | "velocity" | "category_block" | "step_up" | "trust_floor",
  "name": string,
  "rationale": string,
  "cap": { "max_amount": number, "currency": string, "scope": "per_transaction" | "per_day" },
  "velocity": { "max_count": number, "window_seconds": number, "scope": "per_agent" | "per_customer" },
  "category_block": { "categories": string[] },
  "trust_floor": { "min_score": number, "action": "escalate" | "block" },
  "step_up": { "threshold_amount": number, "currency": string }
}

Only include the ONE key ("cap", "velocity", "category_block", "step_up", or "trust_floor") matching your chosen "type" — omit the others. Trust scores run 0-100 and every agent starts at 50. Fill in realistic numbers inferred from the text. Amounts are in paise (INR smallest unit) unless the text clearly implies another currency. Respond with the JSON object only, no other text.`;

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
  // policy text and the rule set it is drafted against
  const llm = await getLLM("internal");
  const response = await llm.client.chat.completions.create({
    model: llm.model,
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
