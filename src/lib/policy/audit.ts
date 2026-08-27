import type { PolicyRule } from "@/types/db";
import type { CapParams, CategoryBlockParams, StepUpParams } from "./types";

/**
 * A pure, deterministic check for structural problems in a merchant's active
 * rule set — not guesses, not an LLM call, just arithmetic over how the
 * evaluator in engine.ts actually resolves priority (category_block > cap >
 * velocity > step_up, first match wins). Every issue here is provably true
 * given the rule set; there is no false-positive risk the way there would be
 * with a model. See src/lib/policy/semanticAudit.ts for the LLM-driven layer
 * that catches things this can't (coverage gaps that are a judgment call, not
 * a logic error) — deliberately kept separate and labeled, not blended in.
 *
 * Domain-scoped since policy domains went in (src/lib/policy/domains.ts):
 * two rules of the same type in two DIFFERENT domains never actually compete
 * against each other — a mandates-domain step-up at ₹1,000 and a
 * purchases-domain cap at ₹20,000 look like a "dead rule" conflict if
 * compared globally, but they never evaluate against the same action, so
 * that would be a false positive. Every check below only ever compares rules
 * within the same domain.
 */

export interface PolicyIssue {
  id: string;
  severity: "critical" | "warning" | "info";
  title: string;
  explanation: string;
  affectedRuleIds: string[];
}

function money(paise: number, currency: string): string {
  const amount = paise / 100;
  const formatted = amount.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  return currency === "INR" ? `₹${formatted}` : `${formatted} ${currency}`;
}

/** The original checks, run against one domain's rules at a time. */
function auditDomainRules(active: PolicyRule[]): PolicyIssue[] {
  const issues: PolicyIssue[] = [];

  const caps = active.filter((r) => r.type === "cap");
  const stepUps = active.filter((r) => r.type === "step_up");
  const categoryBlocks = active.filter((r) => r.type === "category_block");

  // A step-up rule can only ever fire on an amount a cap rule hasn't already
  // blocked. If a per-transaction cap's ceiling is at or below a step-up's
  // threshold (same currency), every action that should have escalated gets
  // hard-blocked instead — the step-up rule is dead code, and nobody ever
  // sees the approval request they configured it to produce.
  for (const stepUp of stepUps) {
    const suParams = stepUp.params as unknown as StepUpParams;
    for (const cap of caps) {
      const capParams = cap.params as unknown as CapParams;
      if (capParams.currency !== suParams.currency) continue;
      if (capParams.scope !== "per_transaction") continue;
      if (capParams.max_amount <= suParams.threshold_amount) {
        issues.push({
          id: `dead-stepup-${stepUp.id}-${cap.id}`,
          severity: "critical",
          title: `"${stepUp.name}" can never fire`,
          explanation: `"${cap.name}" blocks anything over ${money(capParams.max_amount, capParams.currency)} — at or below the ${money(suParams.threshold_amount, suParams.currency)} threshold "${stepUp.name}" is supposed to escalate at. Every action that should route to a human gets hard-blocked before the step-up rule ever gets a turn.`,
          affectedRuleIds: [stepUp.id, cap.id],
        });
      }
    }
  }

  // Two per-transaction caps in the same currency: the stricter one always
  // wins (engine.ts checks all cap rules and blocks on the first match), so
  // the looser one's higher ceiling is unreachable — not wrong, just noise.
  for (let i = 0; i < caps.length; i++) {
    for (let j = i + 1; j < caps.length; j++) {
      const a = caps[i];
      const b = caps[j];
      const aParams = a.params as unknown as CapParams;
      const bParams = b.params as unknown as CapParams;
      if (aParams.currency !== bParams.currency || aParams.scope !== bParams.scope) continue;

      if (aParams.max_amount === bParams.max_amount) {
        issues.push({
          id: `duplicate-cap-${a.id}-${b.id}`,
          severity: "info",
          title: `"${a.name}" and "${b.name}" are duplicates`,
          explanation: `Both cap ${aParams.scope.replace("_", "-")} actions at exactly ${money(aParams.max_amount, aParams.currency)}. One of these is redundant.`,
          affectedRuleIds: [a.id, b.id],
        });
      } else {
        const [stricter, looser] = aParams.max_amount < bParams.max_amount ? [a, b] : [b, a];
        const stricterParams = (stricter.params as unknown as CapParams).max_amount;
        issues.push({
          id: `unreachable-cap-${stricter.id}-${looser.id}`,
          severity: "warning",
          title: `"${looser.name}" is unreachable`,
          explanation: `"${stricter.name}" already blocks anything over ${money(stricterParams, aParams.currency)} — a stricter limit that always applies first, so "${looser.name}"'s higher ceiling never gets the chance to matter.`,
          affectedRuleIds: [stricter.id, looser.id],
        });
      }
    }
  }

  // Two category-block rules covering the exact same category is silent
  // redundancy, easy to miss when rules accumulate over time (e.g. one from
  // Horizon, one hand-written).
  for (let i = 0; i < categoryBlocks.length; i++) {
    for (let j = i + 1; j < categoryBlocks.length; j++) {
      const a = categoryBlocks[i];
      const b = categoryBlocks[j];
      const aCats = (a.params as unknown as CategoryBlockParams).categories;
      const bCats = (b.params as unknown as CategoryBlockParams).categories;
      const overlap = aCats.filter((c) => bCats.includes(c));
      if (overlap.length > 0) {
        issues.push({
          id: `overlap-categoryblock-${a.id}-${b.id}`,
          severity: "info",
          title: `"${a.name}" and "${b.name}" overlap`,
          explanation: `Both rules block: ${overlap.join(", ")}. Not wrong, just listed twice — worth consolidating into one rule.`,
          affectedRuleIds: [a.id, b.id],
        });
      }
    }
  }

  // No step-up rule at all in this domain: nothing ever routes to a human.
  // Every action here is either allowed outright or hard-blocked, with no
  // in-between — a real gap in a system whose whole pitch is "bounded and
  // gated," now checked per domain since each domain is independently
  // governed and could independently lack one.
  if (stepUps.length === 0 && active.length > 0) {
    issues.push({
      id: `no-stepup-configured-${active[0].domain_id ?? "none"}`,
      severity: "warning",
      title: "No step-up rule configured",
      explanation: "Nothing routes to human approval right now — every action in this domain is either allowed outright or hard-blocked, with no in-between. Consider adding a step-up threshold so unusually large actions get a second look instead of an automatic decision either way.",
      affectedRuleIds: [],
    });
  }

  return issues;
}

export function auditPolicySet(rules: PolicyRule[]): PolicyIssue[] {
  const active = rules.filter((r) => r.status === "active");

  const byDomain = new Map<string, PolicyRule[]>();
  for (const rule of active) {
    const key = rule.domain_id ?? "__no_domain__";
    const list = byDomain.get(key) ?? [];
    list.push(rule);
    byDomain.set(key, list);
  }

  const issues: PolicyIssue[] = [];
  for (const domainRules of byDomain.values()) {
    issues.push(...auditDomainRules(domainRules));
  }
  return issues;
}
