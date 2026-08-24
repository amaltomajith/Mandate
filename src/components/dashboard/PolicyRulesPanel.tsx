"use client";

import { useState, useTransition } from "react";
import { approvePolicyRule, rejectPolicyRule } from "@/lib/actions/policy";
import type { PolicyRule } from "@/types/db";
import { EmptyState, Panel, relativeTime } from "./ui";

function ParamsLine({ rule }: { rule: PolicyRule }) {
  const p = rule.params as Record<string, unknown>;
  switch (rule.type) {
    case "cap":
      return <>≤ {String(p.max_amount)} {String(p.currency)} ({String(p.scope)})</>;
    case "velocity":
      return <>≤ {String(p.max_count)} / {String(p.window_seconds)}s ({String(p.scope)})</>;
    case "category_block":
      return <>blocks: {Array.isArray(p.categories) ? p.categories.join(", ") : ""}</>;
    case "step_up":
      return <>≥ {String(p.threshold_amount)} {String(p.currency)} → human approval</>;
    default:
      return null;
  }
}

export function PolicyRulesPanel({ rules }: { rules: PolicyRule[] }) {
  const active = rules.filter((r) => r.status === "active");
  const pendingReview = rules.filter((r) => r.status === "pending_review");
  const [isPending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function act(id: string, fn: (id: string) => Promise<void>) {
    setError(null);
    setBusyId(id);
    startTransition(async () => {
      try {
        await fn(id);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Action failed.");
      } finally {
        setBusyId(null);
      }
    });
  }

  return (
    <Panel title="Policy rules" count={pendingReview.length}>
      {error && (
        <p className="mb-2 text-xs" style={{ color: "var(--decision-block)" }}>
          {error}
        </p>
      )}

      {pendingReview.length > 0 && (
        <div className="mb-4 space-y-2">
          <p className="text-xs font-medium" style={{ color: "var(--entity-rule)" }}>
            Pending review
          </p>
          {pendingReview.map((rule) => {
            const busy = isPending && busyId === rule.id;
            return (
              <div key={rule.id} className="rounded-lg border p-3" style={{ borderColor: "var(--panel-border)" }}>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{rule.name}</span>
                  <span
                    className="rounded px-1.5 py-0.5 text-[10px] uppercase"
                    style={{ background: "var(--entity-rule)", color: "#05060a" }}
                  >
                    {rule.type} · {rule.source}
                  </span>
                </div>
                <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
                  <ParamsLine rule={rule} />
                </p>
                {rule.rationale && (
                  <p className="mt-1 whitespace-pre-line text-xs" style={{ color: "var(--muted)" }}>
                    {rule.rationale}
                  </p>
                )}
                <div className="mt-3 flex gap-2">
                  <button
                    disabled={busy}
                    onClick={() => act(rule.id, approvePolicyRule)}
                    className="flex-1 rounded-md py-1.5 text-xs font-medium text-black disabled:opacity-50"
                    style={{ background: "var(--decision-allow)" }}
                  >
                    {busy ? "Working…" : "Activate"}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => act(rule.id, rejectPolicyRule)}
                    className="flex-1 rounded-md py-1.5 text-xs font-medium text-black disabled:opacity-50"
                    style={{ background: "var(--decision-block)" }}
                  >
                    {busy ? "Working…" : "Reject"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="mb-2 text-xs font-medium" style={{ color: "var(--muted)" }}>
        Active ({active.length})
      </p>
      {active.length === 0 && <EmptyState text="No active rules yet — run npm run seed." />}
      <div className="space-y-2">
        {active.map((rule) => (
          <div key={rule.id} className="flex items-center justify-between text-xs">
            <span>{rule.name}</span>
            <span style={{ color: "var(--muted)" }}>{relativeTime(rule.created_at)}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}
