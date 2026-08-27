"use client";

import { useEffect, useRef, useState } from "react";
import type { Alert } from "@/types/db";
import { Icons } from "./ui";
import { relativeTime } from "./ui";

const AUTO_DISMISS_MS = 8000;
const MAX_VISIBLE = 3;

interface ToastGroup {
  key: string;
  severity: Alert["severity"];
  message: string;
  count: number;
  latestId: string;
  latestCreatedAt: string;
}

const SEVERITY_META: Record<Alert["severity"], { label: string; color: string; Icon: typeof Icons.Bell }> = {
  high: { label: "Blocked", color: "var(--decision-block)", Icon: Icons.XCircle },
  notable: { label: "Needs attention", color: "var(--decision-escalate)", Icon: Icons.AlertTriangle },
  info: { label: "Resolved", color: "var(--decision-allow)", Icon: Icons.CheckCircle },
};

/**
 * Live toast notifications for alerts as they happen — the "something just
 * happened, here's what and why" moment, distinct from the Alerts panel's
 * (bell dropdown) permanent history. Only toasts for alerts that arrive
 * *after* this component mounts (diffed against a baseline snapshot), so
 * loading the dashboard with existing history doesn't fire a wall of toasts.
 *
 * A full demo run fires several near-identical alerts in quick succession
 * (e.g. three blocked purchases all carrying the exact same "mandate
 * revoked" message) — stacking each as its own full-height card both looked
 * messy and buried the panels behind it. Same severity + same message now
 * collapses into one toast with a "×N" count, refreshed and re-timed on
 * every repeat — the common case during a demo run is one or two toasts
 * on screen, not a wall of duplicates.
 */
export function AlertToasts({ alerts }: { alerts: Alert[] }) {
  const [toasts, setToasts] = useState<ToastGroup[]>([]);
  const seenIds = useRef<Set<string> | null>(null);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    if (seenIds.current === null) {
      seenIds.current = new Set(alerts.map((a) => a.id));
      return;
    }

    const fresh = alerts.filter((a) => !seenIds.current!.has(a.id));
    if (fresh.length === 0) return;
    fresh.forEach((a) => seenIds.current!.add(a.id));

    setToasts((prev) => {
      let next = [...prev];
      for (const a of fresh) {
        const key = `${a.severity}:${a.message}`;
        const existingIndex = next.findIndex((t) => t.key === key);
        if (existingIndex >= 0) {
          next[existingIndex] = {
            ...next[existingIndex],
            count: next[existingIndex].count + 1,
            latestId: a.id,
            latestCreatedAt: a.created_at,
          };
          // Bump the refreshed group back to the front, so a repeated alert
          // reads as "still happening," not stuck at the bottom of the pile.
          const [bumped] = next.splice(existingIndex, 1);
          next = [bumped, ...next];
        } else {
          next = [{ key, severity: a.severity, message: a.message, count: 1, latestId: a.id, latestCreatedAt: a.created_at }, ...next];
        }
      }
      return next.slice(0, MAX_VISIBLE);
    });

    fresh.forEach((a) => {
      const key = `${a.severity}:${a.message}`;
      const existing = timers.current.get(key);
      if (existing) clearTimeout(existing);
      timers.current.set(
        key,
        setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.key !== key));
          timers.current.delete(key);
        }, AUTO_DISMISS_MS)
      );
    });
  }, [alerts]);

  function dismiss(key: string) {
    const existing = timers.current.get(key);
    if (existing) clearTimeout(existing);
    timers.current.delete(key);
    setToasts((prev) => prev.filter((t) => t.key !== key));
  }

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed right-4 top-20 z-50 flex w-80 flex-col gap-2">
      {toasts.map((toast) => {
        const meta = SEVERITY_META[toast.severity];
        return (
          <div
            key={toast.key}
            className="toast-in pointer-events-auto flex items-start gap-2.5 rounded-xl border p-3 shadow-2xl backdrop-blur-md"
            style={{
              borderLeft: `3px solid ${meta.color}`,
              borderTop: "1px solid var(--panel-border)",
              borderRight: "1px solid var(--panel-border)",
              borderBottom: "1px solid var(--panel-border)",
              background: "color-mix(in srgb, var(--panel) 96%, transparent)",
            }}
          >
            <span className="mt-0.5 shrink-0" style={{ color: meta.color }}>
              <meta.Icon size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <p className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: meta.color }}>
                  {meta.label}
                </p>
                {toast.count > 1 && (
                  <span
                    className="rounded-full px-1.5 py-0.5 text-[9px] font-bold"
                    style={{ background: `color-mix(in srgb, ${meta.color} 20%, transparent)`, color: meta.color }}
                  >
                    ×{toast.count}
                  </span>
                )}
                <span className="ml-auto text-[10px]" style={{ color: "var(--muted-2)" }}>
                  {relativeTime(toast.latestCreatedAt)}
                </span>
              </div>
              <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug" style={{ color: "var(--foreground)" }}>
                {toast.message}
              </p>
            </div>
            <button
              onClick={() => dismiss(toast.key)}
              className="shrink-0 rounded-md p-1 opacity-50 transition-opacity hover:opacity-100"
              style={{ color: "var(--muted)" }}
              aria-label="Dismiss"
            >
              <Icons.X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
