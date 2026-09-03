"use client";

import { useMemo, useState } from "react";
import type { Customer, Escalation, Product, Trace } from "@/types/db";
import { deriveOrders, summarizeOrders, type Order, type OrderOutcome } from "@/lib/orders";
import { formatMoney } from "@/lib/format";
import { EmptyState, Icons, Panel } from "./ui";
import { TimeAgo } from "./TimeAgo";

const OUTCOME_META: Record<OrderOutcome, { label: string; color: string; hint: string }> = {
  bought: { label: "Bought", color: "var(--decision-allow)", hint: "cleared with no rule stopping it" },
  approved: { label: "Approved", color: "var(--decision-allow)", hint: "held for you, and you said yes" },
  awaiting: { label: "Waiting", color: "var(--decision-escalate)", hint: "sitting in your escalation queue" },
  declined: { label: "Declined", color: "var(--muted)", hint: "held for you, and you said no" },
  refused: { label: "Refused", color: "var(--decision-block)", hint: "stopped by a rule before it reached the queue" },
};

const FILTERS: { key: "all" | "placed" | "waiting" | "stopped"; label: string; match: (o: Order) => boolean }[] = [
  { key: "all", label: "Everything", match: () => true },
  { key: "placed", label: "Sold", match: (o) => o.outcome === "bought" || o.outcome === "approved" },
  { key: "waiting", label: "Waiting on you", match: (o) => o.outcome === "awaiting" },
  { key: "stopped", label: "Stopped", match: (o) => o.outcome === "refused" || o.outcome === "declined" },
];

interface Props {
  traces: Trace[];
  escalations: Escalation[];
  products: Product[];
  customers: Customer[];
}

/**
 * What the agent has actually been buying, and how that is going.
 *
 * The Buy tab used to show only what *could* happen — a checkout box and a
 * list of what would currently clear. Both are forward-looking, and together
 * they left the tab unable to answer the first question anyone asks about a
 * shop: what has been selling. This is that answer, read straight out of the
 * audit trail.
 *
 * Deliberately not a second Transactions table. That tab is the investigative
 * log, every action including previews and rejected signatures. This one is
 * commerce: real orders, named products, the customer they were for, and
 * whether the merchant had to stop and answer.
 */
export function BuyingActivity({ traces, escalations, products, customers }: Props) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("all");

  const orders = useMemo(
    () => deriveOrders(traces, escalations, products, customers),
    [traces, escalations, products, customers]
  );
  const summary = useMemo(() => summarizeOrders(orders), [orders]);

  const visible = orders.filter(FILTERS.find((f) => f.key === filter)!.match);
  const topSellers = summary.bestSellers.slice(0, 3);
  const leadRevenue = topSellers[0]?.revenuePaise ?? 0;

  return (
    <Panel
      title="Buying activity"
      icon={<Icons.Sparkles />}
      accent="var(--decision-allow)"
      /* Scope stated rather than implied. The dashboard holds the most recent
         300 actions, so these are not lifetime totals, and a revenue figure
         that quietly means "recently" is the kind of number that does not
         survive being asked what it covers. */
      action={
        <span className="text-[10px]" style={{ color: "var(--muted-2)" }}>
          last {traces.length} actions
        </span>
      }
    >
      {orders.length === 0 ? (
        <EmptyState text="No orders yet. Buy something above, or start the simulation on the Overview tab." />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <Stat label="Sold" value={String(summary.ordersPlaced)} sub="orders completed" />
            {/* "Order revenue", not "money moved". The Overview headline counts
                every action type including campaign payment links; this counts
                orders. Both were labelled the same and disagreed. */}
            <Stat label="Order revenue" value={formatMoney(summary.revenuePaise, "INR")} sub="completed orders only" />
            <Stat
              label="Average order"
              value={formatMoney(summary.averageOrderPaise, "INR")}
              sub="per completed order"
            />
            <Stat
              label="Handled alone"
              value={`${Math.round(summary.unaidedShare * 100)}%`}
              sub={`of orders · ${Math.round(summary.unaidedValueShare * 100)}% of value`}
              tone="var(--decision-allow)"
            />
          </div>

          {/* Two things the merchant can act on today, called out rather than
              left to be inferred from the list: money parked in the queue, and
              whether the cross-sell is earning its place. */}
          <div className="mt-2.5 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            <Callout
              tone={summary.awaitingCount > 0 ? "var(--decision-escalate)" : "var(--muted-2)"}
              headline={
                summary.awaitingCount > 0
                  ? `${formatMoney(summary.awaitingPaise, "INR")} waiting on you`
                  : "Nothing waiting on you"
              }
              detail={
                summary.awaitingCount > 0
                  ? `${summary.awaitingCount} order${summary.awaitingCount === 1 ? "" : "s"} held for approval. Approve in Escalations and they complete.`
                  : "Every order has been settled one way or the other."
              }
            />
            <Callout
              tone={summary.upsellOrders > 0 ? "var(--entity-agent)" : "var(--muted-2)"}
              headline={
                summary.upsellOrders > 0
                  ? `${formatMoney(summary.upsellRevenuePaise, "INR")} from cross-sell`
                  : "No cross-sell yet"
              }
              detail={
                summary.upsellOrders > 0
                  ? `${summary.upsellOrders} order${summary.upsellOrders === 1 ? "" : "s"} the agent proposed off the back of another — attached to ${Math.round(summary.attachRate * 100)}% of the rest.`
                  : "The agent offers a companion product after a purchase clears. None have landed so far."
              }
            />
          </div>

          {topSellers.length > 0 && (
            <div className="mt-3">
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--muted-2)" }}>
                Best sellers
              </p>
              <div className="space-y-1">
                {topSellers.map((s) => (
                  <div key={s.product} className="flex items-center gap-2.5">
                    <span className="w-32 shrink-0 truncate text-[11px]">{s.product}</span>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full" style={{ background: "var(--panel-2)" }}>
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${leadRevenue > 0 ? (s.revenuePaise / leadRevenue) * 100 : 0}%`,
                          background: "var(--decision-allow)",
                        }}
                      />
                    </div>
                    <span className="w-14 shrink-0 text-right text-[11px] font-semibold tabular-nums">
                      {formatMoney(s.revenuePaise, "INR")}
                    </span>
                    <span className="w-12 shrink-0 text-right text-[10px] tabular-nums" style={{ color: "var(--muted-2)" }}>
                      {s.orders}×
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mt-3.5 flex items-center gap-1.5 border-t pt-3" style={{ borderColor: "var(--panel-border)" }}>
            {FILTERS.map((f) => {
              const count = orders.filter(f.match).length;
              const active = f.key === filter;
              return (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key)}
                  className="rounded-full px-2.5 py-1 text-[10.5px] font-medium transition-colors"
                  style={{
                    background: active ? "var(--panel-2)" : "transparent",
                    color: active ? "var(--foreground)" : "var(--muted-2)",
                  }}
                >
                  {f.label} <span className="tabular-nums opacity-60">{count}</span>
                </button>
              );
            })}
          </div>

          {/* Fixed height, scrolled internally. The simulation adds an order
              every few seconds; letting this grow with the history pushed the
              whole page down while the merchant was reading it. */}
          <div className="mt-2 max-h-[26rem] space-y-1.5 overflow-y-auto pr-1">
            {visible.length === 0 ? (
              <EmptyState text="Nothing in this view yet." />
            ) : (
              visible.map((order) => <OrderRow key={order.traceId} order={order} />)
            )}
          </div>
        </>
      )}
    </Panel>
  );
}

function OrderRow({ order }: { order: Order }) {
  const meta = OUTCOME_META[order.outcome];
  return (
    <div className="flex items-start gap-2.5 rounded-lg px-2.5 py-2" style={{ background: "var(--panel-2)" }}>
      <span
        className="mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide"
        style={{ background: `${meta.color}26`, color: meta.color }}
        title={meta.hint}
      >
        {meta.label}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="truncate text-[12px] font-medium">
            {order.product ?? <span style={{ color: "var(--muted)" }}>Order in {order.category}</span>}
            {order.isUpsell && (
              <span
                className="ml-1.5 rounded px-1 py-0.5 text-[8.5px] font-semibold uppercase tracking-wide"
                style={{ background: "color-mix(in srgb, var(--entity-agent) 20%, transparent)", color: "var(--entity-agent)" }}
              >
                cross-sell
              </span>
            )}
          </p>
          <p className="shrink-0 text-[12px] font-semibold tabular-nums">
            {formatMoney(order.amountPaise, order.currency)}
          </p>
        </div>
        <p className="mt-0.5 truncate text-[10px]" style={{ color: "var(--muted-2)" }}>
          {order.customerName ? `${order.customerName} · ` : ""}
          <TimeAgo iso={order.at} />
          {order.outcome !== "bought" && order.reasoning ? ` · ${order.reasoning}` : ""}
        </p>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: string }) {
  return (
    <div className="rounded-xl border px-2.5 py-2" style={{ borderColor: "var(--panel-border)", background: "var(--panel-2)" }}>
      <p className="text-[9.5px] font-semibold uppercase tracking-wider" style={{ color: "var(--muted-2)" }}>
        {label}
      </p>
      <p className="mt-0.5 text-[17px] font-semibold tabular-nums" style={{ color: tone ?? "var(--foreground)" }}>
        {value}
      </p>
      <p className="text-[9.5px]" style={{ color: "var(--muted-2)" }}>
        {sub}
      </p>
    </div>
  );
}

function Callout({ tone, headline, detail }: { tone: string; headline: string; detail: string }) {
  return (
    <div
      className="rounded-xl border px-3 py-2"
      style={{ borderColor: `color-mix(in srgb, ${tone} 45%, transparent)`, background: `color-mix(in srgb, ${tone} 8%, transparent)` }}
    >
      <p className="text-[12px] font-semibold" style={{ color: tone }}>
        {headline}
      </p>
      <p className="mt-0.5 text-[10.5px] leading-snug" style={{ color: "var(--muted)" }}>
        {detail}
      </p>
    </div>
  );
}
