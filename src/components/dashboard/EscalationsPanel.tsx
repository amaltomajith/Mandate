"use client";

import { useState, useTransition } from "react";
import { approveEscalation, denyEscalation } from "@/lib/actions/escalations";
import type { Escalation, Trace } from "@/types/db";
import { actionTypeLabel, DangerButton, EmptyState, formatMoney, Icons, Panel, Spinner, SuccessButton } from "./ui";
import { TimeAgo } from "./TimeAgo";

export function EscalationsPanel({
  escalations,
  tracesById,
}: {
  escalations: Escalation[];
  tracesById: Record<string, Trace>;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Which row AND which of its two actions — a single busy id made both
  // buttons announce "Working…", so approving looked like it might also be
  // denying. Only the button actually running says anything.
  const [busy, setBusy] = useState<{ id: string; action: "approve" | "deny" } | null>(null);
  // `escalations` comes from the server and only refreshes on the dashboard's
  // 4s poll, so without this a card sat there looking actionable for seconds
  // after being approved — long enough to click again and get told it was
  // already resolved, which reads as a bug rather than a double-click.
  const [resolvedLocally, setResolvedLocally] = useState<Set<string>>(new Set());

  const pending = escalations.filter((e) => e.status === "pending" && !resolvedLocally.has(e.id));

  function act(id: string, action: "approve" | "deny", fn: (id: string) => Promise<void>) {
    setError(null);
    setBusy({ id, action });
    startTransition(async () => {
      try {
        await fn(id);
        setResolvedLocally((prev) => new Set(prev).add(id));
      } catch (err) {
        const message = err instanceof Error ? err.message : "Action failed.";
        // A conflicting resolution ("already approved" when denying, or vice
        // versa) means the queue moved on: drop the card rather than leaving a
        // stale one sitting there, but still say what happened, because the
        // outcome is not the one this click asked for.
        setError(message);
        if (message.includes("already")) setResolvedLocally((prev) => new Set(prev).add(id));
      } finally {
        setBusy(null);
      }
    });
  }

  return (
    <Panel
      title="Escalations"
      icon={<Icons.Escalation />}
      accent="var(--decision-escalate)"
      count={pending.length}
      // Takes whatever the trust panel below doesn't need, and scrolls inside
      // that rather than stretching the column — a busy queue used to push the
      // entity graph beside it off the bottom of the screen. This is the panel
      // that grows without bound, so it gets the flexible share.
      className="min-h-0 flex-1"
      bodyClassName="overflow-y-auto pr-1"
    >
      {error && (
        <p className="mb-3 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: "var(--decision-block)", color: "var(--decision-block)", background: "color-mix(in srgb, var(--decision-block) 14%, transparent)" }}>
          {error}
        </p>
      )}
      {pending.length === 0 && <EmptyState text="No pending escalations — the queue is clear." />}
      <div className="space-y-3">
        {pending.map((esc) => {
          const trace = tracesById[esc.trace_id];
          const rowBusy = isPending && busy?.id === esc.id;
          const approving = rowBusy && busy?.action === "approve";
          const denying = rowBusy && busy?.action === "deny";
          return (
            <div
              key={esc.id}
              className="rounded-xl border p-3.5 transition-opacity"
              style={{
                borderColor: "color-mix(in srgb, var(--decision-escalate) 30%, var(--panel-border))",
                background: "var(--panel-2)",
                opacity: rowBusy ? 0.6 : 1,
              }}
            >
              {/* No trace means the card cannot say what it is asking about.
                  Approving money you cannot see is the single worst thing this
                  panel could offer, so the buttons below go dead rather than
                  the card rendering as a bare pair of them -- which is exactly
                  what it used to do, and why five of these appeared as empty
                  approve/deny pairs once the trace window filled up. */}
              {!trace && (
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold" style={{ color: "var(--muted)" }}>
                      Details unavailable
                    </p>
                    <p className="mt-1 text-[11px] leading-snug" style={{ color: "var(--muted-2)" }}>
                      The action behind this request could not be loaded, so there is nothing to show
                      you and nothing to approve on. Reload; if it persists, find it by id in
                      Transactions.
                    </p>
                    <p className="mt-1 font-mono text-[10px]" style={{ color: "var(--muted-2)" }}>
                      {esc.trace_id}
                    </p>
                  </div>
                  <span className="shrink-0 text-[10px]" style={{ color: "var(--muted-2)" }}>
                    <TimeAgo iso={esc.created_at} />
                  </span>
                </div>
              )}
              {trace && (
                <>
                  {/* Amount first and large: it is the thing a merchant decides
                      on, and it is what distinguishes one queued item from the
                      next when several are waiting. */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[19px] font-semibold leading-none tabular-nums" style={{ color: "var(--decision-escalate)" }}>
                        {(() => {
                          const p = trace.params as { amount?: number; currency?: string } | null;
                          return p?.amount && p?.currency ? formatMoney(p.amount, p.currency) : "—";
                        })()}
                      </p>
                      <p className="mt-1.5 truncate text-[12px] font-medium">{actionTypeLabel(trace.action_type)}</p>
                    </div>
                    <span className="shrink-0 text-[10px]" style={{ color: "var(--muted-2)" }}>
                      <TimeAgo iso={esc.created_at} />
                    </span>
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed" style={{ color: "var(--muted)" }}>
                    {trace.reasoning}
                  </p>
                </>
              )}
              <div className="mt-3 flex gap-2">
                <SuccessButton
                  disabled={rowBusy || !trace}
                  onClick={() => act(esc.id, "approve", approveEscalation)}
                  className="flex-1"
                >
                  <span className="flex items-center justify-center gap-1.5">
                    {approving && <Spinner />}
                    {approving ? "Approving…" : "Approve"}
                  </span>
                </SuccessButton>
                <DangerButton
                  disabled={rowBusy || !trace}
                  onClick={() => act(esc.id, "deny", denyEscalation)}
                  className="flex-1"
                >
                  <span className="flex items-center justify-center gap-1.5">
                    {denying && <Spinner />}
                    {denying ? "Denying…" : "Deny"}
                  </span>
                </DangerButton>
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
