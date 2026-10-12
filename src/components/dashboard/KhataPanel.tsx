"use client";

import { useState } from "react";
import type { CooData } from "@/lib/cooData";
import { receiveCreditPayment, saveCreditCustomer, sellOnCreditAction, setCreditCap, writeOffCredit } from "@/lib/actions/credit";
import { EmptyState, GhostButton, Icons, Panel, PrimaryButton, SuccessButton } from "./ui";
import { ErrorLine, Field, Pill, Table, inputClass, inputStyle, rupees, useRunner } from "./kit";
import { ConfirmSheet, Drawer } from "./motion";

type Mode = { kind: "customer"; id?: string } | { kind: "sell"; id: string } | { kind: "receive"; id: string } | null;

/** A due date, the same on the server and in the browser. */
const dueDate = (iso: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" }).format(new Date(iso));

/** One id per open form, so a double click or a retry books once. */
const newRef = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Math.random()).slice(2));

/**
 * Khata: customers who buy on credit. Credit is extended here, by a person, within a
 * limit per customer and an overall cap that the database enforces. The team only
 * reminds; it cannot lend. A credit sale is not money until it is paid.
 */
export function KhataPanel({ coo }: { coo: CooData }) {
  const { error, pending, run, clear } = useRunner();
  const [mode, setMode] = useState<Mode>(null);
  const [ref, setRef] = useState(newRef);
  const [writeOffId, setWriteOffId] = useState<string | null>(null);
  const [cf, setCf] = useState({ name: "", phone: "", limit: "5000", terms: "15" });
  const [sf, setSf] = useState({ sku: "", qty: "1" });
  const [pf, setPf] = useState({ amount: "" });
  const [cap, setCap] = useState(String(Math.round(Number(coo.settings.credit_exposure_cap_paise) / 100)));

  const owed = coo.receivables.reduce((n, r) => n + r.owedPaise, 0);
  const overdue = coo.receivables.reduce((n, r) => n + r.overduePaise, 0);
  const capPaise = Number(coo.settings.credit_exposure_cap_paise);
  const who = (id: string) => coo.receivables.find((r) => r.customerId === id) ?? null;
  const customer = (id: string) => coo.creditCustomers.find((c) => c.id === id);
  const sellable = coo.insights.filter((i) => i.active && i.stockQty > 0);

  const open = (m: Mode) => {
    clear();
    setRef(newRef());
    setMode(m);
  };
  const close = () => setMode(null);
  const editing = mode?.kind === "customer" && mode.id ? customer(mode.id) : undefined;

  return (
    <Panel
      title="Customer credit"
      description="Regulars who buy now and pay later. You decide who and how much; the team only reminds."
      icon={<Icons.Shield />}
      accent="var(--entity-customer)"
      action={
        <PrimaryButton
          disabled={pending}
          onClick={() => {
            setCf({ name: "", phone: "", limit: "5000", terms: "15" });
            open({ kind: "customer" });
          }}
        >
          Add customer
        </PrimaryButton>
      }
    >
      <ErrorLine error={mode ? null : error} />
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="surface-tile p-5">
          <p className="text-[13px]" style={{ color: "var(--muted)" }}>Owed to you</p>
          <p className="num mt-1 text-[26px] font-semibold">{rupees(owed)}</p>
        </div>
        <div className="surface-tile p-5">
          <p className="text-[13px]" style={{ color: "var(--muted)" }}>Past due</p>
          <p className="num mt-1 text-[26px] font-semibold" style={{ color: overdue > 0 ? "var(--decision-block)" : undefined }}>{rupees(overdue)}</p>
        </div>
        <div className="surface-tile p-5">
          <p className="text-[13px]" style={{ color: "var(--muted)" }}>Most you will have out at once</p>
          <div className="mt-1 flex items-center gap-2">
            <span className="num text-[18px]" style={{ color: "var(--muted)" }}>₹</span>
            <input
              className={inputClass}
              style={inputStyle}
              inputMode="numeric"
              aria-label="Overall credit cap in rupees"
              value={cap}
              onChange={(e) => setCap(e.target.value.replace(/[^0-9]/g, ""))}
              onBlur={() => {
                const n = Number(cap);
                if (Number.isFinite(n) && n * 100 !== capPaise) run(() => setCreditCap(n));
              }}
            />
          </div>
          <p className="mt-2 text-[12px]" style={{ color: "var(--muted-2)" }}>
            {rupees(Math.max(0, capPaise - owed))} of room left
          </p>
        </div>
      </div>

      {coo.creditCustomers.length === 0 ? (
        <EmptyState text="No customers yet." hint="Add a regular customer and a credit limit to start." />
      ) : (
        <Table head={["Customer", "Owes", "Past due", "Limit", ""]}>
          {coo.creditCustomers.map((c) => {
            const r = who(c.id);
            return (
              <tr key={c.id}>
                <td>
                  <p className="text-[15px] font-medium">{c.name}</p>
                  <p className="text-[12px]" style={{ color: "var(--muted-2)" }}>
                    {r?.oldestDueAt ? `${r.overduePaise > 0 ? "Was due" : "Due"} ${dueDate(r.oldestDueAt)}` : `${c.termsDays}-day terms`}
                  </p>
                </td>
                <td className="num">{rupees(r?.owedPaise ?? 0)}</td>
                <td>{r && r.overduePaise > 0 ? <Pill color="var(--decision-block)">{rupees(r.overduePaise)}</Pill> : <span style={{ color: "var(--muted-2)" }}>—</span>}</td>
                <td className="num">{c.limitPaise > 0 ? rupees(c.limitPaise) : <span style={{ color: "var(--muted-2)" }}>No credit</span>}</td>
                <td>
                  <div className="flex flex-wrap justify-end gap-2">
                    <GhostButton
                      disabled={pending || c.limitPaise <= 0}
                      onClick={() => {
                        setSf({ sku: sellable[0]?.sku ?? "", qty: "1" });
                        open({ kind: "sell", id: c.id });
                      }}
                    >
                      Sell
                    </GhostButton>
                    <GhostButton
                      disabled={pending || !r || r.owedPaise <= 0}
                      onClick={() => {
                        setPf({ amount: r ? String(Math.round(r.owedPaise / 100)) : "" });
                        open({ kind: "receive", id: c.id });
                      }}
                    >
                      Got paid
                    </GhostButton>
                    <GhostButton
                      disabled={pending}
                      onClick={() => {
                        setCf({ name: c.name, phone: "", limit: String(Math.round(c.limitPaise / 100)), terms: String(c.termsDays) });
                        open({ kind: "customer", id: c.id });
                      }}
                    >
                      Limit
                    </GhostButton>
                    {r && r.owedPaise > 0 && (
                      <GhostButton disabled={pending} onClick={() => { setRef(newRef()); setWriteOffId(c.id); }}>
                        Write off
                      </GhostButton>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </Table>
      )}

      <Drawer
        open={mode?.kind === "customer"}
        onClose={close}
        title={editing ? `Credit for ${editing.name}` : "Add a customer"}
        description="A limit of 0 means no credit. The limit is the most they can owe you at once."
        footer={
          <div className="flex gap-3">
            <PrimaryButton
              disabled={pending}
              onClick={() =>
                run(async () => {
                  await saveCreditCustomer({ customerId: editing?.id, name: editing ? undefined : cf.name, phone: editing ? undefined : cf.phone, limitRupees: Number(cf.limit), termsDays: Number(cf.terms) });
                  close();
                })
              }
            >
              {pending ? "Saving…" : "Save"}
            </PrimaryButton>
            <GhostButton onClick={close}>Cancel</GhostButton>
          </div>
        }
      >
        <ErrorLine error={error} />
        <div className="grid gap-5 pb-4">
          {!editing && (
            <>
              <Field label="Name">
                <input className={inputClass} style={inputStyle} value={cf.name} onChange={(e) => setCf({ ...cf, name: e.target.value })} />
              </Field>
              <Field label="Phone (for reminders on WhatsApp)">
                <input className={inputClass} style={inputStyle} inputMode="tel" value={cf.phone} onChange={(e) => setCf({ ...cf, phone: e.target.value })} />
              </Field>
            </>
          )}
          <div className="grid grid-cols-2 gap-5">
            <Field label="Credit limit (₹)">
              <input className={inputClass} style={inputStyle} inputMode="numeric" value={cf.limit} onChange={(e) => setCf({ ...cf, limit: e.target.value.replace(/[^0-9]/g, "") })} />
            </Field>
            <Field label="Pays within (days)">
              <input className={inputClass} style={inputStyle} inputMode="numeric" value={cf.terms} onChange={(e) => setCf({ ...cf, terms: e.target.value.replace(/[^0-9]/g, "") })} />
            </Field>
          </div>
        </div>
      </Drawer>

      <Drawer
        open={mode?.kind === "sell"}
        onClose={close}
        title={mode?.kind === "sell" ? `Sell to ${customer(mode.id)?.name ?? "customer"} on credit` : "Sell on credit"}
        description="Stock comes off the shelf now. It counts as money only when they pay."
        footer={
          <div className="flex gap-3">
            <PrimaryButton
              disabled={pending || !sf.sku}
              onClick={() =>
                run(async () => {
                  if (mode?.kind !== "sell") return;
                  await sellOnCreditAction({ customerId: mode.id, sku: sf.sku, qty: Number(sf.qty), ref });
                  close();
                })
              }
            >
              {pending ? "Saving…" : "Record the sale"}
            </PrimaryButton>
            <GhostButton onClick={close}>Cancel</GhostButton>
          </div>
        }
      >
        <ErrorLine error={error} />
        <div className="grid gap-5 pb-4">
          <Field label="Product">
            <select className={inputClass} style={inputStyle} value={sf.sku} onChange={(e) => setSf({ ...sf, sku: e.target.value })}>
              {sellable.map((i) => (
                <option key={i.sku} value={i.sku} style={{ background: "#14141f" }}>
                  {i.name} · {rupees(i.pricePaise)} · {i.stockQty} in stock
                </option>
              ))}
            </select>
          </Field>
          <Field label="Quantity" hint={sf.sku ? `Total: ${rupees((sellable.find((i) => i.sku === sf.sku)?.pricePaise ?? 0) * (Number(sf.qty) || 0))}` : undefined}>
            <input className={inputClass} style={inputStyle} inputMode="numeric" value={sf.qty} onChange={(e) => setSf({ ...sf, qty: e.target.value.replace(/[^0-9]/g, "") })} />
          </Field>
        </div>
      </Drawer>

      <Drawer
        open={mode?.kind === "receive"}
        onClose={close}
        title={mode?.kind === "receive" ? `${customer(mode.id)?.name ?? "Customer"} paid` : "Got paid"}
        description="The amount goes into your wallet and counts as revenue now."
        footer={
          <div className="flex gap-3">
            <SuccessButton
              disabled={pending || !(Number(pf.amount) > 0)}
              onClick={() =>
                run(async () => {
                  if (mode?.kind !== "receive") return;
                  await receiveCreditPayment({ customerId: mode.id, amountRupees: Number(pf.amount), ref });
                  close();
                })
              }
            >
              {pending ? "Saving…" : "Record payment"}
            </SuccessButton>
            <GhostButton onClick={close}>Cancel</GhostButton>
          </div>
        }
      >
        <ErrorLine error={error} />
        <div className="grid gap-5 pb-4">
          <Field label="Amount received (₹)" hint={mode?.kind === "receive" && who(mode.id) ? `They owe ${rupees(who(mode.id)!.owedPaise)}.` : undefined}>
            <input className={inputClass} style={inputStyle} inputMode="numeric" value={pf.amount} onChange={(e) => setPf({ amount: e.target.value.replace(/[^0-9.]/g, "") })} />
          </Field>
        </div>
      </Drawer>

      <ConfirmSheet
        open={writeOffId !== null}
        title="Write this off?"
        body={writeOffId ? `You will stop expecting ${rupees(who(writeOffId)?.owedPaise ?? 0)} from ${customer(writeOffId)?.name ?? "this customer"}. No money comes in. This is kept in the record.` : ""}
        confirmLabel="Write off"
        danger
        onClose={() => setWriteOffId(null)}
        onConfirm={() => {
          const id = writeOffId;
          setWriteOffId(null);
          if (id) run(() => writeOffCredit({ customerId: id, amountRupees: (who(id)?.owedPaise ?? 0) / 100, ref }));
        }}
      />
    </Panel>
  );
}
