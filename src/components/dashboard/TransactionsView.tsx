"use client";

import { Fragment, useMemo, useState } from "react";
import type { Agent, Decision, PolicyRule, Trace , Customer } from "@/types/db";
import { actionTypeLabel, formatMoney } from "@/lib/format";

/**
 * Makes a default-allow read as a decision rather than as nothing happening.
 *
 * "No policy rule matched — allowed by default" is accurate and sounds like an
 * absence. Every active rule WAS evaluated and none of them objected, which is
 * a different claim and the one this audit trail is meant to support.
 */
function explain(reasoning: string | null): string {
  if (!reasoning) return "—";
  return reasoning === "No policy rule matched — allowed by default."
    ? "Checked against every active rule — none applied, so it cleared."
    : reasoning;
}
import { decisionColor } from "./ui";
import { TimeAgo } from "./TimeAgo";
import { StackedAreaChart, type StackedAreaSeries } from "./charts/StackedAreaChart";
import { computeDecisionVolumeTimeline, type DecisionVolumePoint } from "@/lib/decisionVolume";

/** Same lesson the revenue chart's stacking-order bug taught: the category
 *  drawn LAST traces the boundary every viewer's eye follows, so it has to be
 *  the one where "this is the total" is the correct reading. `allow` is by far
 *  the largest slice here (typically 80%+ of traffic), so it sits on top,
 *  where its own stroke doubles as the grand-total line. The three refusal
 *  types sit below it in ascending severity, each with its own true height
 *  directly readable off the bucket below it rather than inherited from
 *  whatever is stacked on top. */
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

const FILTERS: { key: "all" | Decision; label: string }[] = [
  { key: "all", label: "All" },
  { key: "allow", label: "Allowed" },
  { key: "escalate", label: "Escalated" },
  { key: "block", label: "Blocked" },
  { key: "protocol_reject", label: "Rejected" },
];

/**
 * Every transaction, not just what fits in the graph or the escalations
 * panel — "I don't have any idea about all the transactions" was the exact
 * gap this closes. Client-side filter/search over the traces the server
 * already fetched (dashboardData.ts caps at 300, recent-first) rather than a
 * second query — plenty for what this needs to show.
 *
 * A row for a blocked/escalated transaction expands to show which policy
 * rule actually fired — the same thing the 3D graph shows via a trace→rule
 * edge, surfaced here too since not everyone wants to go find it in the
 * graph. `onJumpToRule` switches to the Policies tab and highlights it.
 *
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
  const [filter, setFilter] = useState<"all" | Decision>("all");
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const agentNameById = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents]);
  const customerNameById = useMemo(() => new Map(customers.map((c) => [c.id, c.name])), [customers]);
  const ruleById = useMemo(() => new Map(rules.map((r) => [r.id, r])), [rules]);

  const filtered = useMemo(() => {
    return traces.filter((t) => {
      if (filter !== "all" && t.decision !== filter) return false;
      if (!search.trim()) return true;
      const haystack = `${t.action_type} ${t.reasoning ?? ""} ${agentNameById.get(t.agent_id ?? "") ?? ""}`.toLowerCase();
      return haystack.includes(search.trim().toLowerCase());
    });
  }, [traces, filter, search, agentNameById]);

  // Every trace in `traces` (not `filtered`) — the volume chart is the shape
  // of the whole audit trail this grid is drawn from, not of whatever the
  // current search happens to match. Same reason a revenue timeline reads the
  // full trace set rather than a filtered view of it.
  const volume = useMemo(() => computeDecisionVolumeTimeline(traces), [traces]);

  return (
    <div className="panel-card rounded-2xl p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">Transactions</p>
          <p className="mt-0.5 text-xs" style={{ color: "var(--muted)" }}>
            {filtered.length} of {traces.length} shown — click a row for the policy that decided it
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search action, agent, reason…"
            className="rounded-lg border px-3 py-1.5 text-xs outline-none focus:border-[var(--entity-agent)]"
            style={{ borderColor: "var(--panel-border)", background: "var(--panel-2)", minWidth: 200 }}
          />
          <div className="flex gap-1 rounded-lg p-1" style={{ background: "var(--panel-2)" }}>
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className="rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors"
                style={{
                  background: filter === f.key ? "var(--panel-border-strong)" : "transparent",
                  color: filter === f.key ? "var(--foreground)" : "var(--muted)",
                }}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {volume.length >= 2 && (
        <div className="mb-4 rounded-xl border p-4" style={{ borderColor: "var(--panel-border)", background: "var(--panel-2)" }}>
          <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider" style={{ color: "var(--muted-2)" }}>
            Decision volume, over time
          </p>
          <StackedAreaChart
            data={volume}
            indexKey="label"
            series={VOLUME_SERIES}
            valueFormatter={(n) => n.toLocaleString("en-IN")}
            height={160}
            renderTooltip={(point) => <VolumeTooltip point={point} />}
          />
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-10 text-center" style={{ borderColor: "var(--panel-border-strong)" }}>
          <p className="text-xs" style={{ color: "var(--muted)" }}>
            {traces.length === 0 ? "No transactions yet — start the simulated agent to generate some." : "Nothing matches this filter."}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr style={{ color: "var(--muted-2)" }}>
                <th className="pb-2 pr-3 font-medium">Decision</th>
                <th className="pb-2 pr-3 font-medium">Action</th>
                <th className="pb-2 pr-3 font-medium">Amount</th>
                <th className="pb-2 pr-3 font-medium">Agent</th>
                <th className="pb-2 pr-3 font-medium">Reasoning</th>
                <th className="pb-2 font-medium">When</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((t) => {
                const p = t.params as {
                  amount?: number;
                  currency?: string;
                  customerId?: string | null;
                  notes?: { item?: string; sku?: string };
                } | null;
                // The product and the customer are already on the trace. The
                // audit trail is the artifact backing "every money action
                // explainable", and a column of identical "New purchase order"
                // rows explains nothing that the amount did not already say.
                const product = p?.notes?.item ?? null;
                const who = p?.customerId ? customerNameById.get(p.customerId) ?? null : null;
                const color = decisionColor(t.decision);
                const expanded = expandedId === t.id;
                const rule = t.rule_fired_id ? ruleById.get(t.rule_fired_id) : null;

                return (
                  <Fragment key={t.id}>
                    <tr
                      className="cursor-pointer border-t hover:bg-[var(--panel-2)]"
                      style={{ borderColor: "var(--panel-border)" }}
                      onClick={() => setExpandedId(expanded ? null : t.id)}
                    >
                      <td className="py-2 pr-3">
                        <span
                          className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[10px] font-semibold"
                          style={{ background: `${color}26`, color }}
                        >
                          <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
                          {DECISION_LABEL[t.decision]}
                        </span>
                      </td>
                      <td className="py-2 pr-3">
                        <span className="block truncate">{product ?? actionTypeLabel(t.action_type)}</span>
                        <span className="block truncate text-[10px]" style={{ color: "var(--muted-2)" }}>
                          {product ? actionTypeLabel(t.action_type) : "—"}
                          {who ? ` · ${who}` : ""}
                        </span>
                      </td>
                      <td className="py-2 pr-3 tabular-nums">{p?.amount && p?.currency ? formatMoney(p.amount, p.currency) : "—"}</td>
                      <td className="py-2 pr-3" style={{ color: "var(--muted)" }}>
                        {t.agent_id ? agentNameById.get(t.agent_id) ?? "Unknown agent" : "—"}
                      </td>
                      <td className="max-w-xs truncate py-2 pr-3" style={{ color: "var(--muted)" }} title={t.reasoning ?? ""}>
                        {explain(t.reasoning)}
                      </td>
                      <td className="py-2 whitespace-nowrap" style={{ color: "var(--muted-2)" }}>
                        <TimeAgo iso={t.created_at} />
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="border-t" style={{ borderColor: "var(--panel-border)", background: "var(--panel-2)" }}>
                        <td colSpan={6} className="px-3 py-3">
                          <p className="text-[12px] leading-relaxed" style={{ color: "var(--foreground)" }}>
                            {explain(t.reasoning) ?? "No reasoning recorded for this trace."}
                          </p>
                          {rule ? (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                onJumpToRule?.(rule.id);
                              }}
                              className="mt-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-colors hover:brightness-110"
                              style={{ background: "color-mix(in srgb, var(--entity-rule) 18%, transparent)", color: "var(--entity-rule)" }}
                            >
                              Fired: &quot;{rule.name}&quot; {onJumpToRule && "→ view in Policies"}
                            </button>
                          ) : (
                            <p className="mt-2 text-[11px]" style={{ color: "var(--muted-2)" }}>
                              No specific rule fired —{" "}
                              {t.decision === "allow"
                                ? "allowed by default, nothing matched."
                                : t.decision === "protocol_reject"
                                  ? "resolved at the protocol layer, before the policy engine."
                                  : "resolved by a mandate-status check, before the policy engine ran."}
                            </p>
                          )}
                          <p className="mt-2 font-mono text-[10px]" style={{ color: "var(--muted-2)" }}>
                            trace {t.id} · mode: {t.mode}
                          </p>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Same shape as the revenue chart's tooltip, in this app's own tokens rather
 *  than the reference's blue/cyan/violet — one visual language, not two
 *  charting widgets that happen to sit on different tabs. */
function VolumeTooltip({ point }: { point: DecisionVolumePoint }) {
  const total = point.allow + point.escalate + point.block + point.protocol_reject;
  return (
    <div className="w-52 overflow-hidden rounded-lg border shadow-xl" style={{ borderColor: "var(--panel-border-strong)" }}>
      <div className="px-3 py-1.5 text-[11px] font-semibold text-white" style={{ background: "var(--brand-violet)" }}>
        {point.label}
      </div>
      <div className="space-y-1.5 px-3 py-2.5" style={{ background: "var(--panel)" }}>
        {VOLUME_SERIES.map((s) => {
          const value = point[s.key as keyof DecisionVolumePoint] as number;
          const pct = total > 0 ? (value / total) * 100 : 0;
          return (
            <div key={s.key} className="flex items-center gap-2">
              <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: s.color }} />
              <div className="flex w-full items-baseline justify-between gap-2 text-[11px]">
                <span style={{ color: "var(--muted)" }}>{s.label}</span>
                <span className="tabular-nums" style={{ color: "var(--foreground)" }}>
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
