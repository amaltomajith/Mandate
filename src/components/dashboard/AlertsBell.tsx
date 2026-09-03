"use client";

import { useState } from "react";
import type { Alert } from "@/types/db";
import { EmptyState, Icons } from "./ui";
import { TimeAgo } from "./TimeAgo";

const SEVERITY_META: Record<Alert["severity"], { label: string; color: string; Icon: typeof Icons.Bell }> = {
  high: { label: "Blocked", color: "var(--decision-block)", Icon: Icons.XCircle },
  notable: { label: "Needs attention", color: "var(--decision-escalate)", Icon: Icons.AlertTriangle },
  info: { label: "Resolved", color: "var(--decision-allow)", Icon: Icons.CheckCircle },
};

/**
 * Alerts moved out of the main Overview grid (it was making the tab feel
 * cluttered) into a header bell + dropdown — the same information, just
 * out of the way until someone actually wants to look at it.
 */
export function AlertsBell({ alerts }: { alerts: Alert[] }) {
  const [open, setOpen] = useState(false);
  const badgeCount = alerts.length > 9 ? "9+" : alerts.length;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-[var(--panel-2)]"
        style={{ color: "var(--muted)" }}
        aria-label="Alerts"
      >
        <Icons.Bell size={16} />
        {alerts.length > 0 && (
          <span
            className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-bold text-white"
            style={{ background: "var(--decision-block)" }}
          >
            {badgeCount}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="panel-card-lg absolute right-0 top-10 z-50 max-h-96 w-80 overflow-y-auto rounded-xl p-3"
          >
            <p className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--muted-2)" }}>
              Alerts
            </p>
            {alerts.length === 0 && <EmptyState text="No alerts yet." />}
            <div className="space-y-2">
              {alerts.map((alert) => {
                const meta = SEVERITY_META[alert.severity];
                return (
                  <div key={alert.id} className="flex items-start gap-2.5 rounded-lg px-2.5 py-2.5" style={{ background: "var(--panel-2)" }}>
                    <span className="mt-0.5 shrink-0" style={{ color: meta.color }}>
                      <meta.Icon size={15} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: meta.color }}>
                        {meta.label}
                      </p>
                      <p className="mt-0.5 text-[13px] leading-snug" style={{ color: "var(--foreground)" }}>
                        {alert.message}
                      </p>
                      <p className="mt-0.5 text-[11px]" style={{ color: "var(--muted-2)" }}>
                        <TimeAgo iso={alert.created_at} />
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
