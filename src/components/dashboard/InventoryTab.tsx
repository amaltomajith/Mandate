"use client";

import { useState } from "react";
import type { ProductInsight, StockStatus } from "@/lib/inventory";
import { PRODUCT_CATEGORIES } from "@/lib/catalog";
import { deleteProduct, importProductsCsv, saveProduct, setProductActive, setStock, type ProductInput } from "@/lib/actions/inventory";
import { EmptyState, GhostButton, Icons, Panel, PrimaryButton } from "./ui";
import { ErrorLine, Field, Pill, Table, inputClass, inputStyle, rupees, useRunner } from "./kit";

const STATUS: Record<StockStatus, { label: string; color: string }> = {
  stockout: { label: "Out of stock", color: "var(--decision-block)" },
  low: { label: "Running low", color: "var(--decision-block)" },
  healthy: { label: "Healthy", color: "var(--decision-allow)" },
  overstock: { label: "Overstocked", color: "var(--decision-escalate)" },
  dead: { label: "Not selling", color: "var(--decision-escalate)" },
};

interface Draft {
  sku: string;
  name: string;
  category: string;
  price: string;
  cost: string;
  stock: string;
  reorder: string;
  lead: string;
}
const EMPTY: Draft = { sku: "", name: "", category: PRODUCT_CATEGORIES[0], price: "", cost: "", stock: "0", reorder: "0", lead: "7" };

const toPaise = (v: string): number | null => (v.trim() === "" ? null : Math.round(parseFloat(v) * 100));

function toInput(d: Draft): ProductInput {
  const price = toPaise(d.price);
  if (price === null || Number.isNaN(price)) throw new Error("Enter a price.");
  const cost = toPaise(d.cost);
  return {
    sku: d.sku,
    name: d.name,
    description: "",
    category: d.category,
    pricePaise: price,
    costPaise: cost === null || Number.isNaN(cost) ? null : cost,
    stockQty: parseInt(d.stock || "0", 10),
    reorderPoint: parseInt(d.reorder || "0", 10),
    leadTimeDays: parseInt(d.lead || "0", 10),
  };
}

export function InventoryTab({ insights }: { insights: ProductInsight[] }) {
  const { error, pending, run, clear } = useRunner();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [importing, setImporting] = useState(false);
  const [csv, setCsv] = useState("");
  const [importResult, setImportResult] = useState<string | null>(null);
  const [countFor, setCountFor] = useState<{ id: string; value: string } | null>(null);

  const missingCost = insights.filter((i) => i.active && i.costPaise === null).length;

  function startEdit(i: ProductInsight) {
    setEditing(i.productId);
    clear();
    setDraft({
      sku: i.sku,
      name: i.name,
      category: i.category,
      price: String((i.compareAtPaise ?? i.pricePaise) / 100),
      cost: i.costPaise === null ? "" : String(i.costPaise / 100),
      stock: String(i.stockQty),
      reorder: String(i.reorderPoint),
      lead: String(i.leadTimeDays),
    });
  }

  return (
    <div className="flex flex-col gap-5">
      {missingCost > 0 && (
        <div className="rounded-2xl border px-4 py-3 text-[13px]" style={{ borderColor: "var(--decision-escalate)", color: "var(--decision-escalate)", background: "color-mix(in srgb, var(--decision-escalate) 8%, transparent)" }}>
          {missingCost} product{missingCost === 1 ? " has" : "s have"} no cost recorded. Without a cost the margin floor cannot be checked, so every sale and price change for
          {missingCost === 1 ? " it" : " them"} waits for your approval.
        </div>
      )}

      <Panel
        title="Inventory"
        icon={<Icons.Sparkles />}
        accent="var(--entity-customer)"
        action={
          <div className="flex gap-2">
            <GhostButton className="px-3" onClick={() => { setImporting((v) => !v); setImportResult(null); }}>
              Import CSV
            </GhostButton>
            <PrimaryButton className="px-3" onClick={() => { setEditing("new"); setDraft(EMPTY); clear(); }}>
              Add product
            </PrimaryButton>
          </div>
        }
      >
        <ErrorLine error={error} />

        {importing && (
          <div className="mb-4 rounded-xl p-3" style={{ background: "var(--panel-2)" }}>
            <p className="mb-2 text-[12px]" style={{ color: "var(--muted)" }}>
              One product per line: <code>sku,name,category,price,cost,stock,reorder,lead_days</code>. Prices in rupees. Existing SKUs are updated.
            </p>
            <textarea className={`${inputClass} font-mono`} style={inputStyle} rows={5} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder="mouse-01,Wireless Mouse,electronics,899,520,140,40,5" />
            <div className="mt-2 flex items-center gap-3">
              <PrimaryButton
                disabled={pending || !csv.trim()}
                className="px-4"
                onClick={() =>
                  run(async () => {
                    const r = await importProductsCsv(csv);
                    setImportResult(`${r.created} added, ${r.updated} updated${r.errors.length ? `. ${r.errors.join(" ")}` : "."}`);
                    if (r.errors.length === 0) setCsv("");
                  })
                }
              >
                Import
              </PrimaryButton>
              {importResult && <span className="text-[12px]" style={{ color: "var(--muted)" }}>{importResult}</span>}
            </div>
          </div>
        )}

        {editing && (
          <div className="mb-5 rounded-xl p-4" style={{ background: "var(--panel-2)" }}>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Field label="SKU" hint="Stable id, lowercase">
                <input className={inputClass} style={inputStyle} value={draft.sku} disabled={editing !== "new"} onChange={(e) => setDraft({ ...draft, sku: e.target.value })} />
              </Field>
              <div className="col-span-2">
                <Field label="Name">
                  <input className={inputClass} style={inputStyle} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                </Field>
              </div>
              <Field label="Category">
                <select className={inputClass} style={inputStyle} value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })}>
                  {PRODUCT_CATEGORIES.map((c) => (
                    <option key={c} value={c} style={{ background: "#14141f" }}>
                      {c}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Selling price (₹)">
                <input className={inputClass} style={inputStyle} inputMode="decimal" value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} />
              </Field>
              <Field label="Cost per unit (₹)" hint="Leave empty if unknown">
                <input className={inputClass} style={inputStyle} inputMode="decimal" value={draft.cost} onChange={(e) => setDraft({ ...draft, cost: e.target.value })} />
              </Field>
              <Field label="In stock">
                <input className={inputClass} style={inputStyle} inputMode="numeric" value={draft.stock} onChange={(e) => setDraft({ ...draft, stock: e.target.value })} />
              </Field>
              <Field label="Reorder at" hint="Units">
                <input className={inputClass} style={inputStyle} inputMode="numeric" value={draft.reorder} onChange={(e) => setDraft({ ...draft, reorder: e.target.value })} />
              </Field>
              <Field label="Supplier lead time (days)">
                <input className={inputClass} style={inputStyle} inputMode="numeric" value={draft.lead} onChange={(e) => setDraft({ ...draft, lead: e.target.value })} />
              </Field>
            </div>
            <div className="mt-4 flex gap-2">
              <PrimaryButton disabled={pending} className="px-5" onClick={() => run(async () => { await saveProduct(editing === "new" ? null : editing, toInput(draft)); setEditing(null); })}>
                {pending ? "Saving…" : "Save"}
              </PrimaryButton>
              <GhostButton className="px-4" onClick={() => setEditing(null)}>
                Cancel
              </GhostButton>
            </div>
          </div>
        )}

        {insights.length === 0 ? (
          <EmptyState text="No products yet. Add one, import a CSV, or load the sample store from the Today tab." />
        ) : (
          <Table head={["Product", "Price", "Stock", "Sold (30d)", "Days left", "Status", "Cash tied up", "Margin", ""]}>
            {insights.map((i) => {
              const st = STATUS[i.status];
              return (
                <tr key={i.productId} style={{ opacity: i.active ? 1 : 0.5 }}>
                  <td className="px-2 py-2.5">
                    <div className="font-medium">{i.name}</div>
                    <div className="font-mono text-[10.5px]" style={{ color: "var(--muted-2)" }}>
                      {i.sku} · {i.category}
                    </div>
                  </td>
                  <td className="px-2 py-2.5 tabular-nums">
                    {rupees(i.pricePaise)}
                    {i.compareAtPaise !== null && (
                      <div className="text-[10.5px]" style={{ color: "var(--decision-allow)" }}>
                        was {rupees(i.compareAtPaise)}
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-2.5 tabular-nums">
                    {countFor?.id === i.productId ? (
                      <span className="flex items-center gap-1">
                        <input className={`${inputClass} !w-16 !px-2 !py-1`} style={inputStyle} value={countFor.value} onChange={(e) => setCountFor({ id: i.productId, value: e.target.value })} />
                        <button className="text-[11px] underline" onClick={() => run(async () => { await setStock(i.productId, parseInt(countFor.value || "0", 10)); setCountFor(null); })}>
                          set
                        </button>
                      </span>
                    ) : (
                      <button className="tabular-nums underline-offset-2 hover:underline" title="Click to count stock" onClick={() => setCountFor({ id: i.productId, value: String(i.stockQty) })}>
                        {i.stockQty}
                      </button>
                    )}
                    {i.inboundQty > 0 && (
                      <div className="text-[10.5px]" style={{ color: "var(--muted)" }}>
                        +{i.inboundQty} on order
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-2.5 tabular-nums">{i.units30d}</td>
                  <td className="px-2 py-2.5 tabular-nums">{i.runwayDays === null ? "—" : Math.round(i.runwayDays)}</td>
                  <td className="px-2 py-2.5">
                    <Pill color={st.color}>{st.label}</Pill>
                    {i.needsRestock && (
                      <div className="mt-1 text-[10.5px]" style={{ color: "var(--muted)" }}>
                        reorder {i.reorderQty}
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-2.5 tabular-nums">{rupees(i.cashTiedPaise)}</td>
                  <td className="px-2 py-2.5 tabular-nums">{i.marginBps === null ? <span style={{ color: "var(--decision-escalate)" }}>no cost</span> : `${(i.marginBps / 100).toFixed(0)}%`}</td>
                  <td className="whitespace-nowrap px-2 py-2.5 text-right">
                    <button className="mr-3 text-[11.5px] underline-offset-2 hover:underline" onClick={() => startEdit(i)}>
                      Edit
                    </button>
                    <button className="text-[11.5px] underline-offset-2 hover:underline" style={{ color: "var(--muted)" }} onClick={() => run(() => setProductActive(i.productId, !i.active))}>
                      {i.active ? "Retire" : "Restore"}
                    </button>
                    {!i.active && (
                      <button className="ml-3 text-[11.5px] underline-offset-2 hover:underline" style={{ color: "var(--decision-block)" }} onClick={() => run(() => deleteProduct(i.productId))}>
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
      </Panel>
    </div>
  );
}
