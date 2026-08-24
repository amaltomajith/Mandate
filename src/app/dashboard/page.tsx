import { getDashboardData } from "@/lib/dashboardData";
import { RealtimeRefresher } from "@/components/dashboard/RealtimeRefresher";
import { EscalationsPanel } from "@/components/dashboard/EscalationsPanel";
import { AlertsPanel } from "@/components/dashboard/AlertsPanel";
import { PolicyRulesPanel } from "@/components/dashboard/PolicyRulesPanel";
import { HorizonPanel } from "@/components/dashboard/HorizonPanel";
import { SignOutButton } from "@/components/dashboard/SignOutButton";
import { GraphCanvas } from "@/components/graph/GraphCanvas";
import type { Trace } from "@/types/db";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const { agents, rules, traces, escalations, alerts } = await getDashboardData();
  const tracesById: Record<string, Trace> = Object.fromEntries(traces.map((t) => [t.id, t]));

  return (
    <div className="flex min-h-screen flex-col">
      <RealtimeRefresher />

      <header
        className="flex items-center justify-between border-b px-6 py-3"
        style={{ borderColor: "var(--panel-border)" }}
      >
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: "var(--entity-agent)" }} />
          <h1 className="text-sm font-semibold tracking-tight">Mandate</h1>
          <span className="ml-2 text-xs" style={{ color: "var(--muted)" }}>
            control plane
          </span>
        </div>
        <SignOutButton />
      </header>

      <div className="grid flex-1 grid-cols-1 gap-4 p-4 lg:grid-cols-[1fr_380px]">
        <div
          className="min-h-[520px] overflow-hidden rounded-xl border"
          style={{ borderColor: "var(--panel-border)", background: "var(--panel)" }}
        >
          <GraphCanvas agents={agents} rules={rules} traces={traces} />
        </div>

        <div className="space-y-4">
          <EscalationsPanel escalations={escalations} tracesById={tracesById} />
          <PolicyRulesPanel rules={rules} />
          <HorizonPanel />
          <AlertsPanel alerts={alerts} />
        </div>
      </div>
    </div>
  );
}
