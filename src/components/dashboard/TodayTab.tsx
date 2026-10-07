"use client";

import { useState, type ReactNode } from "react";
import { CaretDown, ShoppingCartSimple, Sparkle, Tag, Warning } from "@phosphor-icons/react";
import type { Alert, Escalation, Trace } from "@/types/db";
import type { CooData } from "@/lib/cooData";
import { loadSample } from "@/lib/actions/team";
import { EscalationsPanel } from "./EscalationsPanel";
import { EmptyState, Panel, PrimaryButton } from "./ui";
import { TimeAgo } from "./TimeAgo";
import { ErrorLine, Pill, Stat, rupees, rupeesShort, useRunner } from "./kit";
import { makeDescriber } from "./describe";
import { ManualPayoutsPanel } from "./ManualPayoutsPanel";
import { AnimatedNumber, ProgressRing, Reveal } from "./motion";
import { cumulative, dailyTotals } from "./trend";

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
  const [alertsOpen, setAlertsOpen] = useState(false);
  const { kpis } = coo;
  const describe = makeDescriber(coo);
  const empty = coo.vendors.length === 0 && coo.sales.length === 0;
  const idle = coo.workerIdle;
  const attention = coo.insights.filter((i) => i.active && (i.status === "stockout" || i.status === "low")).slice(0, 5);
  const stuck = coo.insights.filter((i) => i.active && (i.status === "dead" || i.status === "overstock")).slice(0, 5);

  const salesTrend = dailyTotals(coo.sales, (s) => s.captured_at, (s) => s.amount_paise / 100);
  const walletTrend = cumulative(dailyTotals(coo.wallet, (w) => w.created_at, (w) => (w.direction === "credit" ? 1 : -1) * (w.amount_paise / 100)));
  const budgetTotal = kpis.restockBudgetRemainingPaise + kpis.paidOut7dPaise;
  const budgetLeft = budgetTotal > 0 ? kpis.restockBudgetRemainingPaise / budgetTotal : 0;

  return (
    <div className="flex flex-col gap-8">
      {empty && (
        <Reveal>
          <div className="surface flex flex-wrap items-center justify-between gap-6 p-8">
            <div className="max-w-2xl">
              <p className="text-[24px] font-semibold leading-[30px] tracking-tight">Start with a sample store</p>
              <p className="mt-2 text-[15px] leading-6" style={{ color: "var(--muted)" }}>
                Loads six products with realistic stock and sales history, two sandbox suppliers and two sample customers, so you can watch the team
                restock a bestseller and clear slow stock. Nothing real is contacted or paid; everything it creates is labelled as a sample.
              </p>
              <div className="mt-3">
                <ErrorLine error={error} />
              </div>
            </div>
            <PrimaryButton disabled={pending} className="px-6" onClick={() => run(() => loadSample())}>
              {pending ? "Loading…" : "Load the sample store"}
            </PrimaryButton>
          </div>
        </Reveal>
      )}

      {idle && !empty && (
        <div className="flex items-start gap-3 rounded-[14px] border px-5 py-4 text-[14px] leading-6" style={{ borderColor: "color-mix(in srgb, var(--decision-escalate) 45%, transparent)", color: "var(--decision-escalate)", background: "color-mix(in srgb, var(--decision-escalate) 8%, transparent)" }}>
          <Warning size={20} className="mt-0.5 shrink-0" />
          <p>
            Your team has not run in a while. The agents run in a separate worker process: start it with <code className="rounded bg-white/10 px-1.5 py-0.5">npm run worker</code>
            {coo.lastRunAt && (
              <>
                {" "}
                (last seen <TimeAgo iso={coo.lastRunAt} />)
              </>
            )}
            .
          </p>
        </div>
      )}

      <section aria-label="Key numbers" className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
        <Reveal index={0} className="h-full">
          <Stat label="In your wallet" value={<AnimatedNumber value={kpis.walletPaise} format={(n) => rupeesShort(n)} />} sub="sales in, supplier payments out" spark={walletTrend} />
        </Reveal>
        <Reveal index={1} className="h-full">
          <Stat label="Earned this week" value={<AnimatedNumber value={kpis.earned7dPaise} format={(n) => rupeesShort(n)} />} sub="real sales only" tone="var(--decision-allow)" spark={salesTrend} />
        </Reveal>
        <Reveal index={2} className="h-full">
          <div className="surface flex h-full items-center justify-between gap-4 p-6">
            <div>
              <p className="text-[13px] font-medium" style={{ color: "var(--muted)" }}>
                Restock budget left
              </p>
              <p className="num mt-2 text-[34px] font-semibold leading-[40px]">
                <AnimatedNumber value={kpis.restockBudgetRemainingPaise} format={(n) => rupeesShort(n)} />
              </p>
              <p className="mt-1.5 text-[13px] leading-5" style={{ color: "var(--muted)" }}>
                {rupeesShort(kpis.paidOut7dPaise)} paid this week
              </p>
            </div>
            <ProgressRing value={budgetLeft} size={72} stroke={7} color="var(--brand-violet)">
              <span className="num text-[14px] font-semibold">{Math.round(budgetLeft * 100)}%</span>
            </ProgressRing>
          </div>
        </Reveal>
        <Reveal index={3} className="h-full">
          <Stat
            label="Cash in slow stock"
            value={<AnimatedNumber value={kpis.deadStockPaise} format={(n) => rupeesShort(n)} />}
            sub={kpis.runningLow > 0 ? `${kpis.runningLow} running low, ${kpis.needsRestock} to reorder` : "valued at cost"}
            tone={kpis.deadStockPaise > 0 ? "var(--decision-escalate)" : undefined}
          />
        </Reveal>
      </section>

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2 [&>*:only-child]:lg:col-span-2">
        <ManualPayoutsPanel coo={coo} />
        <EscalationsPanel escalations={escalations} tracesById={tracesById} describe={describe} />
      </div>

      {map}

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-5">
        <Panel
          title="What your team did"
          description="Each pass of your two agents, in plain words."
          icon={<Sparkle size={20} />}
          accent="var(--entity-agent)"
          className="xl:col-span-3"
          bodyClassName="max-h-[640px] overflow-y-auto pr-2 fade-mask-y"
        >
          {coo.runs.length === 0 ? (
            <EmptyState text="No runs yet." hint="Once the worker is running, each pass shows up here." />
          ) : (
            <ol className="relative ml-2 space-y-6 border-l pl-8" style={{ borderColor: "var(--hairline-strong)" }}>
              {coo.runs.slice(0, 12).map((r) => {
                const buying = r.kind === "buying";
                const color = r.status === "error" ? "var(--decision-block)" : buying ? "var(--entity-agent)" : "var(--decision-allow)";
                return (
                  <li key={r.id} className="relative">
                    <span className="absolute -left-[45px] top-0.5 flex h-8 w-8 items-center justify-center rounded-full border-4" style={{ borderColor: "var(--surface)", background: `color-mix(in srgb, ${color} 28%, var(--surface-3))`, color }}>
                      {buying ? <ShoppingCartSimple size={15} weight="fill" /> : <Tag size={15} weight="fill" />}
                    </span>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="text-[15px] font-semibold">{buying ? "Buying agent" : "Selling agent"}</span>
                      {r.dry_run && <Pill color="var(--decision-escalate)">Dry run</Pill>}
                      {r.status === "error" && <Pill color="var(--decision-block)">Error</Pill>}
                      <span className="text-[13px]" style={{ color: "var(--muted-2)" }}>
                        <TimeAgo iso={r.started_at} />
                      </span>
                    </div>
                    <p className="mt-1.5 text-[15px] leading-6" style={{ color: r.status === "error" ? "var(--decision-block)" : "var(--muted)" }}>
                      {r.status === "error" ? r.error : r.summary || "Nothing to do."}
                    </p>
                  </li>
                );
              })}
            </ol>
          )}
        </Panel>

        <div className="flex flex-col gap-6 xl:col-span-2">
          <Panel title="Running out" description="Will be gone before the next order lands." icon={<Warning size={20} />} accent="var(--decision-block)">
            {attention.length === 0 ? (
              <EmptyState text="Nothing is about to run out." />
            ) : (
              <ul className="space-y-5">
                {attention.map((i) => {
                  const days = i.runwayDays ?? 0;
                  const pct = Math.max(0.06, Math.min(1, days / 30));
                  return (
                    <li key={i.sku}>
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="truncate text-[15px] font-medium">{i.name}</span>
                        <span className="num shrink-0 text-[14px]" style={{ color: "var(--muted)" }}>
                          {i.stockQty} left{i.runwayDays !== null ? `, ${Math.round(i.runwayDays)}d` : ""}
                        </span>
                      </div>
                      <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-white/[0.07]">
                        <div className="h-full rounded-full" style={{ width: `${pct * 100}%`, background: days < 7 ? "var(--decision-block)" : "var(--decision-escalate)", transition: "width 0.8s var(--ease-out)" }} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>

          <Panel title="Not selling" description="Money sitting on the shelf." icon={<Tag size={20} />} accent="var(--decision-escalate)">
            {stuck.length === 0 ? (
              <EmptyState text="No dead stock." />
            ) : (
              <ul className="space-y-4">
                {stuck.map((i) => (
                  <li key={i.sku} className="flex items-center justify-between gap-3">
                    <span className="truncate text-[15px] font-medium">
                      {i.name}
                      {i.compareAtPaise !== null && (
                        <span className="ml-2 text-[13px]" style={{ color: "var(--decision-allow)" }}>
                          on sale
                        </span>
                      )}
                    </span>
                    <span className="num shrink-0 text-[14px]" style={{ color: "var(--decision-escalate)" }}>
                      {rupees(i.cashTiedPaise)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>

      <section className="surface overflow-hidden">
        <button type="button" onClick={() => setAlertsOpen((v) => !v)} aria-expanded={alertsOpen} className="focus-ring flex w-full items-center justify-between gap-4 px-7 py-5 text-left">
          <span className="flex items-center gap-3 text-[17px] font-semibold tracking-[-0.01em]">
            Recent alerts
            {alerts.length > 0 && <span className="num rounded-full bg-white/10 px-2.5 py-0.5 text-[13px] font-medium">{alerts.length}</span>}
          </span>
          <CaretDown size={18} style={{ color: "var(--muted)", transform: alertsOpen ? "rotate(180deg)" : "none", transition: "transform 0.3s var(--ease-out)" }} />
        </button>
        {alertsOpen && (
          <div className="border-t px-7 pb-6 pt-4" style={{ borderColor: "var(--hairline)" }}>
            {alerts.length === 0 ? (
              <EmptyState text="All quiet." />
            ) : (
              <ul className="space-y-3">
                {alerts.slice(0, 12).map((a) => (
                  <li key={a.id} className="flex items-start gap-3 text-[15px] leading-6">
                    <span className="mt-2 h-2 w-2 shrink-0 rounded-full" style={{ background: a.severity === "high" ? "var(--decision-block)" : a.severity === "notable" ? "var(--decision-escalate)" : "var(--muted-2)" }} />
                    {a.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
