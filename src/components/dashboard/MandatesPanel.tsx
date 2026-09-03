"use client";

import { useEffect, useState, useTransition } from "react";
import {
  mandateActivity,
  pauseMandate,
  reactivateMandate,
  revokeMandate,
  type MandateActivity,
} from "@/lib/actions/mandates";
import type { Agent, Customer, Mandate } from "@/types/db";
import { EmptyState, GhostButton, Icons, Panel, Spinner, SuccessButton, formatMoney, relativeTime } from "./ui";

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
/** Active first, then paused, then the terminal ones. A revoked mandate from
 *  last week competing for attention with a live one is the list sorted by
 *  nothing in particular. */
const STATUS_ORDER: Record<Mandate["status"], number> = {
  active: 0,
  paused: 1,
  revoked: 2,
  expired: 3,
};

export function MandatesPanel({ mandates, agents, customers }: { mandates: Mandate[]; agents: Agent[]; customers: Customer[] }) {
  const [activity, setActivity] = useState<MandateActivity[]>([]);

  useEffect(() => {
    mandateActivity()
      .then(setActivity)
      .catch(() => {
        /* the usage line just stays absent; the controls still work */
      });
  }, [mandates.length]);

  const agentNameById = new Map(agents.map((a) => [a.id, a.name]));
  const customerNameById = new Map(customers.map((c) => [c.id, c.name]));

  const [isPending, startTransition] = useTransition();
  // Which row AND which action — a single busy id made every button on the row
  // announce "Working…", so pausing looked like it might also be revoking.
  const [busy, setBusy] = useState<{ id: string; action: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  function act(id: string, action: string, fn: (id: string) => Promise<void>) {
    setError(null);
    setBusy({ id, action });
    startTransition(async () => {
      try {
        await fn(id);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Action failed.");
      } finally {
        setBusy(null);
      }
    });
  }

  function actWithConfirm(id: string, action: string, confirmMessage: string, fn: (id: string) => Promise<void>) {
    if (!window.confirm(confirmMessage)) return;
    act(id, action, fn);
  }

  /**
   * The confirm for the one action that cannot be undone.
   *
   * Names the agent and the customer, because "revoke this mandate?" asks
   * someone to confirm a thing they would have to go and look up to check --
   * and a confirm that cannot be checked is a speed bump, not a safeguard.
   */
  function revokeMessage(agentName: string, customerName: string): string {
    return (
      `Revoke ${agentName}'s mandate for ${customerName}?\n\n` +
      `It will be blocked from acting for this customer immediately, and this cannot be undone. ` +
      `A new mandate would have to be established to resume.\n\n` +
      `To stop it temporarily instead, use Pause.`
    );
  }

  return (
    <Panel title="Mandates" icon={<Icons.Shield />} accent="var(--entity-mandate)">
      {error && (
        <p className="mb-3 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: "var(--decision-block)", color: "var(--decision-block)", background: "color-mix(in srgb, var(--decision-block) 14%, transparent)" }}>
          {error}
        </p>
      )}

      {/* Said in the interface, not only in a comment. This is the ENFORCED
          control -- it runs inside the request path, before the policy engine,
          and does not care whether the agent cooperates. Pausing an AGENT is
          the other thing entirely: a request the agent may ignore. A merchant
          reaching for "stop" during an incident has to know which one they
          just got. */}
      <p className="mb-3 text-[11.5px] leading-relaxed" style={{ color: "var(--muted)" }}>
        A standing authorization for one agent to act for one customer. Pausing or revoking here is
        <strong className="font-semibold text-[var(--foreground)]"> enforced</strong> — it runs before
        the policy engine and does not depend on the agent cooperating, unlike pausing the agent
        itself.
      </p>

      {mandates.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
          {(["active", "paused", "revoked", "expired"] as const).map((st) => {
            const n = mandates.filter((m) => m.status === st).length;
            if (n === 0) return null;
            return (
              <span key={st} style={{ color: STATUS_STYLE[st].color }}>
                <span className="font-semibold tabular-nums">{n}</span> {STATUS_STYLE[st].label.toLowerCase()}
              </span>
            );
          })}
        </div>
      )}

      {mandates.length === 0 ? (
        <EmptyState text="No mandates yet — one is created automatically the first time an agent's subscription.create succeeds with a customer attached." />
      ) : (
        <div className="space-y-2.5">
          {[...mandates].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]).map((m) => {
            const rowBusy = isPending && busy?.id === m.id;
            const running = (action: string) => rowBusy && busy?.action === action;
            const status = STATUS_STYLE[m.status];
            // Bound once per row: the revoke confirm names both, and inlining
            // them twice more would let the label and the confirm drift apart.
            const agentName = (m.agent_id ? agentNameById.get(m.agent_id) : null) ?? "Unknown agent";
            // A mandate whose agent has been retired still says "active",
            // because it is -- but the agent's key no longer verifies, so
            // nothing can ever be done under it. Saying only "active" there is
            // technically true and practically a lie.
            const agentRetired = !!m.agent_id && agents.find((a) => a.id === m.agent_id)?.retired === true;
            const customerName = (m.customer_id ? customerNameById.get(m.customer_id) : null) ?? "Unknown customer";
            return (
              <div
                key={m.id}
                className="rounded-xl border p-3.5"
                style={{
                  borderColor: "var(--panel-border)",
                  background: "var(--panel-2)",
                  // Terminal mandates stay readable but stop competing. They
                  // are history, not something anyone can act on.
                  opacity: m.status === "revoked" || m.status === "expired" ? 0.6 : 1,
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">
                    {agentName}
                    <span style={{ color: "var(--muted-2)" }}> → </span>
                    {customerName}
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
                {agentRetired && (m.status === "active" || m.status === "paused") && (
                  <p className="mt-1 text-[11px]" style={{ color: "var(--decision-escalate)" }}>
                    This agent is retired — its key no longer verifies, so nothing can act under this
                    mandate whatever it says here.
                  </p>
                )}
                {/* What this authorization has actually stood behind. The panel
                    used to show permissions with no evidence any of them were
                    ever exercised -- a mandate covering forty actions and one
                    covering none looked identical, and they are not remotely
                    the same risk. Derived from traces, never stored. */}
                <p className="mt-1.5 text-[11px]" style={{ color: "var(--muted-2)" }}>
                  {(() => {
                    const use = activity.find((a) => a.mandateId === m.id);
                    if (!use || use.actions === 0) {
                      return `created ${relativeTime(m.created_at)} · never used`;
                    }
                    return (
                      <>
                        <span className="tabular-nums" style={{ color: "var(--foreground)" }}>
                          {use.actions}
                        </span>{" "}
                        action{use.actions === 1 ? "" : "s"}
                        {use.settledPaise > 0 && (
                          <>
                            {" · "}
                            <span className="tabular-nums" style={{ color: "var(--foreground)" }}>
                              {formatMoney(use.settledPaise, "INR")}
                            </span>{" "}
                            settled
                          </>
                        )}
                        {use.lastUsed && ` · last used ${relativeTime(use.lastUsed)}`}
                      </>
                    );
                  })()}
                </p>

                <div className="mt-3 flex gap-2">
                  {m.status === "active" && (
                    <>
                      {/* Weight follows consequence, not severity of colour.
                          Pause is reversible and is what a merchant wants
                          almost every time; revoke is terminal, like a real
                          UPI Autopay revocation. The loud control was the one
                          you cannot take back. */}
                      <SuccessButton disabled={rowBusy} onClick={() => act(m.id, "pause", pauseMandate)} className="flex-1">
                        <span className="flex items-center justify-center gap-1.5">
                          {running("pause") && <Spinner />}
                          {running("pause") ? "Pausing…" : "Pause"}
                        </span>
                      </SuccessButton>
                      <GhostButton
                        disabled={rowBusy}
                        onClick={() =>
                          actWithConfirm(
                            m.id,
                            "revoke",
                            revokeMessage(agentName, customerName),
                            revokeMandate
                          )
                        }
                        className="shrink-0 px-2.5! py-1.5! text-[10px]!"
                      >
                        {running("revoke") ? "Revoking…" : "Revoke"}
                      </GhostButton>
                    </>
                  )}
                  {m.status === "paused" && (
                    <>
                      <SuccessButton disabled={rowBusy} onClick={() => act(m.id, "resume", reactivateMandate)} className="flex-1">
                        <span className="flex items-center justify-center gap-1.5">
                          {running("resume") && <Spinner />}
                          {running("resume") ? "Resuming…" : "Resume"}
                        </span>
                      </SuccessButton>
                      <GhostButton
                        disabled={rowBusy}
                        onClick={() =>
                          actWithConfirm(m.id, "revoke", revokeMessage(agentName, customerName), revokeMandate)
                        }
                        className="shrink-0 px-2.5! py-1.5! text-[10px]!"
                      >
                        {running("revoke") ? "Revoking…" : "Revoke"}
                      </GhostButton>
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
