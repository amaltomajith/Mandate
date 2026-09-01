import { z } from "zod";
import { getLLM } from "@/lib/llm/client";
import type { PolicyRule } from "@/types/db";

/**
 * The LLM half of policy auditing — deliberately kept separate from
 * audit.ts's deterministic checker and never labeled with the same
 * confidence. audit.ts finds things that are *provably* true (a rule that
 * mathematically can never fire); this finds things that are a *judgment
 * call* a deterministic checker structurally can't make (missing coverage,
 * a threshold that looks off relative to the rest of the rule set). Surfaced
 * in the UI as "worth reviewing," never asserted as fact — max severity is
 * "warning," never "critical."
 *
 * Grounded against hallucination the same way draft_policy and crossSell are:
 * the model can only reference rules by their exact existing name, and any
 * name that doesn't resolve to a real rule in the input set is dropped
 * rather than trusted.
 */

export interface SemanticIssue {
  id: string;
  severity: "warning" | "info";
  title: string;
  explanation: string;
  affectedRuleIds: string[];
}

const SemanticIssueSchema = z.object({
  title: z.string(),
  explanation: z.string(),
  severity: z.enum(["warning", "info"]),
  affected_rule_names: z.array(z.string()).default([]),
});

const ResponseSchema = z.object({ issues: z.array(SemanticIssueSchema) });

const SYSTEM_PROMPT = `You are reviewing a merchant's active money-movement policy rules for a payments control plane, looking for coverage gaps or judgment-call risks — NOT logic errors, those are already checked separately by a deterministic tool. Examples of what's worth flagging: no cap configured at all, no rate limit configured, a step-up threshold that looks too high or too low relative to the caps already in place, an obviously-missing category given what's already blocked. Only flag genuine, specific concerns grounded in the actual rules given — never invent generic advice, and never flag something already caught by simple arithmetic (a rule that can never fire, a duplicate). If there's nothing worth flagging, return an empty issues array — that's a normal, good outcome, not a failure to find something. Respond with ONLY JSON shaped like {"issues": [{"title": string, "explanation": string, "severity": "warning" | "info", "affected_rule_names": string[]}]}. affected_rule_names must be exact rule names from the input, or an empty array if none apply specifically.`;

export async function runSemanticPolicyAudit(rules: PolicyRule[]): Promise<SemanticIssue[]> {
  const active = rules.filter((r) => r.status === "active");
  if (active.length === 0) return [];

  const input = active.map((r) => ({ name: r.name, type: r.type, params: r.params, rationale: r.rationale }));

  let raw: string;
  try {
    // every active rule: caps, thresholds, blocked categories
    const llm = await getLLM("internal");
    const response = await llm.client.chat.completions.create({
      model: llm.model,
      response_format: { type: "json_object" },
      temperature: 0.3,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(input) },
      ],
    });
    raw = response.choices[0]?.message?.content ?? "{}";
  } catch (err) {
    console.error("[semanticAudit] LLM call failed:", err);
    return [];
  }

  let parsed: z.infer<typeof ResponseSchema>;
  try {
    parsed = ResponseSchema.parse(JSON.parse(raw));
  } catch (err) {
    console.error("[semanticAudit] model returned an invalid shape:", err);
    return [];
  }

  const nameToId = new Map(active.map((r) => [r.name, r.id]));

  return parsed.issues.map((issue, i) => ({
    id: `semantic-${i}-${issue.title.slice(0, 24)}`,
    severity: issue.severity,
    title: issue.title,
    explanation: issue.explanation,
    affectedRuleIds: issue.affected_rule_names.map((n) => nameToId.get(n)).filter((id): id is string => Boolean(id)),
  }));
}
