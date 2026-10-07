"use client";

import type { CooData } from "@/lib/cooData";
import type { Trace } from "@/types/db";
import { settleSandboxPayment } from "@/lib/actions/team";
import { EmptyState, Icons, Panel, SuccessButton } from "./ui";
import { ErrorLine, Pill, Table, rupees, useRunner } from "./kit";
import { TimeAgo } from "./TimeAgo";

/**
 * Money in and out: sales, payouts and the wallet that results.
 *
 * Also home to the sandbox's "customer pays" button. A sandbox payment link goes
 * nowhere real, so something has to stand in for the buyer paying it; this is
 * that, and it only ever accepts a link the sandbox itself created.
 */
export function SalesTab({ coo, traces }: { coo: CooData; traces: Trace[] }) {
  const { error, pending, run } = useRunner();
  const productName = (id: string | null) => coo.insights.find((i) => i.productId === id)?.name ?? "—";
  const vendorByPayee = (payeeId: string | null) => {
    const p = coo.payees.find((x) => x.id === payeeId);
    return p?.display_name ?? "—";
  };

  const settled = new Set(coo.sales.map((s) => s.razorpay_payment_id));
  const awaiting = traces.filter((t) => {
    if (t.action_type !== "payment_link.create" && t.action_type !== "order.create") return false;
    if (t.decision !== "allow" || t.mode !== "enforce") return false;
    const r = t.razorpay_response as { simulated?: boolean; id?: string } | null;
    if (!r?.simulated || !r.id) return false;
    return !settled.has(`sim_pay_${r.id.replace(/^sim_(plink|order)_/, "")}`);
  });

  return (
    <div className="flex flex-col gap-5">
      <ErrorLine error={error} />

      {awaiting.length > 0 && (
        <Panel title="Sandbox payment links waiting for a buyer" icon={<Icons.Sparkles />} accent="var(--entity-mandate)">
          <p className="mb-3 text-[12.5px]" style={{ color: "var(--muted)" }}>
            These links are sandbox ones, so no real buyer can pay them. Press the button to play the buyer paying: the sale, stock and wallet update as they would for a real payment.
          </p>
          <ul className="space-y-2">
            {awaiting.slice(0, 8).map((t) => {
              const p = t.params as { amount?: number; lineItems?: { sku: string; qty: number }[]; customerName?: string };
              const what = (p.lineItems ?? []).map((i) => `${i.qty} x ${coo.insights.find((x) => x.sku === i.sku)?.name ?? i.sku}`).join(", ");
              return (
                <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl p-3" style={{ background: "var(--panel-2)" }}>
                  <div className="text-[12.5px]">
                    <span className="font-medium">{rupees(p.amount)}</span> · {what || "a sale"} {p.customerName && <span style={{ color: "var(--muted)" }}>for {p.customerName}</span>}
                  </div>
                  <SuccessButton disabled={pending} className="px-4" onClick={() => run(() => settleSandboxPayment(t.id))}>
                    Buyer pays
                  </SuccessButton>
                </li>
              );
            })}
          </ul>
        </Panel>
      )}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Panel title="Sales" icon={<Icons.CheckCircle />} accent="var(--decision-allow)" bodyClassName="max-h-[480px] overflow-y-auto">
          {coo.sales.length === 0 ? (
            <EmptyState text="No sales yet." />
          ) : (
            <Table head={["Product", "Qty", "Amount", "When"]}>
              {coo.sales.slice(0, 40).map((s) => (
                <tr key={s.id}>
                  <td className="px-2 py-2">
                    {productName(s.product_id)} {(s.razorpay_payment_id ?? "").startsWith("sample_") && <Pill color="var(--entity-mandate)">sample</Pill>}
                    {(s.razorpay_payment_id ?? "").startsWith("sim_pay_") && <Pill color="var(--entity-mandate)">sandbox</Pill>}
                  </td>
                  <td className="px-2 py-2 tabular-nums">{s.qty}</td>
                  <td className="px-2 py-2 tabular-nums">{rupees(Number(s.amount_paise))}</td>
                  <td className="px-2 py-2 text-[11px]" style={{ color: "var(--muted-2)" }}>
                    <TimeAgo iso={s.captured_at} />
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>

        <Panel title="Paid to suppliers" icon={<Icons.Shield />} accent="var(--entity-agent)" bodyClassName="max-h-[480px] overflow-y-auto">
          {coo.payouts.length === 0 ? (
            <EmptyState text="No payouts yet." />
          ) : (
            <Table head={["Supplier", "Amount", "Status", "When"]}>
              {coo.payouts.map((p) => (
                <tr key={p.id}>
                  <td className="px-2 py-2">
                    {vendorByPayee(p.payee_id)} {p.simulated && <Pill color="var(--entity-mandate)">sandbox</Pill>}
                  </td>
                  <td className="px-2 py-2 tabular-nums">{rupees(Number(p.amount_paise))}</td>
                  <td className="px-2 py-2">
                    <Pill color={p.status === "processed" ? "var(--decision-allow)" : p.status === "failed" || p.status === "reversed" ? "var(--decision-block)" : "var(--muted)"}>{p.status}</Pill>
                  </td>
                  <td className="px-2 py-2 text-[11px]" style={{ color: "var(--muted-2)" }}>
                    <TimeAgo iso={p.created_at} />
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>
      </div>

      <Panel title="Wallet" icon={<Icons.Bell />} accent="var(--entity-customer)" bodyClassName="max-h-[420px] overflow-y-auto">
        {coo.wallet.length === 0 ? (
          <EmptyState text="The wallet is empty: nothing has come in or gone out yet." />
        ) : (
          <Table head={["", "Amount", "What", "When"]}>
            {coo.wallet.map((w) => (
              <tr key={w.id}>
                <td className="px-2 py-2">
                  <Pill color={w.direction === "credit" ? "var(--decision-allow)" : "var(--decision-escalate)"}>{w.direction === "credit" ? "in" : "out"}</Pill>
                </td>
                <td className="px-2 py-2 tabular-nums">{rupees(Number(w.amount_paise))}</td>
                <td className="px-2 py-2 text-[12px]" style={{ color: "var(--muted)" }}>
                  {w.note ?? w.kind} {w.simulated && <Pill color="var(--entity-mandate)">sandbox</Pill>}
                </td>
                <td className="px-2 py-2 text-[11px]" style={{ color: "var(--muted-2)" }}>
                  <TimeAgo iso={w.created_at} />
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </div>
  );
}
