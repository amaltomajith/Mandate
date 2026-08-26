"use client";

import { useState, useTransition } from "react";
import { pauseMandate, reactivateMandate, revokeMandate } from "@/lib/actions/mandates";
import type { Agent, Customer, Mandate } from "@/types/db";
import { DangerButton, EmptyState, GhostButton, Icons, Panel, SuccessButton, relativeTime } from "./ui";

const TYPE_LABEL: Record<Mandate["type"], string> = {
  upi_autopay: "UPI Autopay",
  ap2_style: "AP2-style",
};

const STATUS_STYLE: Record<Mandate["status"], { label: string; color: string }> = {
  active: { label: "Active", color: "var(--decision-allow)" },
  paused: { label: "Paused", color: "var(--decision-escalate)" },
  revoked: { label: "Revoked", color: "var(--decision-block)" },
  expired: { label: "Expired", color: "var(--muted-2)" },
};

/**
 * The one thing this product is named for, made real: a standing
 * authorization for one agent to act on one customer's behalf, which the
 * merchant can pause or revoke here — and which `runActionEvaluation`
 * (src/lib/mcp/tools/actionEvaluator.ts) actually checks on every action
 * before the policy engine even runs. Revoking here is not cosmetic: the
 * agent's very next attempted action under it gets blocked, live.
 */
export function MandatesPanel({ mandates, agents, customers }: { mandates: Mandate[]; agents: Agent[]; customers: Customer[] }) {
  const agentNameById = new Map(agents.map((a) => [a.id, a.name]));
  const customerNameById = new Map(customers.map((c) => [c.id, c.name]));

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

  function actWithConfirm(id: string, confirmMessage: string, fn: (id: string) => Promise<void>) {
    if (!window.confirm(confirmMessage)) return;
    act(id, fn);
  }

  return (
    <Panel title="Mandates" icon={<Icons.Shield />} accent="var(--entity-mandate)">
      {error && (
        <p className="mb-3 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: "var(--decision-block)", color: "var(--decision-block)", background: "color-mix(in srgb, var(--decision-block) 14%, transparent)" }}>
          {error}
        </p>
      )}

      {mandates.length === 0 ? (
        <EmptyState text="No mandates yet — one is created automatically the first time an agent's subscription.create succeeds with a customer attached." />
      ) : (
        <div className="space-y-2.5">
          {mandates.map((m) => {
            const busy = isPending && busyId === m.id;
            const status = STATUS_STYLE[m.status];
            return (
              <div key={m.id} className="rounded-xl border p-3.5" style={{ borderColor: "var(--panel-border)", background: "var(--panel-2)" }}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">
                    {m.agent_id ? agentNameById.get(m.agent_id) ?? "Unknown agent" : "Unknown agent"}
                    <span style={{ color: "var(--muted-2)" }}> → </span>
                    {m.customer_id ? customerNameById.get(m.customer_id) ?? "Unknown customer" : "Unknown customer"}
                  </span>
                  <span
                    className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-bold tracking-wide"
                    style={{ background: `color-mix(in srgb, ${status.color} 16%, transparent)`, color: status.color }}
                  >
                    {status.label}
                  </span>
                </div>
                <p className="mt-1.5 font-mono text-[11px]" style={{ color: "var(--muted)" }}>
                  {TYPE_LABEL[m.type]} {m.razorpay_ref ? `· ${m.razorpay_ref}` : ""}
                </p>
                <p className="mt-1 text-[11px]" style={{ color: "var(--muted-2)" }}>
                  created {relativeTime(m.created_at)}
                </p>

                <div className="mt-3 flex gap-2">
                  {m.status === "active" && (
                    <>
                      <GhostButton disabled={busy} onClick={() => act(m.id, pauseMandate)} className="flex-1">
                        {busy ? "Working…" : "Pause"}
                      </GhostButton>
                      <DangerButton
                        disabled={busy}
                        onClick={() =>
                          actWithConfirm(
                            m.id,
                            "Revoke this mandate? This agent will be blocked from acting on this customer's behalf immediately, and revocation can't be undone — a new mandate would be needed to resume.",
                            revokeMandate
                          )
                        }
                        className="flex-1"
                      >
                        {busy ? "Working…" : "Revoke"}
                      </DangerButton>
                    </>
                  )}
                  {m.status === "paused" && (
                    <>
                      <SuccessButton disabled={busy} onClick={() => act(m.id, reactivateMandate)} className="flex-1">
                        {busy ? "Working…" : "Resume"}
                      </SuccessButton>
                      <DangerButton
                        disabled={busy}
                        onClick={() => actWithConfirm(m.id, "Revoke this mandate permanently?", revokeMandate)}
                        className="flex-1"
                      >
                        {busy ? "Working…" : "Revoke"}
                      </DangerButton>
                    </>
                  )}
                  {(m.status === "revoked" || m.status === "expired") && (
                    <p className="flex-1 py-2 text-center text-[11px]" style={{ color: "var(--muted-2)" }}>
                      No further action — {m.status}.
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
