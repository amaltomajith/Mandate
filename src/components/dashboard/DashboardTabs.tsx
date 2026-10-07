"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import type { Agent, Alert, Customer, Escalation, PolicyRule, Trace } from "@/types/db";
import type { PolicyIssue } from "@/lib/policy/audit";
import type { CooData } from "@/lib/cooData";
import { TodayTab } from "./TodayTab";
import { InventoryTab } from "./InventoryTab";
import { SuppliersTab } from "./SuppliersTab";
import { SalesTab } from "./SalesTab";
import { GuardrailsTab } from "./GuardrailsTab";
import { ActivityTab } from "./ActivityTab";
import { TeamTab } from "./TeamTab";
import { ConnectionsTab } from "./ConnectionsTab";

type Tab = "today" | "inventory" | "suppliers" | "sales" | "guardrails" | "activity" | "team" | "connections";

interface Props {
  /** LIVE agents. Anything that lists things which CAN ACT uses this. */
  agents: Agent[];
  /** Every agent including retired ones, for resolving names in history. */
  allAgents: Agent[];
  rules: PolicyRule[];
  traces: Trace[];
  escalations: Escalation[];
  tracesById: Record<string, Trace>;
  alerts: Alert[];
  deterministicIssues: PolicyIssue[];
  customers: Customer[];
  coo: CooData;
  slug: string;
  appUrl: string;
  serverHasRazorpayKeys: boolean;
  googleConfigured: boolean;
  /** The 3D operations map, rendered by the page so it can be code-split. */
  map: ReactNode;
}

/**
 * The dashboard, as the merchant thinks about the business: how it is doing
 * today, what is on the shelf, who supplies it, what came in and went out, the
 * limits on the team, what the team has done, and what it is plugged into.
 */
export function DashboardTabs(props: Props) {
  const { coo, escalations, deterministicIssues } = props;
  const [tab, setTab] = useState<Tab>("today");
  const [highlightRuleId, setHighlightRuleId] = useState<string | null>(null);

  const pending = escalations.filter((e) => e.status === "pending").length;
  const candidates = coo.vendors.filter((v) => v.status === "candidate").length;
  const waitingOrders = coo.purchaseOrders.filter((p) => p.status === "draft" && p.rationale?.includes("[needs_payee]")).length;

  const TABS: { key: Tab; label: string; badge?: number; tone?: string }[] = [
    { key: "today", label: "Today", badge: pending, tone: "var(--decision-escalate)" },
    { key: "inventory", label: "Inventory", badge: coo.kpis.runningLow, tone: "var(--decision-block)" },
    { key: "suppliers", label: "Suppliers", badge: candidates + waitingOrders, tone: "var(--decision-escalate)" },
    { key: "sales", label: "Sales" },
    { key: "guardrails", label: "Guardrails", badge: deterministicIssues.length, tone: "var(--decision-block)" },
    { key: "activity", label: "Activity" },
    { key: "team", label: "Team", badge: props.agents.filter((a) => a.status === "paused").length || (coo.settings.agents_enabled ? 0 : 1), tone: "var(--decision-block)" },
    { key: "connections", label: "Connections" },
  ];

  function jumpToRule(ruleId: string) {
    setTab("guardrails");
    setHighlightRuleId(ruleId);
    // Cleared after a few seconds so it reads as "look here now", not a permanent marker.
    setTimeout(() => setHighlightRuleId((cur) => (cur === ruleId ? null : cur)), 4000);
  }

  return (
    <div className="flex flex-1 flex-col gap-5">
      <nav className="flex max-w-full gap-1 overflow-x-auto rounded-xl p-1" style={{ background: "var(--panel-2)", width: "fit-content" }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className="flex shrink-0 items-center gap-1.5 rounded-lg px-4 py-2 text-[13px] font-medium transition-colors"
            style={{
              background: tab === t.key ? "var(--panel)" : "transparent",
              color: tab === t.key ? "var(--foreground)" : "var(--muted)",
              boxShadow: tab === t.key ? "var(--shadow-card)" : "none",
            }}
          >
            {t.label}
            {!!t.badge && t.badge > 0 && (
              <span className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold text-white" style={{ background: t.tone ?? "var(--entity-agent)" }}>
                {t.badge}
              </span>
            )}
          </button>
        ))}
        <span className="mx-1 my-1.5 w-px shrink-0" style={{ background: "var(--panel-border-strong)" }} />
        <Link href="/dashboard/settings" className="flex shrink-0 items-center rounded-lg px-4 py-2 text-[13px] font-medium transition-colors hover:bg-[var(--panel)]" style={{ color: "var(--muted)" }}>
          Settings
        </Link>
      </nav>

      {tab === "today" && <TodayTab coo={coo} escalations={escalations} tracesById={props.tracesById} alerts={props.alerts} map={props.map} />}
      {tab === "inventory" && <InventoryTab insights={coo.insights} />}
      {tab === "suppliers" && <SuppliersTab coo={coo} />}
      {tab === "sales" && <SalesTab coo={coo} traces={props.traces} />}
      {tab === "guardrails" && <GuardrailsTab settings={coo.settings} rules={props.rules} deterministicIssues={deterministicIssues} highlightRuleId={highlightRuleId} />}
      {tab === "activity" && <ActivityTab coo={coo} traces={props.traces} agents={props.allAgents} customers={props.customers} rules={props.rules} onJumpToRule={jumpToRule} />}
      {tab === "team" && <TeamTab coo={coo} agents={props.allAgents} rules={props.rules} />}
      {tab === "connections" && (
        <ConnectionsTab coo={coo} slug={props.slug} appUrl={props.appUrl} serverHasRazorpayKeys={props.serverHasRazorpayKeys} googleConfigured={props.googleConfigured} />
      )}
    </div>
  );
}
