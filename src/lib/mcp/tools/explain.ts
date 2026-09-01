import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getLLM } from "@/lib/llm/client";

/**
 * Grounded explanation: the model is only ever shown the actual trace + rule that
 * fired (or "no rule fired") and asked to phrase it in plain language. It never
 * free-associates about a decision it wasn't given — the reasoning already lives
 * in `traces.reasoning`, this just makes it read naturally and mentions the graph
 * neighborhood (agent trust, parent/child trace) for context.
 */
/** `elaborated` says whether a model expanded the engine's own reasoning or
 *  the reasoning is being returned as-is. Callers that show this to a
 *  merchant should not present a deterministic sentence as a generated one. */
export async function explainTrace(
  traceId: string
): Promise<{ explanation: string; traceId: string; elaborated: boolean }> {
  const db = createAdminClient();

  const { data: trace, error } = await db.from("traces").select("*").eq("id", traceId).single();
  if (error || !trace) throw new Error(`Trace ${traceId} not found`);

  const [ruleResult, agentResult, childCountResult] = await Promise.all([
    trace.rule_fired_id
      ? db.from("policy_rules").select("name, type, params").eq("id", trace.rule_fired_id).maybeSingle()
      : Promise.resolve({ data: null }),
    trace.agent_id
      ? db.from("agents").select("name, trust_score").eq("id", trace.agent_id).maybeSingle()
      : Promise.resolve({ data: null }),
    db.from("traces").select("id", { count: "exact", head: true }).eq("parent_trace_id", traceId),
  ]);

  const grounding = {
    decision: trace.decision,
    mode: trace.mode,
    action_type: trace.action_type,
    params: trace.params,
    reasoning: trace.reasoning,
    rule_fired: ruleResult.data ?? null,
    agent: agentResult.data ?? null,
    forked_from: trace.parent_trace_id,
    branch_count: "count" in childCountResult ? (childCountResult.count ?? 0) : 0,
    created_at: trace.created_at,
  };

  const prompt = `You are explaining one automated decision made by Mandate, a merchant's policy control plane for agent-initiated money actions. Given this trace data (JSON), write a short (2-4 sentence) plain-language explanation of what happened and why, suitable for a merchant reading it in a dashboard. Be concrete: name the rule and the numbers involved. Do not invent facts not present in the data. Do not use markdown.

Trace data:
${JSON.stringify(grounding, null, 2)}`;

  // A trace's full params, including customerId, plus the rule that fired and
  // its thresholds. Classified internal: this is the merchant's configuration.
  //
  // Falls back to the engine's own reasoning rather than failing. That string
  // was written deterministically at decision time and is already the sentence
  // a merchant reads everywhere else in the dashboard -- the model's job here
  // is to expand it, not to supply it. So when there is no model, the honest
  // answer is the shorter one, not an error.
  let llm;
  try {
    llm = await getLLM("internal");
  } catch {
    return {
      explanation:
        trace.reasoning ??
        "No explanation is recorded for this decision.",
      traceId,
      elaborated: false,
    };
  }

  const response = await llm.client.chat.completions.create({
    model: llm.model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
  });

  return {
    explanation: response.choices[0]?.message?.content ?? trace.reasoning ?? "No explanation could be generated.",
    traceId,
    elaborated: true,
  };
}
