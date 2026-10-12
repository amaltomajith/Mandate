"use client";

import { useState } from "react";
import { CaretDown, Check, Plus, WarningCircle } from "@phosphor-icons/react";
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
  setFestivalBuffer,
  saveVendor,
  setVendorStatus,
} from "@/lib/actions/suppliers";
import { EmptyState, GhostButton, Icons, Panel, PrimaryButton, SuccessButton } from "./ui";
import { ErrorLine, Field, Pill, Table, inputClass, inputStyle, rupees, useRunner } from "./kit";
import { Drawer, Reveal } from "./motion";
import { TimeAgo } from "./TimeAgo";

const PO_STATUS: Record<PoStatus, { label: string; color: string }> = {
  draft: { label: "Draft", color: "var(--muted)" },
  quoting: { label: "Getting quotes", color: "var(--entity-agent)" },
  awaiting_approval: { label: "Needs your approval", color: "var(--decision-escalate)" },
  approved: { label: "Approved, not paid", color: "var(--decision-approved)" },
  paid: { label: "Paid, awaiting goods", color: "var(--decision-allow)" },
  received: { label: "Received", color: "var(--decision-allow)" },
  cancelled: { label: "Cancelled", color: "var(--muted-2)" },
};

const STEPS = ["Quote", "Approve", "Pay", "Receive"];
/** How many of the four steps are done. */
function stepsDone(s: PoStatus): number {
  switch (s) {
    case "draft":
    case "quoting":
      return 0;
    case "awaiting_approval":
      return 1;
    case "approved":
      return 2;
    case "paid":
      return 3;
    case "received":
      return 4;
    default:
      return 0;
  }
}

export function SuppliersTab({ coo }: { coo: CooData }) {
  const { error, pending, run, clear } = useRunner();
  const [adding, setAdding] = useState(false);
  const [payeeFor, setPayeeFor] = useState<string | null>(null);
  const [showQuotes, setShowQuotes] = useState(false);
  const [receiving, setReceiving] = useState<string | null>(null);
  const [rf, setRf] = useState<Record<string, { qty: string; price: string }>>({});
  const [rnote, setRnote] = useState("");
  const receivingLines = receiving ? coo.poLines.filter((l) => l.po_id === receiving) : [];
  const startReceiving = (poId: string) => {
    clear();
    setRnote("");
    setRf(Object.fromEntries(coo.poLines.filter((l) => l.po_id === poId).map((l) => [l.product_id, { qty: String(l.qty), price: "" }])));
    setReceiving(poId);
  };

  const candidates = coo.vendors.filter((v) => v.status === "candidate");
  const vendors = coo.vendors.filter((v) => v.status !== "candidate");
  const payeesByVendor = (id: string) => coo.payees.filter((p) => p.vendor_id === id && p.status !== "revoked");
  const vendorName = (id: string) => coo.vendors.find((v) => v.id === id)?.name ?? "Unknown supplier";
  const productName = (id: string | null) => coo.insights.find((i) => i.productId === id)?.name ?? "Unknown product";

  const [vf, setVf] = useState({ name: "", channel: "email" as "email" | "whatsapp", email: "", phone: "", website: "", category: "", notes: "", gstin: "" });
  const [pf, setPf] = useState({ name: "", kind: "bank" as "bank" | "upi", account: "", ifsc: "", vpa: "" });

  return (
    <div className="flex flex-col gap-8">
      <ErrorLine error={error} />

      {candidates.length > 0 && (
        <Reveal>
          <Panel
            title="Suppliers to review"
            description="Your buying agent found these on the web. Nobody contacts or pays a supplier until you approve it."
            icon={<Icons.Escalation />}
            accent="var(--decision-escalate)"
            count={candidates.length}
          >
            <ul className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {candidates.map((v) => (
                <li key={v.id} className="surface-tile flex flex-col justify-between gap-5 p-6">
                  <div className="min-w-0">
                    <p className="text-[17px] font-semibold tracking-[-0.01em]">{v.name}</p>
                    <p className="mt-1.5 break-all text-[14px] leading-6" style={{ color: "var(--muted)" }}>
                      {[v.website, v.email, v.phone].filter(Boolean).join("  ") || "No contact found"}
                    </p>
                    {v.notes && (
                      <p className="mt-2 text-[14px] leading-6" style={{ color: "var(--muted-2)" }}>
                        {v.notes}
                      </p>
                    )}
                  </div>
                  <div className="flex gap-3">
                    <SuccessButton disabled={pending} className="flex-1" onClick={() => run(() => setVendorStatus(v.id, "approved"))}>
                      Approve
                    </SuccessButton>
                    <GhostButton disabled={pending} className="flex-1" onClick={() => run(() => setVendorStatus(v.id, "blocked"))}>
                      Reject
                    </GhostButton>
                  </div>
                </li>
              ))}
            </ul>
          </Panel>
        </Reveal>
      )}

      <Panel
        title="Your suppliers"
        description="Who the team may contact, and how they get paid."
        icon={<Icons.Shield />}
        accent="var(--entity-agent)"
        action={
          <PrimaryButton onClick={() => { setAdding(true); clear(); }}>
            <Plus size={18} weight="bold" /> Add supplier
          </PrimaryButton>
        }
      >
        {vendors.length === 0 ? (
          <EmptyState text="No suppliers yet." hint="Add one, or let the buying agent research some when something runs low." />
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {vendors.map((v, idx) => {
              const payees = payeesByVendor(v.id);
              return (
                <Reveal key={v.id} index={idx}>
                  <div className="surface-tile surface-interactive h-full p-6">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-2 text-[17px] font-semibold tracking-[-0.01em]">
                          {v.name}
                          {v.simulated && <Pill color="var(--entity-mandate)">Sandbox</Pill>}
                        </p>
                        <p className="mt-1 truncate text-[14px]" style={{ color: "var(--muted)" }}>
                          {v.channel === "whatsapp" ? "WhatsApp" : "Email"}, {v.email ?? v.phone ?? "no contact"}
                        </p>
                      </div>
                      <Pill color={v.status === "approved" ? "var(--decision-allow)" : "var(--decision-block)"}>{v.status === "approved" ? "Approved" : "Blocked"}</Pill>
                    </div>
                    <p className="mt-3 text-[14px]" style={{ color: "var(--muted-2)" }}>
                      Supplies {(v.categories as string[]).join(", ") || "anything"}
                    </p>

                    <div className="mt-5 border-t pt-5" style={{ borderColor: "var(--hairline)" }}>
                      <p className="mb-3 text-[13px] font-medium" style={{ color: "var(--muted)" }}>
                        Payment details
                      </p>
                      {payees.length === 0 ? (
                        <button className="focus-ring text-[14px] font-medium underline underline-offset-4" style={{ color: "var(--brand-pink)" }} onClick={() => { setPayeeFor(v.id); clear(); }}>
                          Add payment details
                        </button>
                      ) : (
                        <div className="space-y-3">
                          {payees.map((p) => (
                            <div key={p.id} className="flex flex-wrap items-center gap-3">
                              <span className="num text-[15px]">{p.masked_identifier}</span>
                              <Pill color={p.status === "active" ? "var(--decision-allow)" : "var(--decision-escalate)"}>{p.status === "active" ? "Approved" : "Awaiting approval"}</Pill>
                              <span className="ml-auto flex gap-4 text-[14px]">
                                {p.status === "pending" && (
                                  <button className="focus-ring font-medium underline underline-offset-4" style={{ color: "var(--decision-allow)" }} disabled={pending} onClick={() => run(() => approvePayee(p.id))}>
                                    Approve
                                  </button>
                                )}
                                <button className="focus-ring underline underline-offset-4" style={{ color: "var(--muted)" }} disabled={pending} onClick={() => run(() => revokePayee(p.id))}>
                                  Remove
                                </button>
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="mt-5 flex gap-5 text-[14px]">
                      {v.status === "approved" ? (
                        <button className="focus-ring underline underline-offset-4" style={{ color: "var(--muted)" }} onClick={() => run(() => setVendorStatus(v.id, "blocked"))}>
                          Block
                        </button>
                      ) : (
                        <button className="focus-ring underline underline-offset-4" onClick={() => run(() => setVendorStatus(v.id, "approved"))}>
                          Unblock
                        </button>
                      )}
                      <button className="focus-ring underline underline-offset-4" style={{ color: "var(--decision-block)" }} onClick={() => run(() => deleteVendor(v.id))}>
                        Delete
                      </button>
                    </div>
                  </div>
                </Reveal>
              );
            })}
          </div>
        )}
      </Panel>

      <Panel title="Purchase orders" description="What is on order, and how far along it is." icon={<Icons.CheckCircle />} accent="var(--decision-allow)">
        {coo.purchaseOrders.length === 0 ? (
          <EmptyState text="No orders yet." hint="When a bestseller runs low, the buying agent gets quotes and drafts one here." />
        ) : (
          <ul className="space-y-4">
            {coo.purchaseOrders.map((po: PurchaseOrder) => {
              const lines = coo.poLines.filter((l) => l.po_id === po.id);
              const st = PO_STATUS[po.status];
              const done = stepsDone(po.status);
              const cancelled = po.status === "cancelled";
              return (
                <li key={po.id} className="surface-tile p-6" style={{ opacity: cancelled ? 0.55 : 1 }}>
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-[17px] font-semibold tracking-[-0.01em]">{lines.map((l) => `${l.qty} x ${productName(l.product_id)}`).join(", ") || "No lines"}</p>
                      <p className="mt-1 text-[14px]" style={{ color: "var(--muted)" }}>
                        {vendorName(po.vendor_id)}, <TimeAgo iso={po.created_at} />
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="num text-[24px] font-semibold leading-[30px]">{rupees(Number(po.total_paise))}</p>
                      <p className="num text-[13px]" style={{ color: "var(--muted)" }}>
                        {rupees(Number(po.advance_paise))} advance
                      </p>
                    </div>
                  </div>

                  {!cancelled && (
                    <ol className="mt-6 grid grid-cols-4 gap-2" aria-label="Progress">
                      {STEPS.map((s, i) => (
                        <li key={s}>
                          <div className="h-1.5 rounded-full" style={{ background: i < done ? "var(--brand-violet)" : "rgba(255,255,255,0.08)", transition: "background 0.5s var(--ease-out)" }} />
                          <p className="mt-2 flex items-center gap-1.5 text-[13px]" style={{ color: i < done ? "var(--foreground)" : "var(--muted-2)" }}>
                            {i < done && <Check size={14} weight="bold" style={{ color: "var(--brand-pink)" }} />}
                            {s}
                          </p>
                        </li>
                      ))}
                    </ol>
                  )}

                  <div className="mt-5 flex flex-wrap items-center gap-3">
                    <Pill color={st.color}>{st.label}</Pill>
                    {po.rationale?.includes("[needs_payee]") && (
                      <span className="flex items-center gap-1.5 text-[14px]" style={{ color: "var(--decision-escalate)" }}>
                        <WarningCircle size={18} /> Needs payment details
                      </span>
                    )}
                    <span className="ml-auto flex gap-3">
                      {(po.status === "paid" || po.status === "approved") && (
                        <SuccessButton disabled={pending} onClick={() => startReceiving(po.id)}>
                          Mark received
                        </SuccessButton>
                      )}
                      {(po.status === "draft" || po.status === "quoting" || po.status === "awaiting_approval") && (
                        <GhostButton disabled={pending} onClick={() => run(() => cancelPurchaseOrder(po.id))}>
                          Cancel order
                        </GhostButton>
                      )}
                    </span>
                  </div>
                  {(po.rationale ?? "").replace("[needs_payee]", "").trim() && (
                    <p className="mt-4 rounded-[12px] bg-white/[0.04] px-4 py-3 text-[14px] leading-6" style={{ color: "var(--muted)" }}>
                      {(po.rationale ?? "").replace("[needs_payee]", "").trim()}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <section className="surface overflow-hidden">
        <button type="button" onClick={() => setShowQuotes((v) => !v)} aria-expanded={showQuotes} className="focus-ring flex w-full items-center justify-between gap-4 px-7 py-6 text-left">
          <span>
            <span className="flex items-center gap-3 text-[17px] font-semibold tracking-[-0.01em]">
              Quotes
              <span className="num rounded-full bg-white/10 px-2.5 py-0.5 text-[13px] font-medium">{coo.quotes.length}</span>
            </span>
            <span className="mt-0.5 block text-[14px]" style={{ color: "var(--muted)" }}>
              Every price a supplier has quoted, including the ones the agent rejected for losing money.
            </span>
          </span>
          <CaretDown size={18} style={{ color: "var(--muted)", transform: showQuotes ? "rotate(180deg)" : "none", transition: "transform 0.3s var(--ease-out)" }} />
        </button>
        {showQuotes && (
          <div className="border-t px-5 pb-5 pt-2" style={{ borderColor: "var(--hairline)" }}>
            {coo.quotes.length === 0 ? (
              <div className="p-4">
                <EmptyState text="No quotes yet." />
              </div>
            ) : (
              <Table head={["Product", "Supplier", "Per unit", "Min order", "Lead", "Status", "When"]}>
                {coo.quotes.map((q) => (
                  <tr key={q.id}>
                    <td>{productName(q.product_id)}</td>
                    <td>{vendorName(q.vendor_id)}</td>
                    <td className="num">{rupees(q.unit_price_paise)}</td>
                    <td className="num">{q.moq}</td>
                    <td className="num">{q.lead_time_days === null ? "-" : `${q.lead_time_days}d`}</td>
                    <td>
                      <Pill color={q.status === "accepted" ? "var(--decision-allow)" : q.status === "rejected" ? "var(--decision-block)" : "var(--muted)"}>{q.status}</Pill>
                    </td>
                    <td className="text-[13px]" style={{ color: "var(--muted-2)" }}>
                      <TimeAgo iso={q.created_at} />
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </div>
        )}
      </section>

      <Panel
        title="How suppliers have delivered"
        description="Built from the deliveries you record. A supplier who is short or late loses ties to one who is not."
        icon={<Icons.CheckCircle />}
        accent="var(--entity-agent)"
        action={
          <GhostButton disabled={pending} onClick={() => run(() => setFestivalBuffer(!coo.settings.festival_buffer))}>
            {coo.settings.festival_buffer ? "Festival buffer: on" : "Festival buffer: off"}
          </GhostButton>
        }
      >
        {coo.festivalNote && (
          <p className="mb-4 rounded-[12px] bg-white/[0.04] px-4 py-3 text-[14px] leading-6" style={{ color: "var(--muted)" }}>
            {coo.festivalNote}. Lead times are being lengthened, so restocks are asked for earlier.
          </p>
        )}
        {coo.scorecards.length === 0 ? (
          <EmptyState text="No deliveries recorded yet." hint="Mark an order received and the supplier's record starts here." />
        ) : (
          <Table head={["Supplier", "Orders", "On time", "Arrived", "Price vs agreed", "Score"]}>
            {coo.scorecards.map((c) => (
              <tr key={c.vendorId}>
                <td className="text-[15px] font-medium">{c.name}</td>
                <td className="num">{c.orders}</td>
                <td className="num">{c.onTimePct}%</td>
                <td className="num">{c.fillPct}%</td>
                <td className="num" style={{ color: c.avgDriftBps > 200 ? "var(--decision-block)" : undefined }}>
                  {c.avgDriftBps === 0 ? "as agreed" : `${c.avgDriftBps > 0 ? "+" : ""}${(c.avgDriftBps / 100).toFixed(1)}%`}
                </td>
                <td>
                  <Pill color={c.reliability >= 70 ? "var(--decision-allow)" : c.reliability >= 45 ? "var(--decision-escalate)" : "var(--decision-block)"}>{c.reliability}</Pill>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>

      <Drawer
        open={receiving !== null}
        onClose={() => setReceiving(null)}
        title="Record the delivery"
        description="Type what actually arrived. Only that is added to your stock."
        footer={
          <div className="flex gap-3">
            <SuccessButton
              disabled={pending}
              onClick={() =>
                run(async () => {
                  if (!receiving) return;
                  await markPurchaseOrderReceived({
                    poId: receiving,
                    lines: receivingLines.map((l) => {
                      const row = rf[l.product_id] ?? { qty: String(l.qty), price: "" };
                      const price = Math.round(parseFloat(row.price) * 100);
                      return { productId: l.product_id, receivedQty: Math.max(0, Math.floor(Number(row.qty) || 0)), ...(Number.isFinite(price) && price > 0 ? { unitPricePaise: price } : {}) };
                    }),
                    note: rnote || undefined,
                  });
                  setReceiving(null);
                })
              }
            >
              {pending ? "Saving…" : "Add to stock"}
            </SuccessButton>
            <GhostButton onClick={() => setReceiving(null)}>Cancel</GhostButton>
          </div>
        }
      >
        <ErrorLine error={error} />
        <div className="space-y-5">
          {receivingLines.map((l) => (
            <div key={l.id} className="surface-tile p-5">
              <p className="text-[15px] font-medium">{productName(l.product_id)}</p>
              <p className="mb-3 text-[13px]" style={{ color: "var(--muted-2)" }}>
                Ordered {l.qty} at {rupees(Number(l.unit_price_paise))}
              </p>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Arrived">
                  <input className={inputClass} style={inputStyle} inputMode="numeric" value={rf[l.product_id]?.qty ?? ""} onChange={(e) => setRf({ ...rf, [l.product_id]: { qty: e.target.value.replace(/[^0-9]/g, ""), price: rf[l.product_id]?.price ?? "" } })} />
                </Field>
                <Field label="Invoice price each" hint="Only if it differs">
                  <input className={inputClass} style={inputStyle} inputMode="decimal" placeholder={String(Number(l.unit_price_paise) / 100)} value={rf[l.product_id]?.price ?? ""} onChange={(e) => setRf({ ...rf, [l.product_id]: { qty: rf[l.product_id]?.qty ?? "", price: e.target.value } })} />
                </Field>
              </div>
            </div>
          ))}
          <Field label="Note" hint="Optional, e.g. two boxes were damaged">
            <input className={inputClass} style={inputStyle} maxLength={500} value={rnote} onChange={(e) => setRnote(e.target.value)} />
          </Field>
        </div>
      </Drawer>

      <Drawer
        open={adding}
        onClose={() => setAdding(false)}
        title="Add a supplier"
        description="They are contacted only after you approve them."
        footer={
          <div className="flex gap-3">
            <PrimaryButton
              disabled={pending}
              onClick={() =>
                run(async () => {
                  await saveVendor(null, { name: vf.name, channel: vf.channel, email: vf.email, phone: vf.phone, website: vf.website, categories: vf.category ? [vf.category] : [], notes: vf.notes, gstin: vf.gstin });
                  setAdding(false);
                  setVf({ name: "", channel: "email", email: "", phone: "", website: "", category: "", notes: "", gstin: "" });
                })
              }
            >
              {pending ? "Saving…" : "Save supplier"}
            </PrimaryButton>
            <GhostButton onClick={() => setAdding(false)}>Cancel</GhostButton>
          </div>
        }
      >
        <ErrorLine error={error} />
        <div className="grid gap-5 pb-4">
          <Field label="Name">
            <input className={inputClass} style={inputStyle} value={vf.name} onChange={(e) => setVf({ ...vf, name: e.target.value })} />
          </Field>
          <div className="grid grid-cols-2 gap-5">
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
          </div>
          <Field label="Email">
            <input className={inputClass} style={inputStyle} value={vf.email} onChange={(e) => setVf({ ...vf, email: e.target.value })} />
          </Field>
          <Field label="Phone (with country code)">
            <input className={inputClass} style={inputStyle} value={vf.phone} onChange={(e) => setVf({ ...vf, phone: e.target.value })} />
          </Field>
          <Field label="Website">
            <input className={inputClass} style={inputStyle} value={vf.website} onChange={(e) => setVf({ ...vf, website: e.target.value })} />
          </Field>
          <Field label="GSTIN" hint="For your purchase register. Optional">
            <input className={inputClass} style={inputStyle} maxLength={15} value={vf.gstin} onChange={(e) => setVf({ ...vf, gstin: e.target.value.toUpperCase() })} />
          </Field>
        </div>
      </Drawer>

      <Drawer
        open={payeeFor !== null}
        onClose={() => setPayeeFor(null)}
        title={payeeFor ? `Pay ${vendorName(payeeFor)}` : "Payment details"}
        description="After you add it, approve it yourself: that is the step that lets money flow."
        footer={
          <div className="flex gap-3">
            <PrimaryButton
              disabled={pending}
              onClick={() =>
                run(async () => {
                  if (!payeeFor) return;
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
            <GhostButton onClick={() => setPayeeFor(null)}>Cancel</GhostButton>
          </div>
        }
      >
        <ErrorLine error={error} />
        <p className="mb-6 rounded-[12px] bg-white/[0.04] px-4 py-3 text-[14px] leading-6" style={{ color: "var(--muted)" }}>
          {coo.settings.payout_mode === "manual"
            ? "You pay this supplier by hand, so these details are kept encrypted and shown only to you at the moment you make the payment. They are never shown to the agents."
            : coo.connections.some((c) => c.kind === "razorpayx" && c.status === "connected")
              ? "These are sent straight to RazorpayX. Only the last digits are kept here, and your agents never see them."
              : "RazorpayX isn't connected, so this will be a sandbox payee: it is stored the same way, but only the labelled sandbox executor will ever \"pay\" it."}
        </p>
        <div className="grid gap-5 pb-4">
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
      </Drawer>
    </div>
  );
}
