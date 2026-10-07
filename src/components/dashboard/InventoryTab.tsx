"use client";

import { useMemo, useState } from "react";
import { MagnifyingGlass, Plus, UploadSimple, Warning } from "@phosphor-icons/react";
import type { ProductInsight, StockStatus } from "@/lib/inventory";
import { PRODUCT_CATEGORIES } from "@/lib/catalog";
import { deleteProduct, importProductsCsv, saveProduct, setProductActive, type ProductInput } from "@/lib/actions/inventory";
import { DangerButton, EmptyState, GhostButton, PrimaryButton } from "./ui";
import { ErrorLine, Field, Pill, inputClass, inputStyle, rupees, rupeesShort, useRunner } from "./kit";
import { AnimatedNumber, Drawer, Reveal, Segmented } from "./motion";

const STATUS: Record<StockStatus, { label: string; color: string }> = {
  stockout: { label: "Out of stock", color: "var(--decision-block)" },
  low: { label: "Running low", color: "var(--decision-block)" },
  healthy: { label: "Healthy", color: "var(--decision-allow)" },
  overstock: { label: "Overstocked", color: "var(--decision-escalate)" },
  dead: { label: "Not selling", color: "var(--decision-escalate)" },
};

type Filter = "all" | "low" | "dead" | "best";

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
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  const active = insights.filter((i) => i.active);
  const missingCost = active.filter((i) => i.costPaise === null).length;
  const stockValue = active.reduce((n, i) => n + (i.cashTiedPaise ?? 0), 0);
  const lowCount = active.filter((i) => i.status === "low" || i.status === "stockout").length;
  const deadCount = active.filter((i) => i.status === "dead" || i.status === "overstock").length;
  const bestIds = useMemo(() => new Set([...active].sort((a, b) => b.units30d - a.units30d).slice(0, 3).filter((i) => i.units30d > 0).map((i) => i.productId)), [active]);

  const shown = insights.filter((i) => {
    if (query && !`${i.name} ${i.sku} ${i.category}`.toLowerCase().includes(query.toLowerCase())) return false;
    if (filter === "low") return i.status === "low" || i.status === "stockout";
    if (filter === "dead") return i.status === "dead" || i.status === "overstock";
    if (filter === "best") return bestIds.has(i.productId);
    return true;
  });

  const editingItem = editing && editing !== "new" ? insights.find((i) => i.productId === editing) : undefined;

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

  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setDraft({ ...draft, [k]: e.target.value });

  return (
    <div className="flex flex-col gap-8">
      {missingCost > 0 && (
        <div className="flex items-start gap-3 rounded-[14px] border px-5 py-4 text-[14px] leading-6" style={{ borderColor: "color-mix(in srgb, var(--decision-escalate) 45%, transparent)", color: "var(--decision-escalate)", background: "color-mix(in srgb, var(--decision-escalate) 8%, transparent)" }}>
          <Warning size={20} className="mt-0.5 shrink-0" />
          <p>
            {missingCost} product{missingCost === 1 ? " has" : "s have"} no cost recorded. Without a cost the margin floor cannot be checked, so every sale and price change for
            {missingCost === 1 ? " it" : " them"} waits for your approval.
          </p>
        </div>
      )}

      <section className="grid grid-cols-2 gap-5 xl:grid-cols-4" aria-label="Inventory summary">
        {[
          { label: "Products", value: active.length, fmt: (n: number) => String(Math.round(n)) },
          { label: "Value on the shelf", value: stockValue, fmt: (n: number) => rupeesShort(n) },
          { label: "Running low", value: lowCount, fmt: (n: number) => String(Math.round(n)), tone: lowCount > 0 ? "var(--decision-block)" : undefined },
          { label: "Not selling", value: deadCount, fmt: (n: number) => String(Math.round(n)), tone: deadCount > 0 ? "var(--decision-escalate)" : undefined },
        ].map((s, idx) => (
          <Reveal key={s.label} index={idx} className="h-full">
            <div className="surface h-full p-6">
              <p className="text-[13px] font-medium" style={{ color: "var(--muted)" }}>
                {s.label}
              </p>
              <p className="num mt-2 text-[34px] font-semibold leading-[40px]" style={{ color: s.tone }}>
                <AnimatedNumber value={s.value} format={s.fmt} />
              </p>
            </div>
          </Reveal>
        ))}
      </section>

      <section className="surface p-7">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <Segmented
            label="Filter products"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All", count: insights.length },
              { value: "low", label: "Running low", count: lowCount },
              { value: "dead", label: "Not selling", count: deadCount },
              { value: "best", label: "Best sellers" },
            ]}
          />
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative">
              <MagnifyingGlass size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2" style={{ color: "var(--muted-2)" }} />
              <input className={`${inputClass} !w-[240px] !pl-10`} placeholder="Search products" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search products" />
            </div>
            <GhostButton onClick={() => { setImporting(true); setImportResult(null); }}>
              <UploadSimple size={18} /> Import CSV
            </GhostButton>
            <PrimaryButton onClick={() => { setEditing("new"); setDraft(EMPTY); clear(); }}>
              <Plus size={18} weight="bold" /> Add product
            </PrimaryButton>
          </div>
        </div>

        <div className="mt-6">
          {insights.length === 0 ? (
            <EmptyState text="No products yet." hint="Add one, import a CSV, or load the sample store from the Today tab." />
          ) : shown.length === 0 ? (
            <EmptyState text="Nothing matches." hint="Try another filter or search." />
          ) : (
            <ul>
              <li className="hidden grid-cols-[2.2fr_1fr_1fr_1.6fr_1.2fr_0.8fr] gap-4 px-4 pb-3 text-[12px] font-medium lg:grid" style={{ color: "var(--muted)" }}>
                <span>Product</span>
                <span>Price</span>
                <span>In stock</span>
                <span>Days left</span>
                <span>Status</span>
                <span className="text-right">Margin</span>
              </li>
              {shown.map((i) => {
                const st = STATUS[i.status];
                const days = i.runwayDays;
                const pct = days === null ? 1 : Math.max(0.05, Math.min(1, days / 45));
                return (
                  <li key={i.productId} style={{ opacity: i.active ? 1 : 0.5 }}>
                    <button
                      type="button"
                      onClick={() => startEdit(i)}
                      className="focus-ring grid w-full grid-cols-2 items-center gap-4 rounded-[14px] px-4 py-4 text-left transition-colors hover:bg-white/[0.04] lg:grid-cols-[2.2fr_1fr_1fr_1.6fr_1.2fr_0.8fr]"
                    >
                      <span className="col-span-2 min-w-0 lg:col-span-1">
                        <span className="block truncate text-[16px] font-medium">{i.name}</span>
                        <span className="num mt-0.5 block text-[12px]" style={{ color: "var(--muted-2)" }}>
                          {i.sku}, {i.category}
                        </span>
                      </span>
                      <span className="num text-[15px]">
                        {rupees(i.pricePaise)}
                        {i.compareAtPaise !== null && (
                          <span className="mt-0.5 block text-[12px]" style={{ color: "var(--decision-allow)" }}>
                            was {rupees(i.compareAtPaise)}
                          </span>
                        )}
                      </span>
                      <span className="num text-[15px]">
                        {i.stockQty}
                        {i.inboundQty > 0 && (
                          <span className="mt-0.5 block text-[12px]" style={{ color: "var(--muted)" }}>
                            +{i.inboundQty} on order
                          </span>
                        )}
                      </span>
                      <span>
                        <span className="num text-[14px]" style={{ color: "var(--muted)" }}>
                          {days === null ? "No sales" : `${Math.round(days)} days`}
                        </span>
                        <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
                          <span className="block h-full rounded-full" style={{ width: `${pct * 100}%`, background: days === null ? "var(--muted-2)" : days < 7 ? "var(--decision-block)" : days < 21 ? "var(--decision-escalate)" : "var(--decision-allow)", transition: "width 0.8s var(--ease-out)" }} />
                        </span>
                      </span>
                      <span>
                        <Pill color={st.color}>{st.label}</Pill>
                        {i.needsRestock && (
                          <span className="mt-1.5 block text-[12px]" style={{ color: "var(--muted)" }}>
                            reorder {i.reorderQty}
                          </span>
                        )}
                      </span>
                      <span className="num text-right text-[15px]">{i.marginBps === null ? <span style={{ color: "var(--decision-escalate)" }}>no cost</span> : `${(i.marginBps / 100).toFixed(0)}%`}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      <Drawer
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === "new" ? "Add a product" : (editingItem?.name ?? "Edit product")}
        description={editing === "new" ? "It starts being tracked as soon as you save." : editingItem ? `${editingItem.sku}, ${editingItem.stockQty} in stock` : undefined}
        footer={
          <div className="flex flex-wrap items-center gap-3">
            <PrimaryButton disabled={pending} onClick={() => run(async () => { await saveProduct(editing === "new" ? null : editing, toInput(draft)); setEditing(null); })}>
              {pending ? "Saving…" : "Save"}
            </PrimaryButton>
            <GhostButton onClick={() => setEditing(null)}>Cancel</GhostButton>
            {editingItem && (
              <span className="ml-auto flex gap-3">
                <GhostButton disabled={pending} onClick={() => run(async () => { await setProductActive(editingItem.productId, !editingItem.active); setEditing(null); })}>
                  {editingItem.active ? "Retire" : "Restore"}
                </GhostButton>
                {!editingItem.active && (
                  <DangerButton disabled={pending} onClick={() => run(async () => { await deleteProduct(editingItem.productId); setEditing(null); })}>
                    Delete
                  </DangerButton>
                )}
              </span>
            )}
          </div>
        }
      >
        <ErrorLine error={error} />
        <div className="grid grid-cols-2 gap-5 pb-4">
          <Field label="SKU" hint="Stable id, lowercase">
            <input className={inputClass} style={inputStyle} value={draft.sku} disabled={editing !== "new"} onChange={set("sku")} />
          </Field>
          <Field label="Category">
            <select className={inputClass} style={inputStyle} value={draft.category} onChange={set("category")}>
              {PRODUCT_CATEGORIES.map((c) => (
                <option key={c} value={c} style={{ background: "#14141f" }}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <div className="col-span-2">
            <Field label="Name">
              <input className={inputClass} style={inputStyle} value={draft.name} onChange={set("name")} />
            </Field>
          </div>
          <Field label="Selling price (₹)">
            <input className={inputClass} style={inputStyle} inputMode="decimal" value={draft.price} onChange={set("price")} />
          </Field>
          <Field label="Cost per unit (₹)" hint="Leave empty if unknown">
            <input className={inputClass} style={inputStyle} inputMode="decimal" value={draft.cost} onChange={set("cost")} />
          </Field>
          <Field label="In stock" hint="Count it, then type the number">
            <input className={inputClass} style={inputStyle} inputMode="numeric" value={draft.stock} onChange={set("stock")} />
          </Field>
          <Field label="Reorder at" hint="Units">
            <input className={inputClass} style={inputStyle} inputMode="numeric" value={draft.reorder} onChange={set("reorder")} />
          </Field>
          <Field label="Supplier lead time (days)">
            <input className={inputClass} style={inputStyle} inputMode="numeric" value={draft.lead} onChange={set("lead")} />
          </Field>
        </div>
      </Drawer>

      <Drawer
        open={importing}
        onClose={() => setImporting(false)}
        title="Import from CSV"
        description="One product per line. Prices in rupees. Existing SKUs are updated."
        footer={
          <div className="flex items-center gap-4">
            <PrimaryButton
              disabled={pending || !csv.trim()}
              onClick={() =>
                run(async () => {
                  const r = await importProductsCsv(csv);
                  setImportResult(`${r.created} added, ${r.updated} updated${r.errors.length ? `. ${r.errors.join(" ")}` : "."}`);
                  if (r.errors.length === 0) setCsv("");
                })
              }
            >
              {pending ? "Importing…" : "Import"}
            </PrimaryButton>
            {importResult && (
              <span className="text-[14px]" style={{ color: "var(--muted)" }}>
                {importResult}
              </span>
            )}
          </div>
        }
      >
        <ErrorLine error={error} />
        <p className="mb-3 text-[14px] leading-6" style={{ color: "var(--muted)" }}>
          Columns: <code className="num rounded bg-white/10 px-1.5 py-0.5">sku,name,category,price,cost,stock,reorder,lead_days</code>
        </p>
        <textarea className={`${inputClass} num`} style={inputStyle} rows={10} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder="mouse-01,Wireless Mouse,electronics,899,520,140,40,5" />
      </Drawer>
    </div>
  );
}
