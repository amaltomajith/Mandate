import { z } from "zod";
import { getLLM } from "@/lib/llm/client";
import type { PolicyRule } from "@/types/db";

/**
 * Turns a flagged policy issue (from audit.ts or semanticAudit.ts) into a
 * concrete proposed parameter change, not just a description of the
 * problem. Still human-approved: this only *proposes* — applying it is a
 * separate, explicit action (src/lib/actions/policy.ts's applyPolicyFix).
 *
 * Grounded the same way as draft_policy/crossSell: the model can only
 * propose a fix for a rule that's actually in the input set (matched by
 * exact name), anything else is dropped rather than trusted.
 */

export interface FixSuggestion {
  ruleId: string;
  ruleName: string;
  currentParams: Record<string, unknown>;
  proposedParams: Record<string, unknown>;
  rationale: string;
}

const FixSchema = z.object({
  fixes: z.array(
    z.object({
      rule_name: z.string(),
      proposed_params: z.record(z.string(), z.union([z.string(), z.number(), z.array(z.string())])),
      rationale: z.string(),
    })
  ),
});

const SYSTEM_PROMPT = `You are proposing a concrete fix for a specific problem found in a merchant's money-movement policy rules. You will be given the issue description and the full current definition (type + params) of each affected rule. Propose an updated params object for each affected rule that resolves the issue while changing as little as possible — only touch the fields that actually need to change, keep everything else (including currency and scope) as-is unless the issue explicitly requires changing it. Respond with ONLY JSON shaped like {"fixes": [{"rule_name": string, "proposed_params": object, "rationale": string}]}. rule_name must exactly match one of the provided rule names — never propose a fix for a rule that isn't in the input.`;

export async function suggestPolicyFix(
  issueTitle: string,
  issueExplanation: string,
  affectedRules: PolicyRule[]
): Promise<FixSuggestion[]> {
  if (affectedRules.length === 0) return [];

  const input = {
    issue: { title: issueTitle, explanation: issueExplanation },
    rules: affectedRules.map((r) => ({ name: r.name, type: r.type, params: r.params })),
  };

  let raw: string;
  try {
    // the full definition of the rules being changed
    const llm = await getLLM("internal");
    const response = await llm.client.chat.completions.create({
      model: llm.model,
      response_format: { type: "json_object" },
      temperature: 0.2,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(input) },
      ],
    });
    raw = response.choices[0]?.message?.content ?? "{}";
  } catch (err) {
    console.error("[suggestFix] LLM call failed:", err);
    return [];
  }

  let parsed: z.infer<typeof FixSchema>;
  try {
    parsed = FixSchema.parse(JSON.parse(raw));
  } catch (err) {
    console.error("[suggestFix] model returned an invalid shape:", err);
    return [];
  }

  const byName = new Map(affectedRules.map((r) => [r.name, r]));
  const suggestions: FixSuggestion[] = [];
  for (const fix of parsed.fixes) {
    const rule = byName.get(fix.rule_name);
    if (!rule) {
      console.error(`[suggestFix] model proposed a fix for unknown rule "${fix.rule_name}" — ignoring.`);
      continue;
    }
    suggestions.push({
      ruleId: rule.id,
      ruleName: rule.name,
      currentParams: rule.params as Record<string, unknown>,
      proposedParams: fix.proposed_params,
      rationale: fix.rationale,
    });
  }
  return suggestions;
}
