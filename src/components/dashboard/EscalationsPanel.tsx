"use client";

import { useState, useTransition } from "react";
import { approveEscalation, denyEscalation } from "@/lib/actions/escalations";
import type { Escalation, Trace } from "@/types/db";
import { DangerButton, EmptyState, Icons, Panel, SuccessButton, relativeTime } from "./ui";

export function EscalationsPanel({
  escalations,
  tracesById,
}: {
  escalations: Escalation[];
  tracesById: Record<string, Trace>;
}) {
  const pending = escalations.filter((e) => e.status === "pending");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

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
                  <p className="mt-2 text-sm font-medium">{trace.action_type}</p>
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
