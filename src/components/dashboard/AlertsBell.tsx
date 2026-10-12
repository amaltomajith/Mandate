"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Bell } from "@phosphor-icons/react";
import type { Alert } from "@/types/db";
import { EmptyState, Icons } from "./ui";
import { TimeAgo } from "./TimeAgo";

const SEVERITY_META: Record<Alert["severity"], { label: string; color: string; Icon: typeof Icons.Bell }> = {
  high: { label: "Blocked", color: "var(--decision-block)", Icon: Icons.XCircle },
  notable: { label: "Needs attention", color: "var(--decision-escalate)", Icon: Icons.AlertTriangle },
  info: { label: "Resolved", color: "var(--decision-allow)", Icon: Icons.CheckCircle },
};

/**
 * Alerts live behind a bell in the top bar: the same history, out of the way until
 * someone wants it. Keyboard and screen-reader operable: it announces whether it
 * is open, closes on Escape and returns focus to the bell.
 */
export function AlertsBell({ alerts }: { alerts: Alert[] }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const badgeCount = alerts.length > 9 ? "9+" : alerts.length;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="relative">
      <button
        ref={button}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={alerts.length ? `Alerts, ${alerts.length}` : "Alerts"}
        aria-expanded={open}
        aria-haspopup="true"
        aria-controls={open ? panelId : undefined}
        className="focus-ring relative flex h-11 w-11 items-center justify-center rounded-full transition-colors hover:bg-white/[0.08]"
        style={{ color: "var(--muted)" }}
      >
        <Bell size={22} />
        {alerts.length > 0 && (
          <span className="num absolute right-0.5 top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] font-bold text-white" style={{ background: "var(--decision-block)" }}>
            {badgeCount}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden="true" />
          <div id={panelId} role="region" aria-label="Alerts" className="glass absolute right-0 top-14 z-50 max-h-[28rem] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto rounded-[18px] p-4">
            <p className="mb-3 px-1 text-[15px] font-semibold">Alerts</p>
            {alerts.length === 0 && <EmptyState text="No alerts yet." />}
            <ul className="space-y-2.5">
              {alerts.map((alert) => {
                const meta = SEVERITY_META[alert.severity];
                return (
                  <li key={alert.id} className="surface-tile flex items-start gap-3 p-4">
                    <span className="mt-0.5 shrink-0" style={{ color: meta.color }}>
                      <meta.Icon size={20} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-semibold" style={{ color: meta.color }}>
                        {meta.label}
                      </p>
                      <p className="mt-0.5 text-[14px] leading-5" style={{ color: "var(--foreground)" }}>
                        {alert.message}
                      </p>
                      <p className="mt-1 text-[12px]" style={{ color: "var(--muted-2)" }}>
                        <TimeAgo iso={alert.created_at} />
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
