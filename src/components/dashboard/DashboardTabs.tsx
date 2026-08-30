"use client";

import { useState } from "react";
import type { Agent, Customer, Escalation, Mandate, PolicyDomain, PolicyRule, Trace } from "@/types/db";
import type { PolicyIssue } from "@/lib/policy/audit";
import { EscalationsPanel } from "./EscalationsPanel";
import { AgentTrustPanel } from "./AgentTrustPanel";
import { PolicyRulesPanel } from "./PolicyRulesPanel";
import { PolicyHealthPanel } from "./PolicyHealthPanel";
import { PolicyDomainsCanvas } from "./PolicyDomainsCanvas";
import { HorizonPanel } from "./HorizonPanel";
import { DemoRunner } from "./DemoRunner";
import { BackgroundTrafficButton } from "./BackgroundTrafficButton";
import { TransactionsView } from "./TransactionsView";
import { MandatesPanel } from "./MandatesPanel";
import { GraphCanvas } from "@/components/graph/GraphCanvas";
import { GraphLegend } from "@/components/graph/GraphLegend";

type Tab = "overview" | "transactions" | "policies" | "domains" | "mandates";

const TABS: { key: Tab; label: string; badge?: (props: Props) => number }[] = [
  { key: "overview", label: "Overview" },
  { key: "transactions", label: "Transactions", badge: (p) => p.traces.length },
  { key: "policies", label: "Policies", badge: (p) => p.pendingCount + p.deterministicIssues.length },
  { key: "domains", label: "Domains", badge: (p) => p.domains.length },
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
  domains: PolicyDomain[];
}

/**
 * A single dashboard was starting to bury the things that most need
 * attention (a growing transactions table, a growing policy set) under a
 * graph that dominates the page — this splits them into real sections
 * instead of stacking everything into one increasingly long scroll.
 */
export function DashboardTabs(props: Props) {
  const { agents, rules, traces, escalations, tracesById, deterministicIssues, mandates, customers, domains } = props;
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
          {/* Graph+sidebar first, fixed here regardless of anything below —
              DemoRunner's step list used to sit above this and could grow
              tall enough (11 steps, with the mandate lifecycle beats) to
              push the graph below the fold. Its own scroll cap (see
              DemoRunner.tsx) helps, but putting it below the graph entirely
              means the graph's position never depends on demo state at all. */}
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
              <GraphCanvas agents={agents} rules={rules} traces={traces} mandates={mandates} customers={customers} domains={domains} />
              <GraphLegend />
            </div>

            <div className="flex flex-col gap-5">
              <EscalationsPanel escalations={escalations} tracesById={tracesById} />
              <div className="flex-1">
                <AgentTrustPanel agents={agents} />
              </div>
            </div>
          </div>

          <DemoRunner />
          <BackgroundTrafficButton />
        </div>
      )}

      {tab === "transactions" && <TransactionsView traces={traces} agents={agents} rules={rules} domains={domains} onJumpToRule={jumpToRule} />}

      {tab === "policies" && (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <PolicyRulesPanel rules={rules} domains={domains} highlightRuleId={highlightRuleId} />
          <div className="space-y-5">
            <PolicyHealthPanel deterministicIssues={deterministicIssues} />
            <HorizonPanel />
          </div>
        </div>
      )}

      {tab === "domains" && (
        <PolicyDomainsCanvas domains={domains} rules={rules} escalations={escalations} agents={agents} traces={traces} />
      )}

      {tab === "mandates" && <MandatesPanel mandates={mandates} agents={agents} customers={customers} />}
    </div>
  );
}
