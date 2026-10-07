"use client";

import { useState, useTransition } from "react";
import { approveEscalation, denyEscalation } from "@/lib/actions/escalations";
import type { Escalation, Trace } from "@/types/db";
import { actionTypeLabel, DangerButton, EmptyState, formatMoney, Icons, Panel, Spinner, SuccessButton } from "./ui";
import { TimeAgo } from "./TimeAgo";
import { ErrorLine } from "./kit";

export function EscalationsPanel({
  escalations,
  tracesById,
  describe,
}: {
  escalations: Escalation[];
  tracesById: Record<string, Trace>;
  /** Says what an action is about in the merchant's terms (who gets paid, for
   *  which order). Optional: the panel still works from the trace alone. */
  describe?: (trace: Trace) => { title: string; detail?: string } | null;
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
      title="Needs your approval"
      description="Your team stopped and asked before going further."
      icon={<Icons.Escalation />}
      accent="var(--decision-escalate)"
      count={pending.length}
      className="min-h-0"
      bodyClassName="max-h-[640px] overflow-y-auto pr-1"
    >
      <ErrorLine error={error} />
      {pending.length === 0 && <EmptyState text="Nothing is waiting for you." hint="When your team wants to pay or price something outside your limits, it shows up here." />}
      <div className="space-y-4">
        {pending.map((esc) => {
          const trace = tracesById[esc.trace_id];
          const rowBusy = isPending && busy?.id === esc.id;
          const approving = rowBusy && busy?.action === "approve";
          const denying = rowBusy && busy?.action === "deny";
          const d = trace ? describe?.(trace) : null;
          const p = trace ? (trace.params as { amount?: number; currency?: string } | null) : null;
          return (
            <div
              key={esc.id}
              className="surface-tile p-6 transition-opacity"
              style={{ borderColor: "color-mix(in srgb, var(--decision-escalate) 35%, var(--hairline))", opacity: rowBusy ? 0.6 : 1 }}
            >
              {/* No trace means the card cannot say what it is asking about.
                  Approving money you cannot see is the single worst thing this
                  panel could offer, so the buttons below go dead rather than
                  the card rendering as a bare pair of them. */}
              {!trace && (
                <div>
                  <p className="text-[15px] font-semibold" style={{ color: "var(--muted)" }}>
                    Details unavailable
                  </p>
                  <p className="mt-1.5 text-[14px] leading-6" style={{ color: "var(--muted-2)" }}>
                    The action behind this request could not be loaded, so there is nothing to show you and nothing to approve on. Reload; if it persists, find it by id
                    in Activity.
                  </p>
                  <p className="num mt-2 text-[12px]" style={{ color: "var(--muted-2)" }}>
                    {esc.trace_id}
                  </p>
                </div>
              )}
              {trace && (
                <>
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="num text-[32px] font-semibold leading-[36px]" style={{ color: "var(--decision-escalate)" }}>
                        {p?.amount && p?.currency ? formatMoney(p.amount, p.currency) : "-"}
                      </p>
                      <p className="mt-2 text-[13px]" style={{ color: "var(--muted)" }}>
                        {actionTypeLabel(trace.action_type)}
                      </p>
                    </div>
                    <span className="shrink-0 text-[13px]" style={{ color: "var(--muted-2)" }}>
                      <TimeAgo iso={esc.created_at} />
                    </span>
                  </div>
                  {d && (
                    <div className="mt-4">
                      <p className="text-[16px] font-medium leading-6">{d.title}</p>
                      {d.detail && (
                        <p className="mt-1 text-[14px] leading-6" style={{ color: "var(--muted)" }}>
                          {d.detail}
                        </p>
                      )}
                    </div>
                  )}
                  <p className="mt-4 rounded-[12px] bg-white/[0.04] px-4 py-3 text-[14px] leading-6" style={{ color: "var(--muted)" }}>
                    {trace.reasoning}
                  </p>
                </>
              )}
              <div className="mt-5 flex gap-3">
                <SuccessButton disabled={rowBusy || !trace} onClick={() => act(esc.id, "approve", approveEscalation)} className="flex-1">
                  {approving && <Spinner />}
                  {approving ? "Approving…" : "Approve"}
                </SuccessButton>
                <DangerButton disabled={rowBusy || !trace} onClick={() => act(esc.id, "deny", denyEscalation)} className="flex-1">
                  {denying && <Spinner />}
                  {denying ? "Denying…" : "Deny"}
                </DangerButton>
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
