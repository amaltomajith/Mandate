"use client";

import { useMemo, useState } from "react";
import { MagnifyingGlass } from "@phosphor-icons/react";
import type { Agent, Decision, PolicyRule, Trace, Customer } from "@/types/db";
import { actionTypeLabel, formatMoney } from "@/lib/format";
import { decisionColor, EmptyState } from "./ui";
import { Pill, inputClass, inputStyle } from "./kit";
import { Drawer, Segmented } from "./motion";
import { TimeAgo } from "./TimeAgo";
import { StackedAreaChart, type StackedAreaSeries } from "./charts/StackedAreaChart";
import { computeDecisionVolumeTimeline, type DecisionVolumePoint } from "@/lib/decisionVolume";

/**
 * Makes a default-allow read as a decision rather than as nothing happening.
 *
 * "No policy rule matched, allowed by default" is accurate and sounds like an
 * absence. Every active rule WAS evaluated and none of them objected, which is
 * a different claim and the one this audit trail is meant to support.
 */
function explain(reasoning: string | null): string {
  if (!reasoning) return "No reasoning recorded.";
  return reasoning === "No policy rule matched — allowed by default." ? "Checked against every active rule. None applied, so it cleared." : reasoning;
}

/** The category drawn LAST traces the boundary the eye follows, so `allow`
 *  (typically 80%+ of traffic) sits on top where its stroke is the total. */
const VOLUME_SERIES: StackedAreaSeries[] = [
  { key: "protocol_reject", label: "Rejected (signature)", color: "var(--decision-reject)" },
  { key: "block", label: "Blocked", color: "var(--decision-block)" },
  { key: "escalate", label: "Escalated", color: "var(--decision-escalate)" },
  { key: "allow", label: "Allowed", color: "var(--decision-allow)" },
];

const DECISION_LABEL: Record<Decision, string> = {
  allow: "Allowed",
  block: "Blocked",
  escalate: "Escalated",
  protocol_reject: "Rejected (signature)",
};

type Filter = "all" | Decision;

/**
 * Every decision, not just what fits in the map or the approvals panel.
 * Client-side filter and search over the traces the server already fetched
 * (capped at 300, newest first). A row opens a side sheet with the reasoning
 * and the rule that fired; `onJumpToRule` switches to Guardrails and highlights it.
 */
export function TransactionsView({
  traces,
  agents,
  customers,
  rules,
  onJumpToRule,
}: {
  traces: Trace[];
  agents: Agent[];
  customers: Customer[];
  rules: PolicyRule[];
  onJumpToRule?: (ruleId: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const agentNameById = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents]);
  const customerNameById = useMemo(() => new Map(customers.map((c) => [c.id, c.name])), [customers]);
  const ruleById = useMemo(() => new Map(rules.map((r) => [r.id, r])), [rules]);

  const counts = useMemo(() => {
    const c = { all: traces.length, allow: 0, escalate: 0, block: 0, protocol_reject: 0 };
    traces.forEach((t) => (c[t.decision] += 1));
    return c;
  }, [traces]);

  const filtered = useMemo(
    () =>
      traces.filter((t) => {
        if (filter !== "all" && t.decision !== filter) return false;
        if (!search.trim()) return true;
        const haystack = `${t.action_type} ${t.reasoning ?? ""} ${agentNameById.get(t.agent_id ?? "") ?? ""}`.toLowerCase();
        return haystack.includes(search.trim().toLowerCase());
      }),
    [traces, filter, search, agentNameById]
  );

  // The volume chart is the shape of the whole audit trail, not of whatever the
  // current search happens to match.
  const volume = useMemo(() => computeDecisionVolumeTimeline(traces), [traces]);
  const open = openId ? traces.find((t) => t.id === openId) : undefined;
  const openParams = open ? (open.params as { amount?: number; currency?: string; customerId?: string | null; notes?: { item?: string } } | null) : null;
  const openRule = open?.rule_fired_id ? ruleById.get(open.rule_fired_id) : null;

  return (
    <div className="flex flex-col gap-6">
      {volume.length >= 2 && (
        <section className="surface p-7">
          <p className="text-[17px] font-semibold tracking-[-0.01em]">Decisions over time</p>
          <p className="mb-4 mt-0.5 text-[14px]" style={{ color: "var(--muted)" }}>
            The shape of everything the Payment Wall has judged.
          </p>
          <StackedAreaChart data={volume} indexKey="label" series={VOLUME_SERIES} valueFormatter={(n) => n.toLocaleString("en-IN")} height={200} renderTooltip={(point) => <VolumeTooltip point={point} />} />
        </section>
      )}

      <section className="surface p-7">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <Segmented
            label="Filter decisions"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All", count: counts.all },
              { value: "allow", label: "Allowed", count: counts.allow },
              { value: "escalate", label: "Escalated", count: counts.escalate },
              { value: "block", label: "Blocked", count: counts.block },
              { value: "protocol_reject", label: "Rejected", count: counts.protocol_reject },
            ]}
          />
          <div className="relative">
            <MagnifyingGlass size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2" style={{ color: "var(--muted-2)" }} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search action, agent, reason" aria-label="Search decisions" className={`${inputClass} !w-[280px] !pl-10`} style={inputStyle} />
          </div>
        </div>
        <p className="mb-2 mt-5 text-[13px]" style={{ color: "var(--muted)" }}>
          {filtered.length} of {traces.length} shown. Click one to see why it was decided that way.
        </p>

        {filtered.length === 0 ? (
          <EmptyState text={traces.length === 0 ? "No decisions yet." : "Nothing matches this filter."} hint={traces.length === 0 ? "They appear as soon as your team proposes something." : undefined} />
        ) : (
          <ul>
            {filtered.map((t) => {
              const p = t.params as { amount?: number; currency?: string; customerId?: string | null; notes?: { item?: string } } | null;
              const product = p?.notes?.item ?? null;
              const who = p?.customerId ? customerNameById.get(p.customerId) ?? null : null;
              const color = decisionColor(t.decision);
              return (
                <li key={t.id}>
                  <button type="button" onClick={() => setOpenId(t.id)} className="focus-ring grid w-full grid-cols-[auto_1fr_auto] items-center gap-4 rounded-[14px] px-4 py-4 text-left transition-colors hover:bg-white/[0.04] lg:grid-cols-[150px_1.4fr_1fr_100px_90px]">
                    <span>
                      <Pill color={color}>{DECISION_LABEL[t.decision]}</Pill>
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[15px] font-medium">{product ?? actionTypeLabel(t.action_type)}</span>
                      <span className="block truncate text-[13px]" style={{ color: "var(--muted-2)" }}>
                        {product ? actionTypeLabel(t.action_type) : t.agent_id ? agentNameById.get(t.agent_id) ?? "Unknown agent" : ""}
                        {who ? `, ${who}` : ""}
                      </span>
                    </span>
                    <span className="hidden truncate text-[14px] lg:block" style={{ color: "var(--muted)" }} title={t.reasoning ?? ""}>
                      {explain(t.reasoning)}
                    </span>
                    <span className="num text-right text-[15px] lg:text-left">{p?.amount && p?.currency ? formatMoney(p.amount, p.currency) : ""}</span>
                    <span className="hidden text-right text-[13px] lg:block" style={{ color: "var(--muted-2)" }}>
                      <TimeAgo iso={t.created_at} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <Drawer
        open={!!open}
        onClose={() => setOpenId(null)}
        title={open ? openParams?.notes?.item ?? actionTypeLabel(open.action_type) : "Decision"}
        description={open ? `${DECISION_LABEL[open.decision]}${open.agent_id ? ` for ${agentNameById.get(open.agent_id) ?? "an agent"}` : ""}` : undefined}
      >
        {open && (
          <div className="space-y-6 pb-6">
            {openParams?.amount && openParams?.currency && (
              <p className="num text-[40px] font-semibold leading-[44px]" style={{ color: decisionColor(open.decision) }}>
                {formatMoney(openParams.amount, openParams.currency)}
              </p>
            )}
            <div>
              <p className="mb-2 text-[13px] font-medium" style={{ color: "var(--muted)" }}>
                Why
              </p>
              <p className="rounded-[14px] bg-white/[0.04] px-5 py-4 text-[15px] leading-7">{explain(open.reasoning)}</p>
            </div>
            <div>
              <p className="mb-2 text-[13px] font-medium" style={{ color: "var(--muted)" }}>
                Rule that decided it
              </p>
              {openRule ? (
                <button
                  type="button"
                  onClick={() => {
                    setOpenId(null);
                    onJumpToRule?.(openRule.id);
                  }}
                  className="focus-ring inline-flex items-center gap-2 rounded-[12px] px-4 py-3 text-[15px] font-medium transition-colors hover:brightness-110"
                  style={{ background: "color-mix(in srgb, var(--entity-rule) 18%, transparent)", color: "var(--entity-rule)" }}
                >
                  {openRule.name}
                  {onJumpToRule && <span aria-hidden="true">, view in Guardrails</span>}
                </button>
              ) : (
                <p className="text-[15px] leading-6" style={{ color: "var(--muted)" }}>
                  No specific rule fired.{" "}
                  {open.decision === "allow" ? "It was allowed by default, nothing matched." : open.decision === "protocol_reject" ? "It was resolved at the protocol layer, before the policy engine." : "It was resolved by a status check, before the policy engine ran."}
                </p>
              )}
            </div>
            <p className="num text-[12px] leading-5" style={{ color: "var(--muted-2)" }}>
              trace {open.id}
              <br />
              mode: {open.mode}
            </p>
          </div>
        )}
      </Drawer>
    </div>
  );
}

function VolumeTooltip({ point }: { point: DecisionVolumePoint }) {
  const total = point.allow + point.escalate + point.block + point.protocol_reject;
  return (
    <div className="w-56 overflow-hidden rounded-[12px] border shadow-xl" style={{ borderColor: "var(--hairline-strong)" }}>
      <div className="px-3.5 py-2 text-[13px] font-semibold text-white" style={{ background: "var(--brand-violet)" }}>
        {point.label}
      </div>
      <div className="space-y-2 px-3.5 py-3" style={{ background: "var(--surface)" }}>
        {VOLUME_SERIES.map((s) => {
          const value = point[s.key as keyof DecisionVolumePoint] as number;
          const pct = total > 0 ? (value / total) * 100 : 0;
          return (
            <div key={s.key} className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: s.color }} />
              <div className="flex w-full items-baseline justify-between gap-2 text-[13px]">
                <span style={{ color: "var(--muted)" }}>{s.label}</span>
                <span className="num" style={{ color: "var(--foreground)" }}>
                  {value} <span style={{ color: "var(--muted-2)" }}>({pct.toFixed(0)}%)</span>
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
