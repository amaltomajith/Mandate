import type { Alert } from "@/types/db";
import { EmptyState, Icons, Panel, relativeTime } from "./ui";

const SEVERITY_COLOR: Record<Alert["severity"], string> = {
  info: "var(--muted-2)",
  notable: "var(--decision-escalate)",
  high: "var(--decision-block)",
};

export function AlertsPanel({ alerts }: { alerts: Alert[] }) {
  return (
    <Panel title="Alerts" icon={<Icons.Bell />} accent="var(--entity-mandate)">
      {alerts.length === 0 && <EmptyState text="No alerts yet." />}
      <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
        {alerts.map((alert) => (
          <div key={alert.id} className="flex items-start gap-2.5 rounded-lg px-2 py-2 text-xs hover:bg-[var(--panel-2)]">
            <span
              className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: SEVERITY_COLOR[alert.severity], boxShadow: `0 0 8px ${SEVERITY_COLOR[alert.severity]}` }}
            />
            <div>
              <p style={{ color: "var(--foreground)" }}>{alert.message}</p>
              <p className="mt-0.5" style={{ color: "var(--muted-2)" }}>
                {relativeTime(alert.created_at)}
              </p>
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}
