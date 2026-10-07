"use client";

import { useState } from "react";
import type { CooData } from "@/lib/cooData";
import type { PurchaseOrder, PoStatus } from "@/types/db";
import { PRODUCT_CATEGORIES } from "@/lib/catalog";
import {
  addPayee,
  approvePayee,
  cancelPurchaseOrder,
  deleteVendor,
  markPurchaseOrderReceived,
  revokePayee,
  saveVendor,
  setVendorStatus,
} from "@/lib/actions/suppliers";
import { EmptyState, GhostButton, Icons, Panel, PrimaryButton, SuccessButton } from "./ui";
import { ErrorLine, Field, Pill, Table, inputClass, inputStyle, rupees, useRunner } from "./kit";
import { TimeAgo } from "./TimeAgo";

const PO_STATUS: Record<PoStatus, { label: string; color: string }> = {
  draft: { label: "Draft", color: "var(--muted)" },
  quoting: { label: "Getting quotes", color: "var(--entity-agent)" },
  awaiting_approval: { label: "Needs your approval", color: "var(--decision-escalate)" },
  approved: { label: "Approved", color: "var(--decision-approved)" },
  paid: { label: "Paid, awaiting goods", color: "var(--decision-allow)" },
  received: { label: "Received", color: "var(--decision-allow)" },
  cancelled: { label: "Cancelled", color: "var(--muted-2)" },
};

export function SuppliersTab({ coo }: { coo: CooData }) {
  const { error, pending, run, clear } = useRunner();
  const [adding, setAdding] = useState(false);
  const [payeeFor, setPayeeFor] = useState<string | null>(null);
  const [showQuotes, setShowQuotes] = useState(false);

  const candidates = coo.vendors.filter((v) => v.status === "candidate");
  const vendors = coo.vendors.filter((v) => v.status !== "candidate");
  const payeesByVendor = (id: string) => coo.payees.filter((p) => p.vendor_id === id && p.status !== "revoked");
  const vendorName = (id: string) => coo.vendors.find((v) => v.id === id)?.name ?? "Unknown supplier";
  const productName = (id: string | null) => coo.insights.find((i) => i.productId === id)?.name ?? "Unknown product";

  const [vf, setVf] = useState({ name: "", channel: "email" as "email" | "whatsapp", email: "", phone: "", website: "", category: "", notes: "" });
  const [pf, setPf] = useState({ name: "", kind: "bank" as "bank" | "upi", account: "", ifsc: "", vpa: "" });

  return (
    <div className="flex flex-col gap-5">
      <ErrorLine error={error} />

      {candidates.length > 0 && (
        <Panel title={`Suppliers to review (${candidates.length})`} icon={<Icons.Escalation />} accent="var(--decision-escalate)">
          <p className="mb-3 text-[12.5px]" style={{ color: "var(--muted)" }}>
            Your buying agent found these on the web. Nobody contacts or pays a supplier until you approve it. Check each one is real before you do.
          </p>
          <ul className="space-y-3">
            {candidates.map((v) => (
              <li key={v.id} className="rounded-xl p-3.5" style={{ background: "var(--panel-2)" }}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[13.5px] font-semibold">{v.name}</p>
                    <p className="mt-0.5 break-all text-[12px]" style={{ color: "var(--muted)" }}>
                      {[v.website, v.email, v.phone].filter(Boolean).join(" · ")}
                    </p>
                    {v.notes && (
                      <p className="mt-1 text-[11.5px]" style={{ color: "var(--muted-2)" }}>
                        {v.notes}
                      </p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <SuccessButton disabled={pending} className="px-4" onClick={() => run(() => setVendorStatus(v.id, "approved"))}>
                      Approve
                    </SuccessButton>
                    <GhostButton disabled={pending} className="px-4" onClick={() => run(() => setVendorStatus(v.id, "blocked"))}>
                      Reject
                    </GhostButton>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel
        title="Suppliers"
        icon={<Icons.Shield />}
        accent="var(--entity-agent)"
        action={
          <PrimaryButton className="px-3" onClick={() => { setAdding((v) => !v); clear(); }}>
            Add supplier
          </PrimaryButton>
        }
      >
        {adding && (
          <div className="mb-5 rounded-xl p-4" style={{ background: "var(--panel-2)" }}>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              <Field label="Name">
                <input className={inputClass} style={inputStyle} value={vf.name} onChange={(e) => setVf({ ...vf, name: e.target.value })} />
              </Field>
              <Field label="They reply on">
                <select className={inputClass} style={inputStyle} value={vf.channel} onChange={(e) => setVf({ ...vf, channel: e.target.value as "email" | "whatsapp" })}>
                  <option value="email" style={{ background: "#14141f" }}>Email</option>
                  <option value="whatsapp" style={{ background: "#14141f" }}>WhatsApp</option>
                </select>
              </Field>
              <Field label="Category they supply">
                <select className={inputClass} style={inputStyle} value={vf.category} onChange={(e) => setVf({ ...vf, category: e.target.value })}>
                  <option value="" style={{ background: "#14141f" }}>Anything</option>
                  {PRODUCT_CATEGORIES.map((c) => (
                    <option key={c} value={c} style={{ background: "#14141f" }}>{c}</option>
                  ))}
                </select>
              </Field>
              <Field label="Email">
                <input className={inputClass} style={inputStyle} value={vf.email} onChange={(e) => setVf({ ...vf, email: e.target.value })} />
              </Field>
              <Field label="Phone (with country code)">
                <input className={inputClass} style={inputStyle} value={vf.phone} onChange={(e) => setVf({ ...vf, phone: e.target.value })} />
              </Field>
              <Field label="Website">
                <input className={inputClass} style={inputStyle} value={vf.website} onChange={(e) => setVf({ ...vf, website: e.target.value })} />
              </Field>
            </div>
            <div className="mt-4 flex gap-2">
              <PrimaryButton
                disabled={pending}
                className="px-5"
                onClick={() =>
                  run(async () => {
                    await saveVendor(null, { name: vf.name, channel: vf.channel, email: vf.email, phone: vf.phone, website: vf.website, categories: vf.category ? [vf.category] : [], notes: vf.notes });
                    setAdding(false);
                    setVf({ name: "", channel: "email", email: "", phone: "", website: "", category: "", notes: "" });
                  })
                }
              >
                Save supplier
              </PrimaryButton>
              <GhostButton className="px-4" onClick={() => setAdding(false)}>Cancel</GhostButton>
            </div>
          </div>
        )}

        {vendors.length === 0 ? (
          <EmptyState text="No suppliers yet. Add one, or let the buying agent research some when something runs low." />
        ) : (
          <Table head={["Supplier", "Status", "Supplies", "Payment details", ""]}>
            {vendors.map((v) => {
              const payees = payeesByVendor(v.id);
              return (
                <tr key={v.id}>
                  <td className="px-2 py-2.5">
                    <div className="font-medium">
                      {v.name} {v.simulated && <Pill color="var(--entity-mandate)">sandbox</Pill>}
                    </div>
                    <div className="text-[10.5px]" style={{ color: "var(--muted-2)" }}>
                      {v.channel} · {v.email ?? v.phone ?? "no contact"}
                    </div>
                  </td>
                  <td className="px-2 py-2.5">
                    <Pill color={v.status === "approved" ? "var(--decision-allow)" : "var(--decision-block)"}>{v.status}</Pill>
                  </td>
                  <td className="px-2 py-2.5 text-[12px]" style={{ color: "var(--muted)" }}>
                    {(v.categories as string[]).join(", ") || "anything"}
                  </td>
                  <td className="px-2 py-2.5">
                    {payees.length === 0 ? (
                      <button className="text-[12px] underline-offset-2 hover:underline" style={{ color: "var(--brand-pink)" }} onClick={() => { setPayeeFor(v.id); clear(); }}>
                        Add payment details
                      </button>
                    ) : (
                      payees.map((p) => (
                        <div key={p.id} className="flex items-center gap-2 text-[12px]">
                          <span className="font-mono">{p.masked_identifier}</span>
                          <Pill color={p.status === "active" ? "var(--decision-allow)" : "var(--decision-escalate)"}>{p.status === "active" ? "approved" : "awaiting approval"}</Pill>
                          {p.status === "pending" && (
                            <button className="text-[11.5px] underline" style={{ color: "var(--decision-allow)" }} disabled={pending} onClick={() => run(() => approvePayee(p.id))}>
                              Approve
                            </button>
                          )}
                          <button className="text-[11.5px] underline" style={{ color: "var(--muted)" }} disabled={pending} onClick={() => run(() => revokePayee(p.id))}>
                            Remove
                          </button>
                        </div>
                      ))
                    )}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2.5 text-right text-[11.5px]">
                    {v.status === "approved" ? (
                      <button className="underline-offset-2 hover:underline" style={{ color: "var(--muted)" }} onClick={() => run(() => setVendorStatus(v.id, "blocked"))}>Block</button>
                    ) : (
                      <button className="underline-offset-2 hover:underline" onClick={() => run(() => setVendorStatus(v.id, "approved"))}>Unblock</button>
                    )}
                    <button className="ml-3 underline-offset-2 hover:underline" style={{ color: "var(--decision-block)" }} onClick={() => run(() => deleteVendor(v.id))}>Delete</button>
                  </td>
                </tr>
              );
            })}
          </Table>
        )}

        {payeeFor && (
          <div className="mt-5 rounded-xl p-4" style={{ background: "var(--panel-2)" }}>
            <p className="mb-1 text-[13px] font-semibold">Payment details for {vendorName(payeeFor)}</p>
            <p className="mb-3 text-[12px]" style={{ color: "var(--muted)" }}>
              {coo.settings.payout_mode === "manual"
                ? "You pay this supplier by hand, so these details are kept encrypted and shown only to you at the moment you make the payment. They are never shown to the agents."
                : coo.connections.some((c) => c.kind === "razorpayx" && c.status === "connected")
                  ? "These are sent straight to RazorpayX. Only the last digits are kept here, and your agents never see them."
                  : "RazorpayX isn't connected, so this will be a sandbox payee: it is stored the same way, but only the labelled sandbox executor will ever \"pay\" it."}{" "}
              After you add it, approve it yourself: that is the step that lets money flow.
            </p>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Field label="Account holder">
                <input className={inputClass} style={inputStyle} value={pf.name} onChange={(e) => setPf({ ...pf, name: e.target.value })} />
              </Field>
              <Field label="Type">
                <select className={inputClass} style={inputStyle} value={pf.kind} onChange={(e) => setPf({ ...pf, kind: e.target.value as "bank" | "upi" })}>
                  <option value="bank" style={{ background: "#14141f" }}>Bank account</option>
                  <option value="upi" style={{ background: "#14141f" }}>UPI</option>
                </select>
              </Field>
              {pf.kind === "bank" ? (
                <>
                  <Field label="Account number">
                    <input className={inputClass} style={inputStyle} inputMode="numeric" autoComplete="off" value={pf.account} onChange={(e) => setPf({ ...pf, account: e.target.value })} />
                  </Field>
                  <Field label="IFSC">
                    <input className={inputClass} style={inputStyle} autoComplete="off" value={pf.ifsc} onChange={(e) => setPf({ ...pf, ifsc: e.target.value.toUpperCase() })} />
                  </Field>
                </>
              ) : (
                <Field label="UPI id">
                  <input className={inputClass} style={inputStyle} autoComplete="off" value={pf.vpa} onChange={(e) => setPf({ ...pf, vpa: e.target.value })} />
                </Field>
              )}
            </div>
            <div className="mt-4 flex gap-2">
              <PrimaryButton
                disabled={pending}
                className="px-5"
                onClick={() =>
                  run(async () => {
                    await addPayee({
                      vendorId: payeeFor,
                      displayName: pf.name,
                      details: pf.kind === "bank" ? { kind: "bank", accountNumber: pf.account.trim(), ifsc: pf.ifsc.trim() } : { kind: "upi", vpa: pf.vpa.trim() },
                    });
                    setPayeeFor(null);
                    setPf({ name: "", kind: "bank", account: "", ifsc: "", vpa: "" });
                  })
                }
              >
                {pending ? "Saving…" : "Add"}
              </PrimaryButton>
              <GhostButton className="px-4" onClick={() => setPayeeFor(null)}>Cancel</GhostButton>
            </div>
          </div>
        )}
      </Panel>

      <Panel title="Purchase orders" icon={<Icons.CheckCircle />} accent="var(--decision-allow)">
        {coo.purchaseOrders.length === 0 ? (
          <EmptyState text="No orders yet. When a bestseller runs low, the buying agent gets quotes and drafts one here." />
        ) : (
          <Table head={["Order", "Supplier", "Total", "Advance", "Status", ""]}>
            {coo.purchaseOrders.map((po: PurchaseOrder) => {
              const lines = coo.poLines.filter((l) => l.po_id === po.id);
              const st = PO_STATUS[po.status];
              return (
                <tr key={po.id}>
                  <td className="px-2 py-2.5">
                    <div className="font-medium">{lines.map((l) => `${l.qty} x ${productName(l.product_id)}`).join(", ") || "No lines"}</div>
                    <div className="max-w-md text-[10.5px] leading-snug" style={{ color: "var(--muted-2)" }}>
                      {(po.rationale ?? "").replace("[needs_payee]", "").trim()} · <TimeAgo iso={po.created_at} />
                    </div>
                  </td>
                  <td className="px-2 py-2.5">{vendorName(po.vendor_id)}</td>
                  <td className="px-2 py-2.5 tabular-nums">{rupees(Number(po.total_paise))}</td>
                  <td className="px-2 py-2.5 tabular-nums">{rupees(Number(po.advance_paise))}</td>
                  <td className="px-2 py-2.5">
                    <Pill color={st.color}>{st.label}</Pill>
                    {po.rationale?.includes("[needs_payee]") && (
                      <div className="mt-1 text-[10.5px]" style={{ color: "var(--decision-escalate)" }}>
                        needs payment details
                      </div>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2.5 text-right text-[11.5px]">
                    {(po.status === "paid" || po.status === "approved") && (
                      <button className="underline-offset-2 hover:underline" style={{ color: "var(--decision-allow)" }} disabled={pending} onClick={() => run(() => markPurchaseOrderReceived(po.id))}>
                        Mark received
                      </button>
                    )}
                    {(po.status === "draft" || po.status === "quoting" || po.status === "awaiting_approval") && (
                      <button className="underline-offset-2 hover:underline" style={{ color: "var(--muted)" }} disabled={pending} onClick={() => run(() => cancelPurchaseOrder(po.id))}>
                        Cancel
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
      </Panel>

      <Panel
        title="Quotes"
        icon={<Icons.Sparkles />}
        accent="var(--entity-mandate)"
        action={
          <GhostButton className="px-3" onClick={() => setShowQuotes((v) => !v)}>
            {showQuotes ? "Hide" : `Show ${coo.quotes.length}`}
          </GhostButton>
        }
      >
        {!showQuotes ? (
          <p className="text-[12.5px]" style={{ color: "var(--muted)" }}>
            Every price a supplier has quoted, including the ones the agent rejected for losing money.
          </p>
        ) : coo.quotes.length === 0 ? (
          <EmptyState text="No quotes yet." />
        ) : (
          <Table head={["Product", "Supplier", "Per unit", "Min order", "Lead", "Status", "When"]}>
            {coo.quotes.map((q) => (
              <tr key={q.id}>
                <td className="px-2 py-2">{productName(q.product_id)}</td>
                <td className="px-2 py-2">{vendorName(q.vendor_id)}</td>
                <td className="px-2 py-2 tabular-nums">{rupees(q.unit_price_paise)}</td>
                <td className="px-2 py-2 tabular-nums">{q.moq}</td>
                <td className="px-2 py-2 tabular-nums">{q.lead_time_days === null ? "—" : `${q.lead_time_days}d`}</td>
                <td className="px-2 py-2">
                  <Pill color={q.status === "accepted" ? "var(--decision-allow)" : q.status === "rejected" ? "var(--decision-block)" : "var(--muted)"}>{q.status}</Pill>
                </td>
                <td className="px-2 py-2 text-[11px]" style={{ color: "var(--muted-2)" }}>
                  <TimeAgo iso={q.created_at} />
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </div>
  );
}

