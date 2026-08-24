"use client";

import { useState, useTransition } from "react";
import { approvePolicyRule, rejectPolicyRule } from "@/lib/actions/policy";
import type { PolicyRule } from "@/types/db";
import { DangerButton, EmptyState, Icons, Panel, SuccessButton, relativeTime } from "./ui";

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

const TYPE_LABEL: Record<PolicyRule["type"], string> = {
  cap: "Cap",
  velocity: "Velocity",
  category_block: "Category block",
  step_up: "Step-up",
};

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
    <Panel title="Policy rules" icon={<Icons.Shield />} accent="var(--entity-rule)" count={pendingReview.length}>
      {error && (
        <p className="mb-3 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: "var(--decision-block)", color: "var(--decision-block)", background: "color-mix(in srgb, var(--decision-block) 14%, transparent)" }}>
          {error}
        </p>
      )}

      {pendingReview.length > 0 && (
        <div className="mb-4 space-y-2.5">
          <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--entity-rule)" }}>
            Pending review
          </p>
          {pendingReview.map((rule) => {
            const busy = isPending && busyId === rule.id;
            return (
              <div
                key={rule.id}
                className="rounded-xl border p-3.5"
                style={{ borderColor: "var(--panel-border)", background: "var(--panel-2)" }}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{rule.name}</span>
                  <span
                    className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold"
                    style={{ background: "color-mix(in srgb, var(--entity-rule) 15%, transparent)", color: "var(--entity-rule)" }}
                  >
                    {TYPE_LABEL[rule.type]} · {rule.source}
                  </span>
                </div>
                <p className="mt-1.5 font-mono text-[11px]" style={{ color: "var(--muted)" }}>
                  <ParamsLine rule={rule} />
                </p>
                {rule.rationale && (
                  <p className="mt-1.5 whitespace-pre-line text-xs leading-relaxed" style={{ color: "var(--muted)" }}>
                    {rule.rationale}
                  </p>
                )}
                <div className="mt-3 flex gap-2">
                  <SuccessButton disabled={busy} onClick={() => act(rule.id, approvePolicyRule)} className="flex-1">
                    {busy ? "Working…" : "Activate"}
                  </SuccessButton>
                  <DangerButton disabled={busy} onClick={() => act(rule.id, rejectPolicyRule)} className="flex-1">
                    {busy ? "Working…" : "Reject"}
                  </DangerButton>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--muted-2)" }}>
        Active ({active.length})
      </p>
      {active.length === 0 && <EmptyState text="No active rules yet — run npm run seed." />}
      <div className="space-y-1.5">
        {active.map((rule) => (
          <div key={rule.id} className="flex items-center justify-between rounded-lg px-2.5 py-1.5 text-xs hover:bg-[var(--panel-2)]">
            <span className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--decision-allow)" }} />
              {rule.name}
            </span>
            <span style={{ color: "var(--muted-2)" }}>{relativeTime(rule.created_at)}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}
