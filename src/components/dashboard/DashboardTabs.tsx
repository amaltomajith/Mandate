"use client";

import Link from "next/link";
import { useState } from "react";
import type { Agent, Customer, Escalation, Mandate, Merchant, PolicyRule, Product, Trace } from "@/types/db";
import type { PolicyIssue } from "@/lib/policy/audit";
import { EscalationsPanel } from "./EscalationsPanel";
import { AgentTrustPanel } from "./AgentTrustPanel";
import { PolicyRulesPanel } from "./PolicyRulesPanel";
import { PolicyHealthPanel } from "./PolicyHealthPanel";
import { ThresholdTuner } from "./ThresholdTuner";
import { CatalogPanel } from "./CatalogPanel";
import { AgentsPanel } from "./AgentsPanel";
import { RevenueImpactPanel } from "./RevenueImpactPanel";
import { TransactionsView } from "./TransactionsView";
import { MandatesPanel } from "./MandatesPanel";

type Tab = "overview" | "catalog" | "agents" | "transactions" | "policies" | "mandates";

const TABS: { key: Tab; label: string; badge?: (props: Props) => number }[] = [
  { key: "overview", label: "Overview" },
  { key: "catalog", label: "Catalog" },
  { key: "agents", label: "Agents", badge: (p) => p.agents.filter((a) => a.status === "paused").length },
  { key: "transactions", label: "Transactions", badge: (p) => p.traces.length },
  { key: "policies", label: "Policies", badge: (p) => p.pendingCount + p.deterministicIssues.length },
  { key: "mandates", label: "Mandates", badge: (p) => p.mandates.filter((m) => m.status === "paused").length },
];

interface Props {
  /** LIVE agents. Everything that lists things which CAN ACT uses this: the
   *  roster, the entity graph, the trust panel, the header count. */
  agents: Agent[];
  /** Every agent including retired ones. Two callers, both reading history
   *  rather than listing actors -- Transactions resolves trace names from it,
   *  Mandates resolves the agent behind an old authorization. */
  allAgents: Agent[];
  rules: PolicyRule[];
  traces: Trace[];
  escalations: Escalation[];
  tracesById: Record<string, Trace>;
  deterministicIssues: PolicyIssue[];
  pendingCount: number;
  mandates: Mandate[];
  customers: Customer[];
  products: Product[];
  merchant: Merchant;
}

/**
 * A single dashboard was starting to bury the things that most need
 * attention (a growing transactions table, a growing policy set) under a
 * graph that dominates the page — this splits them into real sections
 * instead of stacking everything into one increasingly long scroll.
 */
export function DashboardTabs(props: Props) {
  const { agents, allAgents, rules, traces, escalations, tracesById, deterministicIssues, mandates, customers } = props;
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

        {/* Settings is a real route, not a tab, so it is a Link rather than a
            state toggle — see src/app/dashboard/settings/page.tsx for why it
            has its own URL. Styled to sit with the tabs because to a merchant
            it is simply the next item in the nav, but separated by a rule
            because leaving this page is a navigation, not a tab switch. */}
        <span className="mx-1 my-1.5 w-px shrink-0" style={{ background: "var(--panel-border-strong)" }} />
        <Link
          href="/dashboard/settings"
          className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-[13px] font-medium transition-colors hover:bg-[var(--panel)]"
          style={{ color: "var(--muted)" }}
        >
          Settings
        </Link>
      </nav>

      {tab === "overview" && (
        <div className="flex flex-1 flex-col gap-5">
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <EscalationsPanel escalations={escalations} tracesById={tracesById} />
            <AgentTrustPanel agents={agents} rules={rules} />
          </div>

          {/* Revenue impact closes the tab: the payoff, read after watching
              the graph and the queue move rather than before either has. */}
          <RevenueImpactPanel traces={traces} escalations={escalations} />
        </div>
      )}

      {tab === "catalog" && <CatalogPanel />}

      {tab === "agents" && <AgentsPanel agents={allAgents} rules={rules} mandates={mandates} />}

      {tab === "transactions" && <TransactionsView traces={traces} agents={allAgents} customers={customers} rules={rules} onJumpToRule={jumpToRule} />}

      {tab === "policies" && (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <PolicyRulesPanel rules={rules} highlightRuleId={highlightRuleId} />
          <div className="space-y-5">
            <ThresholdTuner />
            <PolicyHealthPanel deterministicIssues={deterministicIssues} />
          </div>
        </div>
      )}

      {tab === "mandates" && <MandatesPanel mandates={mandates} agents={allAgents} customers={customers} />}
    </div>
  );
}
