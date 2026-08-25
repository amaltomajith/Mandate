import type { Alert } from "@/types/db";
import { EmptyState, Icons, Panel, relativeTime } from "./ui";

const SEVERITY_META: Record<Alert["severity"], { label: string; color: string; Icon: typeof Icons.Bell }> = {
  high: { label: "Blocked", color: "var(--decision-block)", Icon: Icons.XCircle },
  notable: { label: "Needs attention", color: "var(--decision-escalate)", Icon: Icons.AlertTriangle },
  info: { label: "Resolved", color: "var(--decision-allow)", Icon: Icons.CheckCircle },
};

export function AlertsPanel({ alerts }: { alerts: Alert[] }) {
  return (
    <Panel title="Alerts" icon={<Icons.Bell />} accent="var(--entity-mandate)">
      {alerts.length === 0 && <EmptyState text="No alerts yet — they'll show up here the moment something needs your attention." />}
      <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
        {alerts.map((alert) => {
          const meta = SEVERITY_META[alert.severity];
          return (
            <div
              key={alert.id}
              className="flex items-start gap-2.5 rounded-lg px-2.5 py-2.5"
              style={{ background: "var(--panel-2)" }}
            >
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
                  {relativeTime(alert.created_at)}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
