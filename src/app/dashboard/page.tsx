import { getDashboardData } from "@/lib/dashboardData";
import { LiveRefresher } from "@/components/dashboard/LiveRefresher";
import { EscalationsPanel } from "@/components/dashboard/EscalationsPanel";
import { AlertsPanel } from "@/components/dashboard/AlertsPanel";
import { AlertToasts } from "@/components/dashboard/AlertToasts";
import { PolicyRulesPanel } from "@/components/dashboard/PolicyRulesPanel";
import { HorizonPanel } from "@/components/dashboard/HorizonPanel";
import { SignOutButton } from "@/components/dashboard/SignOutButton";
import { GettingStartedBanner } from "@/components/dashboard/GettingStartedBanner";
import { GraphCanvas } from "@/components/graph/GraphCanvas";
import { GraphLegend } from "@/components/graph/GraphLegend";
import { MandateMark } from "@/components/brand/MandateMark";
import type { Trace } from "@/types/db";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const { agents, rules, traces, escalations, alerts } = await getDashboardData();
  const tracesById: Record<string, Trace> = Object.fromEntries(traces.map((t) => [t.id, t]));

  const pendingEscalations = escalations.filter((e) => e.status === "pending").length;
  const activeAgents = agents.length;
  const activeRules = rules.filter((r) => r.status === "active").length;

  return (
    <div className="relative flex min-h-screen flex-col bg-[var(--background-2)]">
      <LiveRefresher />
      <AlertToasts alerts={alerts} />

      <header className="panel-glass sticky top-0 z-20 flex items-center justify-between px-6 py-3.5" style={{ borderTop: "none", borderLeft: "none", borderRight: "none" }}>
        <div className="flex items-center gap-3">
          <MandateMark size={28} />
          <div>
            <h1 className="text-[15px] font-semibold tracking-tight">Mandate</h1>
            <p className="text-[11px] leading-none" style={{ color: "var(--muted-2)" }}>
              control plane
            </p>
          </div>

          <div className="ml-6 hidden items-center gap-4 border-l pl-6 sm:flex" style={{ borderColor: "var(--panel-border)" }}>
            <StatChip label="agents" value={activeAgents} />
            <StatChip label="active rules" value={activeRules} />
            <StatChip
              label="pending"
              value={pendingEscalations}
              tone={pendingEscalations > 0 ? "var(--decision-escalate)" : undefined}
            />
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--muted)" }}>
            <span className="live-dot h-1.5 w-1.5 rounded-full" style={{ background: "var(--decision-allow)" }} />
            live
          </div>
          <SignOutButton />
        </div>
      </header>

      <div className="relative z-10 flex flex-1 flex-col gap-5 p-5">
        <GettingStartedBanner hasAgents={activeAgents > 0} hasRules={activeRules > 0} hasTraces={traces.length > 0} />

        <div className="grid flex-1 grid-cols-1 gap-5 lg:grid-cols-[1fr_390px]">
          <div className="relative min-h-[560px] overflow-hidden rounded-2xl panel-card-lg">
            <div
              className="pointer-events-none absolute inset-x-0 top-0 z-10 h-24"
              style={{ background: "linear-gradient(to bottom, rgba(5,6,10,0.6), transparent)" }}
            />
            <div className="pointer-events-none absolute left-5 top-4 z-10">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-white/70">Entity graph</p>
              <p className="mt-0.5 text-xs text-white/50">a live map of every agent, rule, and action</p>
            </div>
            <GraphCanvas agents={agents} rules={rules} traces={traces} />
            <GraphLegend />
          </div>

          <div className="space-y-5">
            <EscalationsPanel escalations={escalations} tracesById={tracesById} />
            <PolicyRulesPanel rules={rules} />
            <HorizonPanel />
            <AlertsPanel alerts={alerts} />
          </div>
        </div>
      </div>
    </div>
  );
}

function StatChip({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-sm font-semibold tabular-nums" style={{ color: tone ?? "var(--foreground)" }}>
        {value}
      </span>
      <span className="text-[11px]" style={{ color: "var(--muted-2)" }}>
        {label}
      </span>
    </div>
  );
}
