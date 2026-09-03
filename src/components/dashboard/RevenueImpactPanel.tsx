"use client";

import { useMemo } from "react";
import type { Escalation, Trace } from "@/types/db";
import {
  computeRevenueGrowthCurve,
  computeRevenueImpact,
  computeRevenueTimeline,
  totalExecuted,
  type RevenueTimelinePoint,
} from "@/lib/revenue";
import { formatMoney } from "@/lib/format";
import { StackedAreaChart, type StackedAreaSeries } from "./charts/StackedAreaChart";
import { AnimatedLineChart } from "./charts/AnimatedLineChart";

/** The same four categories the figure grid below shows — kept identical on
 *  purpose, so the chart and the numbers next to it are never describing a
 *  different slice of the same data. `deniedAtGate` exists in the underlying
 *  model but was never one of the four headline figures either; the chart
 *  follows that precedent rather than introducing a fifth category the rest
 *  of the panel doesn't have.
 *
 *  ORDER MATTERS in a stacked area chart, and getting it wrong here produced a
 *  real, confusing bug: `refused` was drawn LAST, so its stroke traced the top
 *  of the WHOLE stack (every layer's cumulative height, not its own) — a
 *  single large approved order made the "refused" line spike to the sum of
 *  everything underneath it, reading as a huge refusal that never happened.
 *  `refused` now sits FIRST (bottom, baseline zero), so its own boundary shows
 *  its own true amount and nothing else's. `clearedAutomatically` sits LAST
 *  (top), so the outer boundary — the one shape every viewer's eye follows —
 *  traces the grand total, which is the one number that outline SHOULD mean. */
const SERIES: StackedAreaSeries[] = [
  { key: "refused", label: "Refused", color: "var(--decision-block)" },
  { key: "awaitingApproval", label: "Awaiting approval", color: "var(--decision-escalate)" },
  { key: "approvedThroughGate", label: "Approved at the gate", color: "var(--entity-agent)" },
  { key: "clearedAutomatically", label: "Cleared automatically", color: "var(--decision-allow)" },
];

/**
 * What the control plane did to this merchant's revenue.
 *
 * The figure worth reading is "approved at the gate": money a rule that
 * *blocked* at the same threshold would have refused outright. Escalating
 * instead held it for a human, and the human let it through. That is the
 * growth argument for a control plane, and it is a replay of decisions that
 * actually happened rather than a projection.
 *
 * Deliberately shows the refused column too. A panel that only reported
 * recovered revenue would be marketing; the point is that the same system
 * decides both, and the refusals are the reason the approvals can be trusted.
 *
 * Scoped to the traces the dashboard holds (most recent 300), and says so —
 * an unqualified total would imply all-time and be wrong.
 */
export function RevenueImpactPanel({
  traces,
  escalations,
}: {
  traces: Trace[];
  escalations: Escalation[];
}) {
  const impact = useMemo(() => computeRevenueImpact(traces, escalations), [traces, escalations]);
  const timeline = useMemo(() => computeRevenueTimeline(traces, escalations), [traces, escalations]);
  // Arithmetic on the timeline's already-verified numbers, not a third pass
  // over the trace list — see computeRevenueGrowthCurve's own comment.
  const growth = useMemo(() => computeRevenueGrowthCurve(timeline), [timeline]);
  const executed = totalExecuted(impact);

  // Largest first, and named as a merchant would name them rather than by
  // action type. "payment_link.create" is our vocabulary, not theirs.
  const ACTION_LABELS: Record<string, string> = {
    "order.create": "orders",
    "payment_link.create": "campaign links",
    "refund.create": "refunds",
    "subscription.create": "subscriptions",
  };
  const settledSplit = Object.entries(impact.byActionType)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([type, value]) => [ACTION_LABELS[type] ?? type, value] as [string, number]);

  return (
    <section className="panel-card relative overflow-hidden rounded-2xl p-6">
      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1.5">
        <div className="flex items-baseline gap-3">
          <h2 className="text-[15px] font-semibold tracking-tight">Revenue impact</h2>
          <span className="text-[11.5px]" style={{ color: "var(--muted-2)" }}>
            across the last {traces.length} actions
          </span>
        </div>
        <div className="text-right">
          <div className="flex items-baseline justify-end gap-2">
            <span className="text-[30px] font-semibold leading-none tracking-tight tabular-nums">
              {formatMoney(executed, "INR")}
            </span>
            <span className="text-[11.5px]" style={{ color: "var(--muted)" }}>
              total money moved
            </span>
          </div>
          {/* The scope, in the label rather than a tooltip. This figure counts
              every action type; the Buy tab counts orders alone. Two numbers
              called "moved" that disagree is a credibility problem for whoever
              spots it first, so the arithmetic between them is shown. */}
          <p className="mt-0.5 text-[10.5px] tabular-nums" style={{ color: "var(--muted-2)" }}>
            {settledSplit.length > 0
              ? settledSplit.map(([label, value]) => `${label} ${formatMoney(value, "INR")}`).join("  ·  ")
              : "nothing settled yet"}
          </p>
        </div>
      </div>

      {/* The hero: money made, growing. A cumulative curve reads at a glance
          in a way the stacked breakdown below it doesn't — "it's going up" is
          the one-second story a first-time viewer takes away, and the detail
          underneath is for whoever stays to look. Same underlying numbers as
          the headline figure above (the curve's last point equals it exactly)
          and the breakdown below — three views of one dataset, not three
          datasets. */}
      {growth.length >= 2 && (
        <div className="mb-5 rounded-xl border p-4" style={{ borderColor: "var(--panel-border)", background: "var(--panel-2)" }}>
          <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider" style={{ color: "var(--muted-2)" }}>
            Money made, over time
          </p>
          <AnimatedLineChart
            data={growth.map((g) => ({ label: g.label, value: g.cumulative }))}
            color="var(--decision-allow)"
            height={140}
            valueFormatter={(v) => formatMoney(Math.round(v), "INR")}
            // Money made is a running total: it starts at whatever the first
            // bucket settled and only ever climbs. A generic 12% axis pad
            // pushed the floor NEGATIVE for a curve that can't go there --
            // this clamps it at zero, the one value the axis floor is allowed
            // to reach but never cross.
            clampMin={0}
          />
        </div>
      )}

      {/* Replaces a single proportioned bar: same four categories, but over
          time rather than collapsed into one instant. The bar could say "this
          much has been refused"; it couldn't say "refusals spiked Tuesday
          afternoon," which is the more useful shape of the same data. */}
      <StackedAreaChart
        data={timeline}
        indexKey="label"
        series={SERIES}
        valueFormatter={(v) => formatMoney(v, "INR")}
        height={200}
        renderTooltip={(point) => <RevenueTooltip point={point} />}
      />

      <div className="mt-5 grid grid-cols-2 gap-x-5 gap-y-3 border-t pt-4 sm:grid-cols-4" style={{ borderColor: "var(--panel-border)" }}>
        <Figure
          label="Cleared automatically"
          value={impact.clearedAutomatically}
          count={impact.counts.clearedAutomatically}
          color="var(--decision-allow)"
          note="no rule stopped it"
        />
        <Figure
          label="Approved at the gate"
          value={impact.approvedThroughGate}
          count={impact.counts.approvedThroughGate}
          color="var(--entity-agent)"
          note="a blunt block would have refused this"
        />
        <Figure
          label="Awaiting approval"
          value={impact.awaitingApproval}
          count={impact.counts.awaitingApproval}
          color="var(--decision-escalate)"
          note="held, not yet decided"
        />
        <Figure
          label="Refused"
          value={impact.refused}
          count={impact.counts.refused}
          color="var(--decision-block)"
          note="banned category or rate limit"
        />
      </div>

      {impact.counts.upsell > 0 && (
        <p className="mt-3 border-t pt-3 text-[11px]" style={{ borderColor: "var(--panel-border)", color: "var(--muted)" }}>
          <span className="font-semibold" style={{ color: "var(--entity-mandate)" }}>
            {formatMoney(impact.upsell, "INR")}
          </span>{" "}
          of that came from {impact.counts.upsell} agent upsell{impact.counts.upsell === 1 ? "" : "s"} — a purchase
          that only happened because the agent proposed it.
        </p>
      )}

      {impact.counts.approvedThroughGate > 0 && (
        <p className="mt-3 text-[11px] leading-relaxed" style={{ color: "var(--muted-2)" }}>
          Escalating rather than blocking is what recovered the{" "}
          <span className="font-semibold" style={{ color: "var(--entity-agent)" }}>
            {formatMoney(impact.approvedThroughGate, "INR")}
          </span>{" "}
          above. A rule that refused at the same threshold would have cost the merchant every rupee of it.
        </p>
      )}
    </section>
  );
}

function Figure({
  label,
  value,
  count,
  color,
  note,
}: {
  label: string;
  value: number;
  count: number;
  color: string;
  note: string;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
        <span className="text-[10.5px] font-semibold uppercase tracking-wider" style={{ color: "var(--muted-2)" }}>
          {label}
        </span>
      </div>
      <p className="mt-1.5 text-[18px] font-semibold leading-none tracking-tight tabular-nums">
        {formatMoney(value, "INR")}
      </p>
      <p className="mt-1 text-[10.5px]" style={{ color: "var(--muted-2)" }}>
        {count} action{count === 1 ? "" : "s"} · {note}
      </p>
    </div>
  );
}

/**
 * The rich per-bucket breakdown, in the reference's shape — a date header card
 * plus a category list with dot / value / share-of-bucket — rebuilt on this
 * app's own tokens rather than the reference's blue/cyan/violet, so it reads
 * as the same visual language as the rest of the dashboard rather than a
 * pasted-in widget.
 */
function RevenueTooltip({ point }: { point: RevenueTimelinePoint }) {
  const total = SERIES.reduce((sum, s) => sum + (Number(point[s.key as keyof RevenueTimelinePoint]) || 0), 0);
  return (
    <div className="w-56 overflow-hidden rounded-lg border shadow-xl" style={{ borderColor: "var(--panel-border-strong)" }}>
      <div className="px-3 py-1.5 text-[11px] font-semibold text-white" style={{ background: "var(--brand-violet)" }}>
        {point.label}
      </div>
      <div className="space-y-1.5 px-3 py-2.5" style={{ background: "var(--panel)" }}>
        {SERIES.map((s) => {
          const value = Number(point[s.key as keyof RevenueTimelinePoint]) || 0;
          const pct = total > 0 ? (value / total) * 100 : 0;
          return (
            <div key={s.key} className="flex items-center gap-2">
              <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: s.color }} />
              <div className="flex w-full items-baseline justify-between gap-2 text-[11px]">
                <span style={{ color: "var(--muted)" }}>{s.label}</span>
                <span className="tabular-nums" style={{ color: "var(--foreground)" }}>
                  {formatMoney(value, "INR")}{" "}
                  <span style={{ color: "var(--muted-2)" }}>({pct.toFixed(0)}%)</span>
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
