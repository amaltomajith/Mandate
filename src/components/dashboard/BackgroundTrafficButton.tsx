"use client";

import { useState, useTransition } from "react";
import { generateBackgroundTraffic } from "@/lib/actions/backgroundTraffic";
import type { BackgroundTrafficSummary } from "@/lib/demo/backgroundTraffic";
import { formatMoney } from "@/lib/format";
import { GhostButton } from "./ui";

/**
 * A deliberately secondary, utility-styled control (GhostButton, not the
 * demo's PrimaryButton) — this isn't a narrative beat, it's a "make the
 * dashboard look like a living system" button: a burst of ordinary
 * transactions across a small pool of synthetic customers, so Transactions/
 * Agent trust/the policy audit have more than just the scripted demo's
 * handful of rows to work with. Any escalation or block it happens to
 * generate still surfaces normally via the existing alert toasts — no
 * separate results list needed here, just a one-line summary.
 */
export function BackgroundTrafficButton() {
  const [summary, setSummary] = useState<BackgroundTrafficSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function run() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await generateBackgroundTraffic();
        setSummary(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Background traffic generation failed.");
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed px-4 py-3" style={{ borderColor: "var(--panel-border-strong)" }}>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium">Generate background activity</p>
        <p className="mt-0.5 text-[11px]" style={{ color: "var(--muted-2)" }}>
          Fires a burst of ordinary purchases across a few synthetic customers — real, signed MCP
          calls, weighted toward the catalog&apos;s cheaper items — so the dashboard has more than
          just the demo script to show.
        </p>
        {summary && (
          <p className="mt-1.5 text-[11px]" style={{ color: "var(--muted)" }}>
            Generated {summary.generated} transactions ({formatMoney(summary.totalAmountPaise, "INR")} total) —{" "}
            {summary.allowed} allowed, {summary.escalated} escalated, {summary.blocked} blocked.
          </p>
        )}
        {error && (
          <p className="mt-1.5 text-[11px]" style={{ color: "var(--decision-block)" }}>
            {error}
          </p>
        )}
      </div>
      <GhostButton onClick={run} disabled={isPending} className="shrink-0 px-4">
        {isPending ? "Generating…" : "Generate activity"}
      </GhostButton>
    </div>
  );
}
