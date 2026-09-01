"use client";

import { useState } from "react";
import type { Agent, Customer, Escalation, Mandate, PolicyRule, Trace } from "@/types/db";
import type { PolicyIssue } from "@/lib/policy/audit";
import { EscalationsPanel } from "./EscalationsPanel";
import { AgentTrustPanel } from "./AgentTrustPanel";
import { PolicyRulesPanel } from "./PolicyRulesPanel";
import { PolicyHealthPanel } from "./PolicyHealthPanel";
import { HorizonPanel } from "./HorizonPanel";
import { ThresholdTuner } from "./ThresholdTuner";
import { SimulationPanel } from "./SimulationPanel";
import { RevenueImpactPanel } from "./RevenueImpactPanel";
import { TransactionsView } from "./TransactionsView";
import { MandatesPanel } from "./MandatesPanel";
import { GraphCanvas } from "@/components/graph/GraphCanvas";
import { GraphLegend } from "@/components/graph/GraphLegend";

type Tab = "overview" | "transactions" | "policies" | "mandates";

const TABS: { key: Tab; label: string; badge?: (props: Props) => number }[] = [
  { key: "overview", label: "Overview" },
  { key: "transactions", label: "Transactions", badge: (p) => p.traces.length },
  { key: "policies", label: "Policies", badge: (p) => p.pendingCount + p.deterministicIssues.length },
  { key: "mandates", label: "Mandates", badge: (p) => p.mandates.filter((m) => m.status === "paused").length },
];

interface Props {
  agents: Agent[];
  rules: PolicyRule[];
  traces: Trace[];
  escalations: Escalation[];
  tracesById: Record<string, Trace>;
  deterministicIssues: PolicyIssue[];
  pendingCount: number;
  mandates: Mandate[];
  customers: Customer[];
}

/**
 * A single dashboard was starting to bury the things that most need
 * attention (a growing transactions table, a growing policy set) under a
 * graph that dominates the page — this splits them into real sections
 * instead of stacking everything into one increasingly long scroll.
 */
export function DashboardTabs(props: Props) {
  const { agents, rules, traces, escalations, tracesById, deterministicIssues, mandates, customers } = props;
  const [tab, setTab] = useState<Tab>("overview");
  const [highlightRuleId, setHighlightRuleId] = useState<string | null>(null);

  function jumpToRule(ruleId: string) {
    setTab("policies");
    setHighlightRuleId(ruleId);
    // Clear the highlight after a few seconds so it reads as "look here now,"
    // not a permanent marker.
    setTimeout(() => setHighlightRuleId((current) => (current === ruleId ? null : current)), 4000);
  }

  return (
    <div className="flex flex-1 flex-col gap-5">
      <nav className="flex gap-1 rounded-xl p-1" style={{ background: "var(--panel-2)", width: "fit-content" }}>
        {TABS.map((t) => {
          const count = t.badge?.(props) ?? 0;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-[13px] font-medium transition-colors"
              style={{
                background: tab === t.key ? "var(--panel)" : "transparent",
                color: tab === t.key ? "var(--foreground)" : "var(--muted)",
                boxShadow: tab === t.key ? "var(--shadow-card)" : "none",
              }}
            >
              {t.label}
              {count > 0 && (
                <span
                  className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                  style={{
                    background: tab === t.key ? "var(--entity-agent)" : "var(--panel-border-strong)",
                    color: tab === t.key ? "white" : "var(--muted)",
                  }}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {tab === "overview" && (
        <div className="flex flex-1 flex-col gap-5">
          {/* The scoreboard leads: what the control plane did to revenue is the
              headline, and the graph explains how. Fixed height, so it can't
              push the graph down as figures grow. */}
          <RevenueImpactPanel traces={traces} escalations={escalations} />

          {/* Height is pinned rather than content-driven. Previously the row
              grew with the sidebar, so every new escalation made the graph
              taller and pushed the page down — the graph became unusable to
              orbit precisely because the system was busy. Now the column
              scrolls internally and the graph keeps a stable viewport. */}
          <div className="grid grid-cols-1 gap-5 lg:h-[calc(100vh-13rem)] lg:min-h-[600px] lg:grid-cols-[1fr_400px]">
            <div className="relative min-h-[560px] overflow-hidden rounded-2xl panel-card-lg lg:min-h-0">
              <div
                className="pointer-events-none absolute inset-x-0 top-0 z-10 h-24"
                style={{ background: "linear-gradient(to bottom, rgba(5,6,10,0.6), transparent)" }}
              />
              <div className="pointer-events-none absolute left-5 top-4 z-10">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-white/70">Entity graph</p>
                <p className="mt-0.5 text-xs text-white/50">a live map of every agent, rule, and action</p>
              </div>
              <GraphCanvas agents={agents} rules={rules} traces={traces} mandates={mandates} customers={customers} escalations={escalations} />
              <GraphLegend />
            </div>

            <div className="flex min-h-0 flex-col gap-5">
              <EscalationsPanel escalations={escalations} tracesById={tracesById} />
              <AgentTrustPanel agents={agents} rules={rules} />
            </div>
          </div>

          <SimulationPanel />
        </div>
      )}

      {tab === "transactions" && <TransactionsView traces={traces} agents={agents} rules={rules} onJumpToRule={jumpToRule} />}

      {tab === "policies" && (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <PolicyRulesPanel rules={rules} highlightRuleId={highlightRuleId} />
          <div className="space-y-5">
            <ThresholdTuner />
            <PolicyHealthPanel deterministicIssues={deterministicIssues} />
            <HorizonPanel />
          </div>
        </div>
      )}

      {tab === "mandates" && <MandatesPanel mandates={mandates} agents={agents} customers={customers} />}
    </div>
  );
}
