"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "motion/react";
import { ChartLineUp, ClockCounterClockwise, Gauge, GearSix, Package, PlugsConnected, Shield, Storefront, UsersThree } from "@phosphor-icons/react";
import type { Agent, Alert, Customer, Escalation, PolicyRule, Trace } from "@/types/db";
import type { PolicyIssue } from "@/lib/policy/audit";
import type { CooData } from "@/lib/cooData";
import { MandateMark } from "@/components/brand/MandateMark";
import { TodayTab } from "./TodayTab";
import { InventoryTab } from "./InventoryTab";
import { SuppliersTab } from "./SuppliersTab";
import { SalesTab } from "./SalesTab";
import { GuardrailsTab } from "./GuardrailsTab";
import { ActivityTab } from "./ActivityTab";
import { TeamTab } from "./TeamTab";
import { ConnectionsTab } from "./ConnectionsTab";
import { ActiveTabContext } from "./tabContext";
import { spring, springSnappy } from "./motion";

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
  /** Right side of the top bar (alerts bell and the like), rendered by the page. */
  topRight?: ReactNode;
  /** Bottom of the left rail (sign out). */
  railFooter?: ReactNode;
}

/**
 * The dashboard shell, as the merchant thinks about the business: how it is
 * doing today, what is on the shelf, who supplies it, what came in and went out,
 * the limits on the team, what the team has done, and what it is plugged into.
 *
 * Layout: a glass rail on the left (icons only below xl, a tab bar on phones),
 * a slim top bar, and a content column capped at 1360px.
 */
export function DashboardTabs(props: Props) {
  const { coo, escalations, deterministicIssues } = props;
  const [tab, setTab] = useState<Tab>("today");
  const [highlightRuleId, setHighlightRuleId] = useState<string | null>(null);
  const reduce = useReducedMotion();

  const pending = escalations.filter((e) => e.status === "pending").length;
  const candidates = coo.vendors.filter((v) => v.status === "candidate").length;
  const waitingOrders = coo.purchaseOrders.filter((p) => p.status === "draft" && p.rationale?.includes("[needs_payee]")).length;

  const TABS: { key: Tab; label: string; title: string; blurb: string; Icon: typeof Gauge; badge?: number; tone?: string }[] = [
    { key: "today", label: "Today", title: "Today", blurb: "How the store is doing, and what needs you.", Icon: Gauge, badge: pending, tone: "var(--decision-escalate)" },
    { key: "inventory", label: "Inventory", title: "Inventory", blurb: "What is on the shelf, how fast it moves, and what it earns.", Icon: Package, badge: coo.kpis.runningLow, tone: "var(--decision-block)" },
    { key: "suppliers", label: "Suppliers", title: "Suppliers", blurb: "Who you buy from, what they quoted, and what is on order.", Icon: Storefront, badge: candidates + waitingOrders, tone: "var(--decision-escalate)" },
    { key: "sales", label: "Sales", title: "Sales and money", blurb: "What came in, what went out, and what is in the wallet.", Icon: ChartLineUp },
    { key: "guardrails", label: "Guardrails", title: "Guardrails", blurb: "The limits your team can never go past.", Icon: Shield, badge: deterministicIssues.length, tone: "var(--decision-block)" },
    { key: "activity", label: "Activity", title: "Activity", blurb: "Every decision and every message, and why.", Icon: ClockCounterClockwise },
    { key: "team", label: "Team", title: "Your team", blurb: "Your two agents: pause them, watch them, trust them.", Icon: UsersThree, badge: props.agents.filter((a) => a.status === "paused").length || (coo.settings.agents_enabled ? 0 : 1), tone: "var(--decision-block)" },
    { key: "connections", label: "Connections", title: "Connections", blurb: "Gmail, WhatsApp, Razorpay, and whether you are live.", Icon: PlugsConnected },
  ];
  const current = TABS.find((t) => t.key === tab)!;
  const live = coo.settings.channel_mode === "live";

  function jumpToRule(ruleId: string) {
    setTab("guardrails");
    setHighlightRuleId(ruleId);
    // Cleared after a few seconds so it reads as "look here now", not a permanent marker.
    setTimeout(() => setHighlightRuleId((cur) => (cur === ruleId ? null : cur)), 4000);
  }

  return (
    <ActiveTabContext.Provider value={tab}>
      <LayoutGroup id="rail">
        <aside className="glass fixed inset-y-0 left-0 z-30 hidden w-[76px] flex-col gap-1 rounded-none border-y-0 border-l-0 px-3 py-5 lg:flex xl:w-[248px] xl:px-4">
          <div className="mb-6 flex items-center gap-3 px-2.5">
            <MandateMark size={32} />
            <div className="hidden xl:block">
              <p className="text-[17px] font-semibold leading-5 tracking-[-0.01em]">Mandate</p>
              <p className="text-[12px] leading-4" style={{ color: "var(--muted)" }}>
                store manager
              </p>
            </div>
          </div>
          <nav className="flex flex-1 flex-col gap-1" aria-label="Sections">
            {TABS.map((t) => {
              const active = tab === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  aria-current={active ? "page" : undefined}
                  title={t.label}
                  className="focus-ring group relative flex min-h-[46px] items-center gap-3.5 rounded-[12px] px-3.5 text-[15px] font-medium transition-colors active:scale-[0.98]"
                  style={{ color: active ? "#fff" : "var(--muted)" }}
                >
                  {active && (
                    <motion.span
                      layoutId="rail-active"
                      className="absolute inset-0 rounded-[12px]"
                      style={{ background: "linear-gradient(135deg, rgba(124,92,255,0.34), rgba(82,39,255,0.16))", boxShadow: "inset 0 0 0 1px rgba(160,140,255,0.35)" }}
                      transition={springSnappy}
                    />
                  )}
                  {!active && <span className="absolute inset-0 rounded-[12px] opacity-0 transition-opacity group-hover:opacity-100" style={{ background: "rgba(255,255,255,0.05)" }} />}
                  <t.Icon size={22} weight={active ? "fill" : "regular"} className="relative z-10 shrink-0" />
                  <span className="relative z-10 hidden xl:inline">{t.label}</span>
                  {!!t.badge && t.badge > 0 && (
                    <span className="num relative z-10 ml-auto hidden min-w-[24px] rounded-full px-1.5 py-0.5 text-center text-[12px] font-semibold text-black xl:inline-block" style={{ background: t.tone ?? "var(--entity-agent)" }}>
                      {t.badge}
                    </span>
                  )}
                  {!!t.badge && t.badge > 0 && <span className="absolute right-2 top-2 z-10 h-2.5 w-2.5 rounded-full xl:hidden" style={{ background: t.tone ?? "var(--entity-agent)" }} />}
                </button>
              );
            })}
          </nav>
          <div className="flex flex-col gap-1 border-t pt-3" style={{ borderColor: "var(--hairline)" }}>
            <Link href="/dashboard/settings" title="Settings" className="focus-ring flex min-h-[46px] items-center gap-3.5 rounded-[12px] px-3.5 text-[15px] font-medium transition-colors hover:bg-white/5" style={{ color: "var(--muted)" }}>
              <GearSix size={22} className="shrink-0" />
              <span className="hidden xl:inline">Settings</span>
            </Link>
            <div className="hidden px-3.5 py-2 xl:block">{props.railFooter}</div>
          </div>
        </aside>

        <nav className="glass fixed inset-x-0 bottom-0 z-30 flex gap-1 overflow-x-auto rounded-none border-x-0 border-b-0 px-2 py-2 lg:hidden" aria-label="Sections">
          {TABS.map((t) => {
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                aria-current={active ? "page" : undefined}
                className="focus-ring relative flex min-w-[68px] shrink-0 flex-col items-center gap-1 rounded-[12px] px-2 py-2 text-[11px] font-medium"
                style={{ color: active ? "#fff" : "var(--muted)", background: active ? "rgba(124,92,255,0.22)" : "transparent" }}
              >
                <t.Icon size={22} weight={active ? "fill" : "regular"} />
                {t.label}
                {!!t.badge && t.badge > 0 && <span className="absolute right-3 top-1 h-2.5 w-2.5 rounded-full" style={{ background: t.tone ?? "var(--entity-agent)" }} />}
              </button>
            );
          })}
        </nav>
      </LayoutGroup>

      <div className="flex min-h-screen flex-1 flex-col pb-24 lg:pb-0 lg:pl-[76px] xl:pl-[248px]">
        <div className="glass sticky top-0 z-20 flex h-[64px] items-center justify-between gap-4 rounded-none border-x-0 border-t-0 px-5 sm:px-8">
          <div className="flex items-center gap-3 lg:hidden">
            <MandateMark size={28} />
            <span className="text-[17px] font-semibold tracking-[-0.01em]">Mandate</span>
          </div>
          <div className="hidden items-center gap-6 lg:flex">
            <TopStat label="need you" value={pending} tone={pending > 0 ? "var(--decision-escalate)" : undefined} />
            <TopStat label="running low" value={coo.kpis.runningLow} tone={coo.kpis.runningLow > 0 ? "var(--decision-block)" : undefined} />
          </div>
          <div className="flex items-center gap-4">
            <span
              className="rounded-full px-3 py-1 text-[12px] font-semibold"
              style={{
                background: live ? "color-mix(in srgb, var(--decision-escalate) 18%, transparent)" : "color-mix(in srgb, var(--entity-mandate) 18%, transparent)",
                color: live ? "var(--decision-escalate)" : "var(--entity-mandate)",
              }}
            >
              {live ? "Live" : "Sandbox"}
            </span>
            <span className="hidden items-center gap-2 text-[13px] sm:flex" style={{ color: "var(--muted)" }}>
              <span className="live-dot h-2 w-2 rounded-full" style={{ background: "var(--decision-allow)" }} />
              Updating live
            </span>
            {props.topRight}
          </div>
        </div>

        <main className="mx-auto w-full max-w-[1360px] flex-1 px-5 py-10 sm:px-8">
          <motion.header key={tab} className="mb-10" initial={reduce ? { opacity: 0 } : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={reduce ? { duration: 0.15 } : spring}>
            <h1 className="text-[40px] font-semibold leading-[44px] tracking-[-0.03em]">{current.title}</h1>
            <p className="mt-2 max-w-2xl text-[17px] leading-7" style={{ color: "var(--muted)" }}>
              {current.blurb}
            </p>
          </motion.header>

          {/* Kept mounted and hidden rather than removed: see tabContext.ts. */}
          <div hidden={tab !== "today"}>
            <TodayTab coo={coo} escalations={escalations} tracesById={props.tracesById} alerts={props.alerts} map={props.map} />
          </div>
          <AnimatePresence mode="wait" initial={false}>
            {tab !== "today" && (
              <motion.div
                key={tab}
                initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={reduce ? { duration: 0.12 } : { ...spring, duration: 0.35 }}
              >
                {tab === "inventory" && <InventoryTab insights={coo.insights} />}
                {tab === "suppliers" && <SuppliersTab coo={coo} />}
                {tab === "sales" && <SalesTab coo={coo} traces={props.traces} />}
                {tab === "guardrails" && <GuardrailsTab settings={coo.settings} rules={props.rules} deterministicIssues={deterministicIssues} highlightRuleId={highlightRuleId} />}
                {tab === "activity" && <ActivityTab coo={coo} traces={props.traces} agents={props.allAgents} customers={props.customers} rules={props.rules} onJumpToRule={jumpToRule} />}
                {tab === "team" && <TeamTab coo={coo} agents={props.allAgents} rules={props.rules} />}
                {tab === "connections" && (
                  <ConnectionsTab coo={coo} slug={props.slug} appUrl={props.appUrl} serverHasRazorpayKeys={props.serverHasRazorpayKeys} googleConfigured={props.googleConfigured} />
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </main>
      </div>
    </ActiveTabContext.Provider>
  );
}

function TopStat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="num text-[17px] font-semibold" style={{ color: tone ?? "var(--foreground)" }}>
        {value}
      </span>
      <span className="text-[13px]" style={{ color: "var(--muted)" }}>
        {label}
      </span>
    </div>
  );
}
