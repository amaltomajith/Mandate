"use client";

import { useState, useTransition } from "react";
import { submitManualPolicyDraft, triggerHorizonExample } from "@/lib/actions/horizon";
import { GhostButton, Icons, Panel, PrimaryButton } from "./ui";

interface DraftResult {
  ruleId: string;
  type: string;
  name: string;
  rationale: string;
  conflictsWith: { id: string; name: string; type: string }[];
  backtest: { tracesEvaluated: number; wouldHaveChangedDecision: number };
}

export function HorizonPanel() {
  const [text, setText] = useState("");
  const [result, setResult] = useState<DraftResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function runHorizon() {
    setError(null);
    setResult(null);
    startTransition(async () => {
      try {
        const r = await triggerHorizonExample();
        setResult(r);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Horizon failed.");
      }
    });
  }

  function runManual() {
    if (!text.trim()) return;
    setError(null);
    setResult(null);
    startTransition(async () => {
      try {
        const r = await submitManualPolicyDraft(text);
        setResult(r);
        setText("");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Draft failed.");
      }
    });
  }

  return (
    <Panel title="Draft a policy" icon={<Icons.Sparkles />} accent="var(--entity-agent)">
      <p className="mb-3 text-xs leading-relaxed" style={{ color: "var(--muted)" }}>
        Write a plain-language policy request, or simulate Horizon spotting a regulatory
        update. Either way it becomes a structured, backtested rule sitting in{" "}
        <span style={{ color: "var(--entity-rule)" }}>pending review</span> — nothing activates
        without approval above.
      </p>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder='e.g. "Block any payout over ₹50,000 outright"'
        rows={3}
        className="mb-2 w-full resize-none rounded-lg border px-3 py-2.5 text-sm outline-none transition-colors focus:border-[var(--entity-agent)]"
        style={{ borderColor: "var(--panel-border)", background: "var(--panel-2)" }}
      />

      <div className="flex gap-2">
        <PrimaryButton disabled={isPending || !text.trim()} onClick={runManual} className="flex-1">
          {isPending ? "Drafting…" : "Draft from text"}
        </PrimaryButton>
        <GhostButton disabled={isPending} onClick={runHorizon} className="flex-1">
          Simulate Horizon
        </GhostButton>
      </div>

      {error && (
        <p className="mt-3 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: "var(--decision-block)", color: "var(--decision-block)", background: "color-mix(in srgb, var(--decision-block) 6%, white)" }}>
          {error}
        </p>
      )}

      {result && (
        <div
          className="mt-3 rounded-xl border p-3.5 text-xs"
          style={{ borderColor: "var(--panel-border)", background: "var(--panel-2)" }}
        >
          <p className="font-semibold" style={{ color: "var(--entity-rule)" }}>
            Drafted: {result.name} ({result.type})
          </p>
          <p className="mt-1.5 leading-relaxed" style={{ color: "var(--muted)" }}>
            {result.rationale}
          </p>
          <p className="mt-2.5 flex items-center gap-1.5">
            <span
              className="rounded px-1.5 py-0.5 font-mono text-[11px]"
              style={{ background: "var(--panel-border)" }}
            >
              {result.backtest.wouldHaveChangedDecision}/{result.backtest.tracesEvaluated}
            </span>
            <span style={{ color: "var(--muted)" }}>recent decisions would have changed</span>
          </p>
          {result.conflictsWith.length > 0 && (
            <p className="mt-1.5" style={{ color: "var(--decision-escalate)" }}>
              Overlaps with {result.conflictsWith.length} existing rule(s) of the same type.
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}
