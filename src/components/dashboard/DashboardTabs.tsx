"use client";

import { useState } from "react";
import type { Agent, Escalation, PolicyRule, Trace } from "@/types/db";
import type { PolicyIssue } from "@/lib/policy/audit";
import { EscalationsPanel } from "./EscalationsPanel";
import { PolicyRulesPanel } from "./PolicyRulesPanel";
import { PolicyHealthPanel } from "./PolicyHealthPanel";
import { HorizonPanel } from "./HorizonPanel";
import { DemoRunner } from "./DemoRunner";
import { TransactionsView } from "./TransactionsView";
import { RiskPanel } from "./RiskPanel";
import { GraphCanvas } from "@/components/graph/GraphCanvas";
import { GraphLegend } from "@/components/graph/GraphLegend";
import type { RiskReport } from "@/lib/risk/loadReport";

type Tab = "overview" | "transactions" | "policies" | "risk";

const TABS: { key: Tab; label: string; badge?: (props: Props) => number }[] = [
  { key: "overview", label: "Overview" },
  { key: "transactions", label: "Transactions", badge: (p) => p.traces.length },
  { key: "policies", label: "Policies", badge: (p) => p.pendingCount + p.deterministicIssues.length },
  { key: "risk", label: "Risk" },
];

interface Props {
  agents: Agent[];
  rules: PolicyRule[];
  traces: Trace[];
  escalations: Escalation[];
  tracesById: Record<string, Trace>;
  deterministicIssues: PolicyIssue[];
  pendingCount: number;
  riskReport: RiskReport | null;
}

/**
 * A single dashboard was starting to bury the things that most need
 * attention (a growing transactions table, a growing policy set) under a
 * graph that dominates the page — this splits them into real sections
 * instead of stacking everything into one increasingly long scroll.
 */
export function DashboardTabs(props: Props) {
  const { agents, rules, traces, escalations, tracesById, deterministicIssues, riskReport } = props;
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
          <DemoRunner />
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
            </div>
          </div>
        </div>
      )}

      {tab === "transactions" && <TransactionsView traces={traces} agents={agents} rules={rules} onJumpToRule={jumpToRule} />}

      {tab === "policies" && (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <PolicyRulesPanel rules={rules} highlightRuleId={highlightRuleId} />
          <div className="space-y-5">
            <PolicyHealthPanel deterministicIssues={deterministicIssues} />
            <HorizonPanel />
          </div>
        </div>
      )}

      {tab === "risk" && <RiskPanel report={riskReport} />}
    </div>
  );
}
