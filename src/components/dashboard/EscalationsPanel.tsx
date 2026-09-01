"use client";

import { useState, useTransition } from "react";
import { approveEscalation, denyEscalation } from "@/lib/actions/escalations";
import type { Escalation, Trace } from "@/types/db";
import { actionTypeLabel, DangerButton, EmptyState, formatMoney, Icons, Panel, SuccessButton, relativeTime } from "./ui";

export function EscalationsPanel({
  escalations,
  tracesById,
}: {
  escalations: Escalation[];
  tracesById: Record<string, Trace>;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // `escalations` comes from the server and only refreshes on the dashboard's
  // 4s poll, so without this a card sat there looking actionable for seconds
  // after being approved — long enough to click again and get told it was
  // already resolved, which reads as a bug rather than a double-click.
  const [resolvedLocally, setResolvedLocally] = useState<Set<string>>(new Set());

  const pending = escalations.filter((e) => e.status === "pending" && !resolvedLocally.has(e.id));

  function act(id: string, fn: (id: string) => Promise<void>) {
    setError(null);
    setBusyId(id);
    startTransition(async () => {
      try {
        await fn(id);
        setResolvedLocally((prev) => new Set(prev).add(id));
      } catch (err) {
        const message = err instanceof Error ? err.message : "Action failed.";
        // Already resolved isn't a failure — the outcome the merchant wanted
        // is the outcome that holds. It only happens when a click lands twice
        // before the poll catches up, so drop the card and stay quiet rather
        // than showing a red banner for a non-problem.
        if (message.includes("already resolved")) {
          setResolvedLocally((prev) => new Set(prev).add(id));
        } else {
          setError(message);
        }
      } finally {
        setBusyId(null);
      }
    });
  }

  return (
    <Panel title="Escalations" icon={<Icons.Escalation />} accent="var(--decision-escalate)" count={pending.length}>
      {error && (
        <p className="mb-3 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: "var(--decision-block)", color: "var(--decision-block)", background: "color-mix(in srgb, var(--decision-block) 14%, transparent)" }}>
          {error}
        </p>
      )}
      {pending.length === 0 && <EmptyState text="No pending escalations — the queue is clear." />}
      <div className="space-y-3">
        {pending.map((esc) => {
          const trace = tracesById[esc.trace_id];
          const rowBusy = isPending && busyId === esc.id;
          return (
            <div
              key={esc.id}
              className="rounded-xl border p-3.5"
              style={{ borderColor: "var(--panel-border)", background: "var(--panel-2)" }}
            >
              <div className="flex items-center justify-between">
                <span
                  className="rounded-md px-1.5 py-0.5 text-[10px] font-bold tracking-wide"
                  style={{ background: "color-mix(in srgb, var(--decision-escalate) 15%, transparent)", color: "var(--decision-escalate)" }}
                >
                  NEEDS APPROVAL
                </span>
                <span className="text-[11px]" style={{ color: "var(--muted-2)" }}>
                  {relativeTime(esc.created_at)}
                </span>
              </div>
              {trace && (
                <>
                  <div className="mt-2 flex items-baseline justify-between gap-2">
                    <p className="text-sm font-medium">{actionTypeLabel(trace.action_type)}</p>
                    {(() => {
                      const p = trace.params as { amount?: number; currency?: string } | null;
                      return p?.amount && p?.currency ? (
                        <p className="text-sm font-semibold tabular-nums" style={{ color: "var(--decision-escalate)" }}>
                          {formatMoney(p.amount, p.currency)}
                        </p>
                      ) : null;
                    })()}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--muted)" }}>
                    {trace.reasoning}
                  </p>
                </>
              )}
              <div className="mt-3 flex gap-2">
                <SuccessButton disabled={rowBusy} onClick={() => act(esc.id, approveEscalation)} className="flex-1">
                  {rowBusy ? "Working…" : "Approve"}
                </SuccessButton>
                <DangerButton disabled={rowBusy} onClick={() => act(esc.id, denyEscalation)} className="flex-1">
                  {rowBusy ? "Working…" : "Deny"}
                </DangerButton>
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
