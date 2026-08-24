"use client";

import { useState, useTransition } from "react";
import { submitManualPolicyDraft, triggerHorizonExample } from "@/lib/actions/horizon";
import { Panel } from "./ui";

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
    <Panel title="Draft a policy">
      <p className="mb-3 text-xs" style={{ color: "var(--muted)" }}>
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
        className="mb-2 w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none"
        style={{ borderColor: "var(--panel-border)" }}
      />

      <div className="flex gap-2">
        <button
          disabled={isPending || !text.trim()}
          onClick={runManual}
          className="flex-1 rounded-md py-1.5 text-xs font-medium text-black disabled:opacity-50"
          style={{ background: "var(--entity-agent)" }}
        >
          {isPending ? "Drafting…" : "Draft from text"}
        </button>
        <button
          disabled={isPending}
          onClick={runHorizon}
          className="flex-1 rounded-md border py-1.5 text-xs font-medium disabled:opacity-50"
          style={{ borderColor: "var(--panel-border)" }}
        >
          Simulate Horizon finding an update
        </button>
      </div>

      {error && (
        <p className="mt-3 text-xs" style={{ color: "var(--decision-block)" }}>
          {error}
        </p>
      )}

      {result && (
        <div className="mt-3 rounded-lg border p-3 text-xs" style={{ borderColor: "var(--panel-border)" }}>
          <p className="font-medium" style={{ color: "var(--entity-rule)" }}>
            Drafted: {result.name} ({result.type})
          </p>
          <p className="mt-1" style={{ color: "var(--muted)" }}>
            {result.rationale}
          </p>
          <p className="mt-2">
            Backtested against {result.backtest.tracesEvaluated} recent decisions —{" "}
            {result.backtest.wouldHaveChangedDecision} would have changed.
          </p>
          {result.conflictsWith.length > 0 && (
            <p className="mt-1" style={{ color: "var(--decision-escalate)" }}>
              Overlaps with {result.conflictsWith.length} existing rule(s) of the same type.
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}
