"use client";

import { useState, useTransition } from "react";
import { approveEscalation, denyEscalation } from "@/lib/actions/escalations";
import type { Escalation, Trace } from "@/types/db";
import { EmptyState, Panel, relativeTime } from "./ui";

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
    <Panel title="Escalations" count={pending.length}>
      {error && (
        <p className="mb-2 text-xs" style={{ color: "var(--decision-block)" }}>
          {error}
        </p>
      )}
      {pending.length === 0 && <EmptyState text="No pending escalations." />}
      <div className="space-y-3">
        {pending.map((esc) => {
          const trace = tracesById[esc.trace_id];
          const rowBusy = isPending && busyId === esc.id;
          return (
            <div key={esc.id} className="rounded-lg border p-3" style={{ borderColor: "var(--panel-border)" }}>
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold" style={{ color: "var(--decision-escalate)" }}>
                  ESCALATE
                </span>
                <span className="text-xs" style={{ color: "var(--muted)" }}>
                  {relativeTime(esc.created_at)}
                </span>
              </div>
              {trace && (
                <>
                  <p className="mt-1 text-sm font-medium">{trace.action_type}</p>
                  <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
                    {trace.reasoning}
                  </p>
                </>
              )}
              <div className="mt-3 flex gap-2">
                <button
                  disabled={rowBusy}
                  onClick={() => act(esc.id, approveEscalation)}
                  className="flex-1 rounded-md py-1.5 text-xs font-medium text-black disabled:opacity-50"
                  style={{ background: "var(--decision-allow)" }}
                >
                  {rowBusy ? "Working…" : "Approve"}
                </button>
                <button
                  disabled={rowBusy}
                  onClick={() => act(esc.id, denyEscalation)}
                  className="flex-1 rounded-md py-1.5 text-xs font-medium text-black disabled:opacity-50"
                  style={{ background: "var(--decision-block)" }}
                >
                  {rowBusy ? "Working…" : "Deny"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
