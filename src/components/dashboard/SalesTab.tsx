"use client";

import { ArrowDownLeft, ArrowUpRight } from "@phosphor-icons/react";
import type { CooData } from "@/lib/cooData";
import type { Trace } from "@/types/db";
import { settleSandboxPayment } from "@/lib/actions/team";
import { EmptyState, Icons, Panel, SuccessButton } from "./ui";
import { ErrorLine, Pill, rupees, rupeesShort, useRunner } from "./kit";
import { AnimatedNumber, Reveal, Sparkline } from "./motion";
import { TimeAgo } from "./TimeAgo";
import { cumulative, dailyTotals } from "./trend";

/**
 * Money in and out: sales, payouts and the wallet that results.
 *
 * Also home to the sandbox's "customer pays" button. A sandbox payment link goes
 * nowhere real, so something has to stand in for the buyer paying it; this is
 * that, and it only ever accepts a link the sandbox itself created.
 */
export function SalesTab({ coo, traces }: { coo: CooData; traces: Trace[] }) {
  const { error, pending, run } = useRunner();
  const productName = (id: string | null) => coo.insights.find((i) => i.productId === id)?.name ?? "Unknown product";
  const vendorByPayee = (payeeId: string | null) => coo.payees.find((x) => x.id === payeeId)?.display_name ?? "A supplier";

  const settled = new Set(coo.sales.map((s) => s.razorpay_payment_id));
  const awaiting = traces.filter((t) => {
    if (t.action_type !== "payment_link.create" && t.action_type !== "order.create") return false;
    if (t.decision !== "allow" || t.mode !== "enforce") return false;
    const r = t.razorpay_response as { simulated?: boolean; id?: string } | null;
    if (!r?.simulated || !r.id) return false;
    return !settled.has(`sim_pay_${r.id.replace(/^sim_(plink|order)_/, "")}`);
  });

  const { kpis } = coo;
  const salesDaily = dailyTotals(coo.sales, (s) => s.captured_at, (s) => s.amount_paise / 100);
  const walletTrend = cumulative(dailyTotals(coo.wallet, (w) => w.created_at, (w) => (w.direction === "credit" ? 1 : -1) * (w.amount_paise / 100)));
  const total14 = salesDaily.reduce((a, b) => a + b, 0);

  return (
    <div className="flex flex-col gap-8">
      <ErrorLine error={error} />

      <section className="grid grid-cols-1 gap-5 xl:grid-cols-3" aria-label="Money summary">
        <Reveal index={0} className="h-full xl:col-span-2">
          <div className="surface h-full p-7">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-[13px] font-medium" style={{ color: "var(--muted)" }}>
                  Sales, last 14 days
                </p>
                <p className="num mt-2 text-[40px] font-semibold leading-[44px]" style={{ color: "var(--decision-allow)" }}>
                  <AnimatedNumber value={total14 * 100} format={(n) => rupeesShort(n)} />
                </p>
              </div>
              <p className="text-[14px]" style={{ color: "var(--muted)" }}>
                {coo.sales.length} {coo.sales.length === 1 ? "sale" : "sales"} recorded
              </p>
            </div>
            <div className="mt-6">{salesDaily.length > 1 ? <Sparkline points={salesDaily} color="var(--decision-allow)" height={120} /> : <EmptyState text="Not enough sales to draw a trend yet." />}</div>
          </div>
        </Reveal>
        <div className="grid gap-5">
          <Reveal index={1}>
            <div className="surface p-6">
              <p className="text-[13px] font-medium" style={{ color: "var(--muted)" }}>
                In your wallet
              </p>
              <p className="num mt-2 text-[34px] font-semibold leading-[40px]">
                <AnimatedNumber value={kpis.walletPaise} format={(n) => rupeesShort(n)} />
              </p>
              {walletTrend.length > 1 && (
                <div className="mt-3">
                  <Sparkline points={walletTrend} height={36} />
                </div>
              )}
            </div>
          </Reveal>
          <Reveal index={2}>
            <div className="surface p-6">
              <p className="text-[13px] font-medium" style={{ color: "var(--muted)" }}>
                Paid to suppliers this week
              </p>
              <p className="num mt-2 text-[34px] font-semibold leading-[40px]">
                <AnimatedNumber value={kpis.paidOut7dPaise} format={(n) => rupeesShort(n)} />
              </p>
            </div>
          </Reveal>
        </div>
      </section>

      {awaiting.length > 0 && (
        <Panel
          title="Sandbox links waiting for a buyer"
          description="These links go nowhere real. Press the button to play the buyer paying: the sale, stock and wallet update as for a real payment."
          icon={<Icons.Sparkles />}
          accent="var(--entity-mandate)"
          count={awaiting.length}
        >
          <ul className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {awaiting.slice(0, 8).map((t) => {
              const p = t.params as { amount?: number; lineItems?: { sku: string; qty: number }[]; customerName?: string };
              const what = (p.lineItems ?? []).map((i) => `${i.qty} x ${coo.insights.find((x) => x.sku === i.sku)?.name ?? i.sku}`).join(", ");
              return (
                <li key={t.id} className="surface-tile flex items-center justify-between gap-4 p-5">
                  <div className="min-w-0">
                    <p className="num text-[22px] font-semibold leading-7">{rupees(p.amount)}</p>
                    <p className="mt-1 truncate text-[14px]" style={{ color: "var(--muted)" }}>
                      {what || "A sale"}
                      {p.customerName ? `, for ${p.customerName}` : ""}
                    </p>
                  </div>
                  <SuccessButton disabled={pending} onClick={() => run(() => settleSandboxPayment(t.id))}>
                    Buyer pays
                  </SuccessButton>
                </li>
              );
            })}
          </ul>
        </Panel>
      )}

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-2">
        <Panel title="Sales" description="Most recent first." icon={<Icons.CheckCircle />} accent="var(--decision-allow)" bodyClassName="max-h-[640px] overflow-y-auto fade-mask-y">
          {coo.sales.length === 0 ? (
            <EmptyState text="No sales yet." hint="Sales appear here the moment a buyer pays." />
          ) : (
            <ul className="divide-y" style={{ borderColor: "var(--hairline)" }}>
              {coo.sales.slice(0, 40).map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-4 py-4">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-[16px] font-medium">
                      <span className="truncate">{productName(s.product_id)}</span>
                      {(s.razorpay_payment_id ?? "").startsWith("sample_") && <Pill color="var(--entity-mandate)">Sample</Pill>}
                      {(s.razorpay_payment_id ?? "").startsWith("sim_pay_") && <Pill color="var(--entity-mandate)">Sandbox</Pill>}
                    </p>
                    <p className="mt-0.5 text-[13px]" style={{ color: "var(--muted-2)" }}>
                      {s.qty} {s.qty === 1 ? "unit" : "units"}, <TimeAgo iso={s.captured_at} />
                    </p>
                  </div>
                  <span className="num shrink-0 text-[17px] font-semibold" style={{ color: "var(--decision-allow)" }}>
                    {rupees(Number(s.amount_paise))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Paid to suppliers" description="Every payout, and where it stands." icon={<Icons.Shield />} accent="var(--entity-agent)" bodyClassName="max-h-[640px] overflow-y-auto fade-mask-y">
          {coo.payouts.length === 0 ? (
            <EmptyState text="No payouts yet." hint="When the buying agent pays an advance, it shows up here." />
          ) : (
            <ul className="space-y-3">
              {coo.payouts.map((p) => {
                const label = p.manual && p.status === "queued" ? "Waiting for you" : p.status === "failed" && p.manual ? "Cancelled" : p.status === "processed" ? "Paid" : p.status;
                return (
                  <li key={p.id} className="surface-tile flex items-center justify-between gap-4 p-5">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-[16px] font-medium">
                        <span className="truncate">{vendorByPayee(p.payee_id)}</span>
                        {p.simulated && <Pill color="var(--entity-mandate)">Sandbox</Pill>}
                        {p.manual && <Pill color="var(--entity-agent)">By hand</Pill>}
                      </p>
                      <p className="mt-0.5 text-[13px]" style={{ color: "var(--muted-2)" }}>
                        <TimeAgo iso={p.created_at} />
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="num text-[17px] font-semibold">{rupees(Number(p.amount_paise))}</p>
                      <div className="mt-1.5">
                        <Pill color={p.status === "processed" ? "var(--decision-allow)" : p.status === "failed" || p.status === "reversed" ? "var(--decision-block)" : "var(--decision-escalate)"}>{label}</Pill>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title="Wallet" description="Everything that moved money in or out." icon={<Icons.Bell />} accent="var(--entity-customer)" bodyClassName="max-h-[560px] overflow-y-auto fade-mask-y">
        {coo.wallet.length === 0 ? (
          <EmptyState text="The wallet is empty." hint="Nothing has come in or gone out yet." />
        ) : (
          <ul className="divide-y" style={{ borderColor: "var(--hairline)" }}>
            {coo.wallet.map((w) => {
              const credit = w.direction === "credit";
              return (
                <li key={w.id} className="flex items-center gap-4 py-4">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full" style={{ background: `color-mix(in srgb, ${credit ? "var(--decision-allow)" : "var(--decision-escalate)"} 16%, transparent)`, color: credit ? "var(--decision-allow)" : "var(--decision-escalate)" }}>
                    {credit ? <ArrowDownLeft size={20} weight="bold" /> : <ArrowUpRight size={20} weight="bold" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-[15px]">
                      <span className="truncate">{w.note ?? w.kind}</span>
                      {w.simulated && <Pill color="var(--entity-mandate)">Sandbox</Pill>}
                    </p>
                    <p className="text-[13px]" style={{ color: "var(--muted-2)" }}>
                      <TimeAgo iso={w.created_at} />
                    </p>
                  </div>
                  <span className="num shrink-0 text-[17px] font-semibold" style={{ color: credit ? "var(--decision-allow)" : "var(--foreground)" }}>
                    {credit ? "+" : "-"}
                    {rupees(Number(w.amount_paise))}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
