"use client";

import type { ReactNode } from "react";
import type { Alert, Escalation, Trace } from "@/types/db";
import type { CooData } from "@/lib/cooData";
import { loadSample } from "@/lib/actions/team";
import { EscalationsPanel } from "./EscalationsPanel";
import { EmptyState, Icons, Panel, PrimaryButton } from "./ui";
import { TimeAgo } from "./TimeAgo";
import { ErrorLine, Pill, Stat, rupees, rupeesShort, useRunner } from "./kit";
import { makeDescriber } from "./describe";

/**
 * The first screen: is the business healthy, what did the team do, and what is
 * waiting for me. Written in the merchant's terms (cash, stock, approvals), not
 * the system's.
 */
export function TodayTab({
  coo,
  escalations,
  tracesById,
  alerts,
  map,
}: {
  coo: CooData;
  escalations: Escalation[];
  tracesById: Record<string, Trace>;
  alerts: Alert[];
  map: ReactNode;
}) {
  const { error, pending, run } = useRunner();
  const { kpis } = coo;
  const describe = makeDescriber(coo);
  const empty = coo.vendors.length === 0 && coo.sales.length === 0;
  const idle = coo.workerIdle;
  const attention = coo.insights.filter((i) => i.active && (i.status === "stockout" || i.status === "low")).slice(0, 4);
  const stuck = coo.insights.filter((i) => i.active && (i.status === "dead" || i.status === "overstock")).slice(0, 4);

  return (
    <div className="flex flex-col gap-5">
      {empty && (
        <div className="panel-card flex flex-wrap items-center justify-between gap-4 rounded-2xl p-5">
          <div className="max-w-xl">
            <p className="text-[15px] font-semibold">Start with a sample store</p>
            <p className="mt-1 text-[13px]" style={{ color: "var(--muted)" }}>
              Loads six products with realistic stock and sales history, two sandbox suppliers and two sample customers, so you can watch the team
              restock a bestseller and clear slow stock. Nothing real is contacted or paid; everything it creates is labelled as a sample.
            </p>
            <ErrorLine error={error} />
          </div>
          <PrimaryButton disabled={pending} className="px-5" onClick={() => run(() => loadSample())}>
            {pending ? "Loading…" : "Load the sample store"}
          </PrimaryButton>
        </div>
      )}

      {idle && !empty && (
        <div className="rounded-2xl border px-4 py-3 text-[13px]" style={{ borderColor: "var(--decision-escalate)", color: "var(--decision-escalate)", background: "color-mix(in srgb, var(--decision-escalate) 8%, transparent)" }}>
          Your team has not run in a while. The agents run in a separate worker process: start it with <code>npm run worker</code>
          {coo.lastRunAt && (
            <>
              {" "}
              (last seen <TimeAgo iso={coo.lastRunAt} />)
            </>
          )}
          .
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Wallet" value={rupeesShort(kpis.walletPaise)} sub="in minus out" />
        <Stat label="Earned this week" value={rupeesShort(kpis.earned7dPaise)} sub="real sales only" tone="var(--decision-allow)" />
        <Stat label="Paid to suppliers" value={rupeesShort(kpis.paidOut7dPaise)} sub="this week" />
        <Stat label="Restock budget left" value={rupeesShort(kpis.restockBudgetRemainingPaise)} sub="self-funded cap" />
        <Stat label="Cash in slow stock" value={rupeesShort(kpis.deadStockPaise)} sub="at cost" tone={kpis.deadStockPaise > 0 ? "var(--decision-escalate)" : undefined} />
        <Stat label="Running low" value={kpis.runningLow} sub={`${kpis.needsRestock} to reorder`} tone={kpis.runningLow > 0 ? "var(--decision-block)" : undefined} />
      </div>

      {map}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <EscalationsPanel escalations={escalations} tracesById={tracesById} describe={describe} />

        <Panel title="What your team did" icon={<Icons.Sparkles />} accent="var(--entity-agent)" bodyClassName="max-h-[520px] overflow-y-auto pr-1">
          {coo.runs.length === 0 ? (
            <EmptyState text="No runs yet. Once the worker is running, each pass shows up here in plain words." />
          ) : (
            <ul className="space-y-3">
              {coo.runs.slice(0, 12).map((r) => (
                <li key={r.id} className="rounded-xl p-3" style={{ background: "var(--panel-2)" }}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12px] font-semibold">{r.kind === "buying" ? "Buying agent" : "Selling agent"}</span>
                    <span className="flex items-center gap-2 text-[10.5px]" style={{ color: "var(--muted-2)" }}>
                      {r.dry_run && <Pill color="var(--decision-escalate)">dry run</Pill>}
                      {r.status === "error" && <Pill color="var(--decision-block)">error</Pill>}
                      <TimeAgo iso={r.started_at} />
                    </span>
                  </div>
                  <p className="mt-1 text-[12px] leading-relaxed" style={{ color: r.status === "error" ? "var(--decision-block)" : "var(--muted)" }}>
                    {r.status === "error" ? r.error : r.summary || "Nothing to do."}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Panel title="Running out" icon={<Icons.AlertTriangle />} accent="var(--decision-block)">
          {attention.length === 0 ? (
            <EmptyState text="Nothing is about to run out." />
          ) : (
            <ul className="space-y-2.5">
              {attention.map((i) => (
                <li key={i.sku} className="flex items-center justify-between gap-3 text-[12.5px]">
                  <span className="truncate">{i.name}</span>
                  <span className="shrink-0 tabular-nums" style={{ color: "var(--muted)" }}>
                    {i.stockQty} left{i.runwayDays !== null ? ` · ${Math.round(i.runwayDays)}d` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Not selling" icon={<Icons.Shield />} accent="var(--decision-escalate)">
          {stuck.length === 0 ? (
            <EmptyState text="No dead stock." />
          ) : (
            <ul className="space-y-2.5">
              {stuck.map((i) => (
                <li key={i.sku} className="flex items-center justify-between gap-3 text-[12.5px]">
                  <span className="truncate">
                    {i.name}
                    {i.compareAtPaise !== null && (
                      <span className="ml-1.5" style={{ color: "var(--decision-allow)" }}>
                        on sale
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 tabular-nums" style={{ color: "var(--muted)" }}>
                    {rupees(i.cashTiedPaise)} tied up
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Recent alerts" icon={<Icons.Bell />} accent="var(--entity-mandate)" bodyClassName="max-h-[260px] overflow-y-auto pr-1">
          {alerts.length === 0 ? (
            <EmptyState text="All quiet." />
          ) : (
            <ul className="space-y-2.5">
              {alerts.slice(0, 8).map((a) => (
                <li key={a.id} className="text-[12px] leading-snug">
                  <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full" style={{ background: a.severity === "high" ? "var(--decision-block)" : a.severity === "notable" ? "var(--decision-escalate)" : "var(--muted-2)" }} />
                  {a.message}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
