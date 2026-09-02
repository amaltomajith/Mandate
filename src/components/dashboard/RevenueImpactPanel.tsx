"use client";

import { useMemo } from "react";
import type { Escalation, Trace } from "@/types/db";
import { computeRevenueImpact, totalExecuted } from "@/lib/revenue";
import { formatMoney } from "@/lib/format";

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

  const decided = executed + impact.refused + impact.deniedAtGate;
  const share = (value: number) => (decided > 0 ? (value / decided) * 100 : 0);

  return (
    <section className="panel-card relative overflow-hidden rounded-2xl p-5">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex items-baseline gap-3">
          <h2 className="text-[13px] font-semibold tracking-tight">Revenue impact</h2>
          <span className="text-[11px]" style={{ color: "var(--muted-2)" }}>
            across the last {traces.length} actions
          </span>
        </div>
        <div className="text-right">
          <div className="flex items-baseline justify-end gap-2">
            <span className="text-[22px] font-semibold tabular-nums">{formatMoney(executed, "INR")}</span>
            <span className="text-[11px]" style={{ color: "var(--muted)" }}>
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

      {/* One bar, proportioned by value rather than count — a single large
          refusal matters more than a dozen small clearances, and a count-based
          bar would say the opposite. */}
      <div className="flex h-2 w-full overflow-hidden rounded-full" style={{ background: "var(--panel-border)" }}>
        <Segment width={share(impact.clearedAutomatically)} color="var(--decision-allow)" />
        <Segment width={share(impact.approvedThroughGate)} color="var(--entity-agent)" />
        <Segment width={share(impact.deniedAtGate)} color="var(--muted-2)" />
        <Segment width={share(impact.refused)} color="var(--decision-block)" />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-4">
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

function Segment({ width, color }: { width: number; color: string }) {
  if (width <= 0) return null;
  return <div className="h-full transition-all duration-500" style={{ width: `${width}%`, background: color }} />;
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
        <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--muted-2)" }}>
          {label}
        </span>
      </div>
      <p className="mt-1 text-[15px] font-semibold tabular-nums">{formatMoney(value, "INR")}</p>
      <p className="text-[10px]" style={{ color: "var(--muted-2)" }}>
        {count} action{count === 1 ? "" : "s"} · {note}
      </p>
    </div>
  );
}
