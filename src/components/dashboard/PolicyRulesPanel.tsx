"use client";

import { useState, useTransition } from "react";
import { approvePolicyRule, deactivatePolicyRule, deletePolicyRule, reactivatePolicyRule, rejectPolicyRule } from "@/lib/actions/policy";
import type { PolicyRule } from "@/types/db";
import { DangerButton, EmptyState, GhostButton, Icons, Panel, SuccessButton, relativeTime } from "./ui";

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
  trust_floor: "Trust floor",
  step_up: "Step-up",
};

export function PolicyRulesPanel({
  rules,
  highlightRuleId,
}: {
  rules: PolicyRule[];
  highlightRuleId?: string | null;
}) {
  const active = rules.filter((r) => r.status === "active");
  const pendingReview = rules.filter((r) => r.status === "pending_review");
  const inactive = rules.filter((r) => r.status === "superseded");

  const [isPending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [supersedeChoices, setSupersedeChoices] = useState<Record<string, Set<string>>>({});

  function act(id: string, fn: () => Promise<void>) {
    setError(null);
    setBusyId(id);
    startTransition(async () => {
      try {
        await fn();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Action failed.");
      } finally {
        setBusyId(null);
      }
    });
  }

  function actWithConfirm(id: string, confirmMessage: string, fn: () => Promise<void>) {
    if (!window.confirm(confirmMessage)) return;
    act(id, fn);
  }

  function toggleSupersede(pendingId: string, conflictId: string) {
    setSupersedeChoices((prev) => {
      const current = new Set(prev[pendingId] ?? []);
      if (current.has(conflictId)) current.delete(conflictId);
      else current.add(conflictId);
      return { ...prev, [pendingId]: current };
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
            // Same-type rules are the ones that can actually shadow each
            // other — a cap never competes with a step-up.
            const conflicts = active.filter((r) => r.type === rule.type);
            const chosen = supersedeChoices[rule.id] ?? new Set<string>();

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

                {conflicts.length > 0 && (
                  <div className="mt-3 rounded-lg border px-2.5 py-2" style={{ borderColor: "var(--decision-escalate)", background: "color-mix(in srgb, var(--decision-escalate) 8%, transparent)" }}>
                    <p className="mb-1.5 text-[11px] font-semibold" style={{ color: "var(--decision-escalate)" }}>
                      Conflicts with {conflicts.length} existing {TYPE_LABEL[rule.type].toLowerCase()} rule{conflicts.length > 1 ? "s" : ""} — your call:
                    </p>
                    {conflicts.map((c) => (
                      <label key={c.id} className="flex cursor-pointer items-center gap-2 py-1 text-[12px]">
                        <input
                          type="checkbox"
                          checked={chosen.has(c.id)}
                          onChange={() => toggleSupersede(rule.id, c.id)}
                          className="h-3.5 w-3.5"
                        />
                        <span>
                          retire <strong>&quot;{c.name}&quot;</strong> when this activates
                        </span>
                      </label>
                    ))}
                    <p className="mt-1 text-[11px]" style={{ color: "var(--muted-2)" }}>
                      Leave unchecked to keep both active at once.
                    </p>
                  </div>
                )}

                <div className="mt-3 flex gap-2">
                  <SuccessButton
                    disabled={busy}
                    onClick={() => act(rule.id, () => approvePolicyRule(rule.id, Array.from(chosen)))}
                    className="flex-1"
                  >
                    {busy ? "Working…" : "Activate"}
                  </SuccessButton>
                  <DangerButton disabled={busy} onClick={() => act(rule.id, () => rejectPolicyRule(rule.id))} className="flex-1">
                    {busy ? "Working…" : "Reject"}
                  </DangerButton>
                  <GhostButton
                    disabled={busy}
                    onClick={() => actWithConfirm(rule.id, `Permanently delete the draft "${rule.name}"? This can't be undone.`, () => deletePolicyRule(rule.id))}
                  >
                    {busy ? "…" : "Delete"}
                  </GhostButton>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--muted-2)" }}>
        Active ({active.length})
      </p>
      {active.length === 0 && <EmptyState text="No active rules yet — click Run demo, it seeds them." />}
      <div className="mb-4 space-y-1">
        {active.map((rule) => {
          const busy = isPending && busyId === rule.id;
          const highlighted = highlightRuleId === rule.id;
          return (
            <div
              key={rule.id}
              className="group flex items-center justify-between rounded-lg px-2.5 py-1.5 text-xs hover:bg-[var(--panel-2)]"
              style={highlighted ? { background: "color-mix(in srgb, var(--entity-agent) 16%, transparent)", boxShadow: "inset 0 0 0 1px var(--entity-agent)" } : undefined}
            >
              <span className="flex min-w-0 items-center gap-2 truncate">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: "var(--decision-allow)" }} />
                <span className="truncate">{rule.name}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  <GhostButton disabled={busy} onClick={() => act(rule.id, () => deactivatePolicyRule(rule.id))} className="py-1! px-2! text-[10px]!">
                    {busy ? "…" : "Deactivate"}
                  </GhostButton>
                  <GhostButton
                    disabled={busy}
                    onClick={() => actWithConfirm(rule.id, `Permanently delete "${rule.name}"? This can't be undone — if it's ever fired, this will fail and tell you to deactivate instead.`, () => deletePolicyRule(rule.id))}
                    className="py-1! px-2! text-[10px]!"
                  >
                    {busy ? "…" : "Delete"}
                  </GhostButton>
                </span>
                <span style={{ color: "var(--muted-2)" }}>{relativeTime(rule.created_at)}</span>
              </span>
            </div>
          );
        })}
      </div>

      {inactive.length > 0 && (
        <>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--muted-2)" }}>
            Inactive ({inactive.length})
          </p>
          <div className="space-y-1">
            {inactive.map((rule) => {
              const busy = isPending && busyId === rule.id;
              const supersededByName = rule.superseded_by ? rules.find((r) => r.id === rule.superseded_by)?.name : null;
              const highlighted = highlightRuleId === rule.id;
              return (
                <div
                  key={rule.id}
                  className="flex items-center justify-between rounded-lg px-2.5 py-1.5 text-xs"
                  style={highlighted ? { boxShadow: "inset 0 0 0 1px var(--entity-agent)" } : { opacity: 0.7 }}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: "var(--muted-2)" }} />
                    <span className="truncate">
                      {rule.name}
                      {supersededByName && <span style={{ color: "var(--muted-2)" }}> — replaced by &quot;{supersededByName}&quot;</span>}
                    </span>
                  </span>
                  <span className="flex shrink-0 gap-1">
                    <GhostButton disabled={busy} onClick={() => act(rule.id, () => reactivatePolicyRule(rule.id))} className="py-1! px-2! text-[10px]!">
                      {busy ? "…" : "Reactivate"}
                    </GhostButton>
                    <GhostButton
                      disabled={busy}
                      onClick={() => actWithConfirm(rule.id, `Permanently delete "${rule.name}"? This can't be undone.`, () => deletePolicyRule(rule.id))}
                      className="py-1! px-2! text-[10px]!"
                    >
                      {busy ? "…" : "Delete"}
                    </GhostButton>
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </Panel>
  );
}
