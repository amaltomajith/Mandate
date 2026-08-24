import type { Alert } from "@/types/db";
import { EmptyState, Panel, relativeTime } from "./ui";

const SEVERITY_COLOR: Record<Alert["severity"], string> = {
  info: "var(--muted)",
  notable: "var(--decision-escalate)",
  high: "var(--decision-block)",
};

export function AlertsPanel({ alerts }: { alerts: Alert[] }) {
  return (
    <Panel title="Alerts">
      {alerts.length === 0 && <EmptyState text="No alerts yet." />}
      <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
        {alerts.map((alert) => (
          <div key={alert.id} className="flex items-start gap-2 text-xs">
            <span
              className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: SEVERITY_COLOR[alert.severity] }}
            />
            <div>
              <p style={{ color: "var(--foreground)" }}>{alert.message}</p>
              <p style={{ color: "var(--muted)" }}>{relativeTime(alert.created_at)}</p>
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}
