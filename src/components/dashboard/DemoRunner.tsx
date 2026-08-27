"use client";

import { useState, useTransition } from "react";
import { runDemo } from "@/lib/actions/demo";
import type { DemoStep } from "@/lib/demo/runDemo";
import { Icons, PrimaryButton } from "./ui";

const STATUS_META: Record<DemoStep["status"], { color: string; Icon: typeof Icons.Bell }> = {
  ok: { color: "var(--decision-allow)", Icon: Icons.CheckCircle },
  escalated: { color: "var(--decision-escalate)", Icon: Icons.AlertTriangle },
  blocked: { color: "var(--decision-block)", Icon: Icons.XCircle },
  rejected: { color: "var(--decision-reject)", Icon: Icons.Shield },
  error: { color: "var(--decision-block)", Icon: Icons.XCircle },
};

/**
 * One click, no terminal: runs the exact scenario in HANDOVER.md's "Demo
 * script" (a few normal purchases, one escalation, one rejected forgery
 * attempt) via the same real MCP calls and Web Bot Auth signing
 * `scripts/checkout-agent.ts` does — see src/lib/demo/runDemo.ts. Left
 * runnable repeatedly on purpose (not hidden once "done") so it doubles as a
 * live-pitch button: re-run it any time to put fresh activity on the graph.
 */
export function DemoRunner() {
  const [steps, setSteps] = useState<DemoStep[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function run() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await runDemo();
        setSteps(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Demo run failed.");
      }
    });
  }

  return (
    <div className="panel-card rounded-2xl p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">See it work</p>
          <p className="mt-0.5 text-xs" style={{ color: "var(--muted)" }}>
            One click runs an AI buyer agent through a small catalog — a real mandate established,
            a purchase, a proposed upsell, another purchase over the approval threshold, the
            mandate revoked (blocking the agent&apos;s very next action), and one forged request
            rejected before it ever reaches the policy engine. All real, signed MCP calls against
            this app.
          </p>
        </div>
        <PrimaryButton onClick={run} disabled={isPending} className="shrink-0 px-5">
          {isPending ? "Running…" : steps ? "Run again" : "Run demo"}
        </PrimaryButton>
      </div>

      {error && (
        <p className="mt-3 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: "var(--decision-block)", color: "var(--decision-block)", background: "color-mix(in srgb, var(--decision-block) 14%, transparent)" }}>
          {error}
        </p>
      )}

      {steps && (
        // Capped height + internal scroll, not unbounded growth — with
        // enough steps in one run (mandate lifecycle + purchases + upsells +
        // self-defense), letting this list grow the whole page pushed the 3D
        // graph below the fold entirely. The graph's position stays fixed
        // now regardless of how many steps a run produces.
        <div
          className="mt-4 max-h-80 space-y-1.5 overflow-y-auto border-t pt-4 pr-1"
          style={{ borderColor: "var(--panel-border)" }}
        >
          {steps.map((step, i) => {
            const meta = STATUS_META[step.status];
            return (
              <div key={i} className="flex items-start gap-2.5 rounded-lg px-2 py-1.5" style={{ background: "var(--panel-2)" }}>
                <span className="mt-0.5 shrink-0" style={{ color: meta.color }}>
                  <meta.Icon size={14} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <p className="text-[13px] font-medium">{step.label}</p>
                    {step.kind === "upsell" && (
                      <span
                        className="rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide"
                        style={{ background: "color-mix(in srgb, var(--entity-mandate) 20%, transparent)", color: "var(--entity-mandate)" }}
                      >
                        Upsell
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] leading-snug" style={{ color: "var(--muted)" }}>
                    {step.detail}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
