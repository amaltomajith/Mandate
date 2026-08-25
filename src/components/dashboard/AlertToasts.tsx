"use client";

import { useEffect, useRef, useState } from "react";
import type { Alert } from "@/types/db";
import { Icons } from "./ui";
import { relativeTime } from "./ui";

const AUTO_DISMISS_MS = 8000;
const MAX_VISIBLE = 4;

const SEVERITY_META: Record<Alert["severity"], { label: string; color: string; Icon: typeof Icons.Bell }> = {
  high: { label: "Blocked", color: "var(--decision-block)", Icon: Icons.XCircle },
  notable: { label: "Needs attention", color: "var(--decision-escalate)", Icon: Icons.AlertTriangle },
  info: { label: "Resolved", color: "var(--decision-allow)", Icon: Icons.CheckCircle },
};

/**
 * Live toast notifications for alerts as they happen — the "something just
 * happened, here's what and why" moment, distinct from the Alerts panel's
 * permanent history. Only toasts for alerts that arrive *after* this component
 * mounts (diffed against a baseline snapshot), so loading the dashboard with
 * existing history doesn't fire a wall of toasts for things that already
 * happened.
 */
export function AlertToasts({ alerts }: { alerts: Alert[] }) {
  const [toasts, setToasts] = useState<Alert[]>([]);
  const seenIds = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (seenIds.current === null) {
      seenIds.current = new Set(alerts.map((a) => a.id));
      return;
    }

    const fresh = alerts.filter((a) => !seenIds.current!.has(a.id));
    if (fresh.length === 0) return;

    fresh.forEach((a) => seenIds.current!.add(a.id));
    setToasts((prev) => [...fresh, ...prev].slice(0, MAX_VISIBLE));

    fresh.forEach((a) => {
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== a.id));
      }, AUTO_DISMISS_MS);
    });
  }, [alerts]);

  function dismiss(id: string) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed right-4 top-20 z-50 flex w-[340px] flex-col gap-2.5">
      {toasts.map((toast) => {
        const meta = SEVERITY_META[toast.severity];
        return (
          <div
            key={toast.id}
            className="toast-in panel-card-lg pointer-events-auto flex items-start gap-3 rounded-xl p-3.5"
            style={{ borderLeft: `3px solid ${meta.color}` }}
          >
            <span className="mt-0.5 shrink-0" style={{ color: meta.color }}>
              <meta.Icon size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: meta.color }}>
                  {meta.label}
                </p>
                <span className="text-[10px]" style={{ color: "var(--muted-2)" }}>
                  {relativeTime(toast.created_at)}
                </span>
              </div>
              <p className="mt-0.5 text-[13px] leading-snug" style={{ color: "var(--foreground)" }}>
                {toast.message}
              </p>
            </div>
            <button
              onClick={() => dismiss(toast.id)}
              className="shrink-0 rounded-md p-1 opacity-50 transition-opacity hover:opacity-100"
              style={{ color: "var(--muted)" }}
              aria-label="Dismiss"
            >
              <Icons.X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
