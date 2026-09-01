"use client";

import { useState, useTransition } from "react";
import { applyPolicyFix, runPolicyAudit, suggestFixForIssue } from "@/lib/actions/policy";
import type { PolicyIssue } from "@/lib/policy/audit";
import type { SemanticIssue } from "@/lib/policy/semanticAudit";
import type { FixSuggestion } from "@/lib/policy/suggestFix";
import { GhostButton, Icons, Panel, SuccessButton, Spinner } from "./ui";

const SEVERITY_COLOR = {
  critical: "var(--decision-block)",
  warning: "var(--decision-escalate)",
  info: "var(--entity-agent)",
} as const;

type Issue = (PolicyIssue | SemanticIssue) & { certain: boolean };

function FixCard({ fix, onApplied }: { fix: FixSuggestion; onApplied: () => void }) {
  const [isPending, startTransition] = useTransition();
  const [applied, setApplied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function apply() {
    startTransition(async () => {
      try {
        await applyPolicyFix(fix.ruleId, fix.proposedParams);
        setApplied(true);
        onApplied();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't apply the fix.");
      }
    });
  }

  return (
    <div className="mt-2 rounded-lg border px-3 py-2.5" style={{ borderColor: "var(--panel-border-strong)", background: "var(--panel)" }}>
      <p className="text-[12px] font-semibold">{fix.ruleName}</p>
      <p className="mt-1 text-[11px] leading-relaxed" style={{ color: "var(--muted)" }}>
        {fix.rationale}
      </p>
      <div className="mt-2 grid grid-cols-2 gap-2 font-mono text-[10px]">
        <div className="rounded px-2 py-1.5" style={{ background: "color-mix(in srgb, var(--decision-block) 10%, transparent)" }}>
          <p className="mb-0.5 opacity-60">before</p>
          {JSON.stringify(fix.currentParams)}
        </div>
        <div className="rounded px-2 py-1.5" style={{ background: "color-mix(in srgb, var(--decision-allow) 12%, transparent)" }}>
          <p className="mb-0.5 opacity-60">after</p>
          {JSON.stringify(fix.proposedParams)}
        </div>
      </div>
      {error && (
        <p className="mt-2 text-[11px]" style={{ color: "var(--decision-block)" }}>
          {error}
        </p>
      )}
      <SuccessButton disabled={isPending || applied} onClick={apply} className="mt-2 w-full">
        <span className="flex items-center justify-center gap-1.5">
          {isPending && <Spinner />}
          {applied ? "Applied" : isPending ? "Applying…" : "Apply this fix"}
        </span>
      </SuccessButton>
    </div>
  );
}

function IssueRow({ issue, onRefresh }: { issue: Issue; onRefresh: () => void }) {
  const color = SEVERITY_COLOR[issue.severity];
  const [fixes, setFixes] = useState<FixSuggestion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function suggestFix() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await suggestFixForIssue(issue.title, issue.explanation, issue.affectedRuleIds);
        setFixes(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't get a suggestion.");
      }
    });
  }

  return (
    <div className="rounded-lg border-l-2 px-3 py-2.5" style={{ borderColor: color, background: "var(--panel-2)" }}>
      <div className="flex items-center gap-2">
        <p className="text-[13px] font-medium">{issue.title}</p>
        <span className="rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide" style={{ background: `${color}26`, color }}>
          {issue.certain ? issue.severity : "worth reviewing"}
        </span>
      </div>
      <p className="mt-1 text-[12px] leading-relaxed" style={{ color: "var(--muted)" }}>
        {issue.explanation}
      </p>

      {issue.affectedRuleIds.length > 0 && !fixes && (
        <GhostButton disabled={isPending} onClick={suggestFix} className="mt-2 py-1! px-2.5! text-[11px]!">
          <span className="flex items-center justify-center gap-1.5">
            {isPending && <Spinner />}
            {isPending ? "Thinking…" : "Suggest a fix"}
          </span>
        </GhostButton>
      )}

      {error && (
        <p className="mt-2 text-[11px]" style={{ color: "var(--decision-block)" }}>
          {error}
        </p>
      )}

      {fixes && fixes.length === 0 && (
        <p className="mt-2 text-[11px]" style={{ color: "var(--muted-2)" }}>
          No confident fix to propose here — this one&apos;s worth a manual look.
        </p>
      )}

      {fixes?.map((fix) => (
        <FixCard key={fix.ruleId} fix={fix} onApplied={onRefresh} />
      ))}
    </div>
  );
}

/**
 * Two tiers, deliberately not blended: `deterministicIssues` are provably
 * true given the rule set (arithmetic, not opinion) — computed server-side
 * on every render, no LLM call, no button. `semanticIssues` come from an
 * on-demand LLM review and are shown as "worth reviewing," never asserted as
 * fact. Either kind can get an AI-suggested concrete fix on request — never
 * auto-applied, always a second explicit click. See src/lib/policy/audit.ts,
 * semanticAudit.ts, and suggestFix.ts.
 */
export function PolicyHealthPanel({ deterministicIssues }: { deterministicIssues: PolicyIssue[] }) {
  const [semanticIssues, setSemanticIssues] = useState<SemanticIssue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [refreshKey, setRefreshKey] = useState(0);

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

  return (
    <Panel title="Policy health" icon={<Icons.Shield />} accent="var(--entity-mandate)" count={deterministicIssues.length}>
      <p className="mb-3 text-xs leading-relaxed" style={{ color: "var(--muted)" }}>
        Checked automatically, every load: rules that can never fire, thresholds that make each other
        unreachable, gaps in coverage — real logic, not a guess.
      </p>

      {deterministicIssues.length === 0 ? (
        <p className="mb-3 rounded-lg px-3 py-2 text-xs" style={{ background: "var(--panel-2)", color: "var(--muted)" }}>
          No structural issues found in the active rule set.
        </p>
      ) : (
        <div key={refreshKey} className="mb-3 space-y-2">
          {deterministicIssues.map((issue) => (
            <IssueRow key={issue.id} issue={{ ...issue, certain: true }} onRefresh={() => setRefreshKey((k) => k + 1)} />
          ))}
        </div>
      )}

      <div className="flex items-center justify-between border-t pt-3" style={{ borderColor: "var(--panel-border)" }}>
        <p className="text-[11px]" style={{ color: "var(--muted-2)" }}>
          Want a second, judgment-call pass? Ask the LLM to review coverage.
        </p>
        <GhostButton onClick={runAudit} disabled={isPending} className="shrink-0">
          <span className="flex items-center justify-center gap-1.5">
            {isPending && <Spinner />}
            {isPending ? "Reviewing…" : "Run AI review"}
          </span>
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
              <IssueRow key={issue.id} issue={{ ...issue, certain: false }} onRefresh={() => setRefreshKey((k) => k + 1)} />
            ))
          )}
        </div>
      )}
    </Panel>
  );
}
