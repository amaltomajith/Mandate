"use client";

import { useState, useTransition } from "react";
import { runPolicyAudit } from "@/lib/actions/policy";
import type { PolicyIssue } from "@/lib/policy/audit";
import type { SemanticIssue } from "@/lib/policy/semanticAudit";
import { GhostButton, Icons, Panel } from "./ui";

const SEVERITY_COLOR = {
  critical: "var(--decision-block)",
  warning: "var(--decision-escalate)",
  info: "var(--entity-agent)",
} as const;

function IssueRow({ title, explanation, severity, certain }: { title: string; explanation: string; severity: keyof typeof SEVERITY_COLOR; certain: boolean }) {
  const color = SEVERITY_COLOR[severity];
  return (
    <div className="rounded-lg border-l-2 px-3 py-2.5" style={{ borderColor: color, background: "var(--panel-2)" }}>
      <div className="flex items-center gap-2">
        <p className="text-[13px] font-medium">{title}</p>
        <span
          className="rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide"
          style={{ background: `${color}26`, color }}
        >
          {certain ? severity : "worth reviewing"}
        </span>
      </div>
      <p className="mt-1 text-[12px] leading-relaxed" style={{ color: "var(--muted)" }}>
        {explanation}
      </p>
    </div>
  );
}

/**
 * Two tiers, deliberately not blended: `deterministicIssues` are provably
 * true given the rule set (arithmetic, not opinion) — computed server-side
 * on every render, no LLM call, no button. `semanticIssues` come from an
 * on-demand LLM review and are shown as "worth reviewing," never asserted as
 * fact. See src/lib/policy/audit.ts and semanticAudit.ts.
 */
export function PolicyHealthPanel({ deterministicIssues }: { deterministicIssues: PolicyIssue[] }) {
  const [semanticIssues, setSemanticIssues] = useState<SemanticIssue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function runAudit() {
    setError(null);
    startTransition(async () => {
      try {
        const issues = await runPolicyAudit();
        setSemanticIssues(issues);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Audit failed.");
      }
    });
  }

  const totalDeterministic = deterministicIssues.length;

  return (
    <Panel title="Policy health" icon={<Icons.Shield />} accent="var(--entity-mandate)" count={totalDeterministic}>
      <p className="mb-3 text-xs leading-relaxed" style={{ color: "var(--muted)" }}>
        Checked automatically, every load: rules that can never fire, thresholds that make each other
        unreachable, gaps in coverage — real logic, not a guess.
      </p>

      {deterministicIssues.length === 0 ? (
        <p className="mb-3 rounded-lg px-3 py-2 text-xs" style={{ background: "var(--panel-2)", color: "var(--muted)" }}>
          No structural issues found in the active rule set.
        </p>
      ) : (
        <div className="mb-3 space-y-2">
          {deterministicIssues.map((issue) => (
            <IssueRow key={issue.id} title={issue.title} explanation={issue.explanation} severity={issue.severity} certain />
          ))}
        </div>
      )}

      <div className="flex items-center justify-between border-t pt-3" style={{ borderColor: "var(--panel-border)" }}>
        <p className="text-[11px]" style={{ color: "var(--muted-2)" }}>
          Want a second, judgment-call pass? Ask the LLM to review coverage.
        </p>
        <GhostButton onClick={runAudit} disabled={isPending} className="shrink-0">
          {isPending ? "Reviewing…" : "Run AI review"}
        </GhostButton>
      </div>

      {error && (
        <p className="mt-3 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: "var(--decision-block)", color: "var(--decision-block)", background: "color-mix(in srgb, var(--decision-block) 14%, transparent)" }}>
          {error}
        </p>
      )}

      {semanticIssues && (
        <div className="mt-3 space-y-2">
          {semanticIssues.length === 0 ? (
            <p className="rounded-lg px-3 py-2 text-xs" style={{ background: "var(--panel-2)", color: "var(--muted)" }}>
              Nothing worth flagging beyond the structural checks above.
            </p>
          ) : (
            semanticIssues.map((issue) => (
              <IssueRow key={issue.id} title={issue.title} explanation={issue.explanation} severity={issue.severity} certain={false} />
            ))
          )}
        </div>
      )}
    </Panel>
  );
}
