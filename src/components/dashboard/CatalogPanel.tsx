"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import {
  agentScopesByCategory,
  catalogHealth,
  catalogSalesTimeline,
  createProduct,
  deleteProduct,
  listProducts,
  setProductActive,
  updateProduct,
  type CatalogHealthIssue,
  type CatalogSalesPoint,
  type ProductInput,
  type ProductRow,
} from "@/lib/actions/products";
import { getSellableCatalog, type SellableSnapshot } from "@/lib/actions/sellable";
import { PRODUCT_CATEGORIES } from "@/lib/demo/catalog";
import { formatMoney } from "@/lib/format";
import { EmptyState, GhostButton, Icons, Panel, PrimaryButton, Spinner, decisionColor } from "./ui";
import { AnimatedLineChart } from "./charts/AnimatedLineChart";

/**
 * What the merchant sells, and what the control plane already knows about it.
 *
 * A plain product table would be the obvious thing and would miss the point.
 * Two columns here are not product data at all — they are what this system can
 * say that a shop admin cannot: how much of each product has actually sold,
 * derived from the audit trail rather than a stored counter, and whether the
 * policy engine would let an agent buy it right now. The second one is the
 * reason a merchant would open this tab rather than their storefront admin.
 *
 * The verdict column reuses the existing headroom probe rather than asking the
 * engine a second way. Two implementations of "would this clear" is how they
 * drift, and a catalog that disagrees with the Buy tab about the same product
 * is worse than one that says nothing.
 */

const EMPTY: ProductInput = { sku: "", name: "", description: "", pricePaise: 0, category: "electronics" };

export function CatalogPanel() {
  const [products, setProducts] = useState<ProductRow[] | null>(null);
  const [health, setHealth] = useState<CatalogHealthIssue[]>([]);
  const [sellable, setSellable] = useState<SellableSnapshot | null>(null);
  const [scopes, setScopes] = useState<{ category: string; agents: { id: string; name: string }[] }[]>([]);
  const [sales, setSales] = useState<CatalogSalesPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProductInput>(EMPTY);
  const [adding, setAdding] = useState(false);
  const [isPending, startTransition] = useTransition();

  const refresh = useCallback(() => {
    startTransition(async () => {
      try {
        const [p, h, sc, sl] = await Promise.all([
          listProducts(),
          catalogHealth(),
          agentScopesByCategory(),
          catalogSalesTimeline(),
        ]);
        setProducts(p);
        setHealth(h);
        setScopes(sc);
        setSales(sl);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't load the catalog.");
      }
    });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Probed separately and lazily. Each verdict is a real round trip through the
  // engine, so the table renders immediately on catalog data and fills the
  // verdict column when the answers arrive -- rather than showing nothing at
  // all for the six seconds those probes take.
  useEffect(() => {
    let cancelled = false;
    getSellableCatalog()
      .then((s) => !cancelled && setSellable(s))
      .catch(() => {
        /* the column simply stays quiet; the catalog itself is still usable */
      });
    return () => {
      cancelled = true;
    };
  }, [products?.length]);

  function run(fn: () => Promise<unknown>) {
    setError(null);
    startTransition(async () => {
      try {
        await fn();
        // Scopes refresh too. Editing a product's CATEGORY changes which
        // agents may buy it, so leaving this out left the row describing the
        // category it used to be in.
        const [p, h, sc] = await Promise.all([listProducts(), catalogHealth(), agentScopesByCategory()]);
        setProducts(p);
        setHealth(h);
        setScopes(sc);
        setEditing(null);
        setAdding(false);
        setDraft(EMPTY);
      } catch (err) {
        setError(err instanceof Error ? err.message : "That didn't work.");
      }
    });
  }

  const verdictFor = (sku: string) => sellable?.items.find((i) => i.sku === sku);

  return (
    <div className="flex flex-col gap-5">
      <Panel
        title="Catalog"
        icon={<Icons.Sparkles />}
        accent="var(--entity-customer)"
        count={products?.filter((p) => !p.active).length}
        action={
          !adding && (
            <GhostButton
              onClick={() => {
                setAdding(true);
                setEditing(null);
                setDraft(EMPTY);
              }}
              disabled={isPending}
            >
              Add a product
            </GhostButton>
          )
        }
      >
        {error && (
          <p
            className="mb-3 rounded-lg border px-3 py-2 text-xs"
            style={{
              borderColor: "var(--decision-block)",
              color: "var(--decision-block)",
              background: "color-mix(in srgb, var(--decision-block) 14%, transparent)",
            }}
          >
            {error}
          </p>
        )}

        {/* Units sold, growing — the catalog's own version of Overview's money
            curve, so the same "it's going up" story exists for volume, not
            just revenue. Only rendered once real sales exist and enough
            buckets exist to draw a line; a fresh catalog with nothing sold yet
            has nothing honest to chart. */}
        {sales && sales.length >= 2 && (
          <div className="mb-4 rounded-xl border p-4" style={{ borderColor: "var(--panel-border)", background: "var(--panel-2)" }}>
            <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider" style={{ color: "var(--muted-2)" }}>
              Units sold, over time
            </p>
            <AnimatedLineChart
              data={sales.map((s) => ({ label: s.label, value: s.cumulativeUnits }))}
              color="var(--entity-customer)"
              height={110}
              valueFormatter={(v) => Math.round(v).toLocaleString("en-IN")}
              clampMin={0}
            />
          </div>
        )}

        {adding && (
          <ProductForm
            draft={draft}
            setDraft={setDraft}
            busy={isPending}
            submitLabel="Create"
            onCancel={() => {
              setAdding(false);
              setDraft(EMPTY);
            }}
            onSubmit={() => run(() => createProduct(draft))}
          />
        )}

        {!products ? (
          <div className="flex items-center gap-2 py-6 text-xs" style={{ color: "var(--muted)" }}>
            <Spinner />
            Loading the catalog…
          </div>
        ) : products.length === 0 ? (
          <EmptyState text="Nothing in the catalog yet. Add a product — an agent with nothing to buy has nothing to demonstrate." />
        ) : (
          <div className="space-y-2">
            {products.map((p) =>
              editing === p.id ? (
                <ProductForm
                  key={p.id}
                  draft={draft}
                  setDraft={setDraft}
                  busy={isPending}
                  submitLabel="Save"
                  onCancel={() => setEditing(null)}
                  onSubmit={() => run(() => updateProduct(p.id, draft))}
                />
              ) : (
                <ProductRowView
                  key={p.id}
                  product={p}
                  buyers={scopes.find((x) => x.category === p.category)?.agents ?? []}
                  verdict={verdictFor(p.sku)}
                  verdictAgent={sellable?.agent?.name ?? null}
                  verdictPending={!sellable}
                  busy={isPending}
                  onEdit={() => {
                    setEditing(p.id);
                    setAdding(false);
                    setDraft({
                      sku: p.sku,
                      name: p.name,
                      description: p.description,
                      pricePaise: p.pricePaise,
                      category: p.category,
                    });
                  }}
                  onToggle={() => run(() => setProductActive(p.id, !p.active))}
                  onDelete={() =>
                    window.confirm(
                      `Delete "${p.name}" permanently?\n\nNothing in the audit trail references it, so nothing will be lost. ` +
                        `If you only want it off the storefront, Retire keeps the row and the history.`
                    ) && run(() => deleteProduct(p.id))
                  }
                />
              )
            )}
          </div>
        )}
      </Panel>

      <CatalogHealth issues={health} total={products?.filter((p) => p.active).length ?? 0} />
    </div>
  );
}

function ProductRowView({
  product,
  buyers,
  verdict,
  verdictAgent,
  verdictPending,
  busy,
  onEdit,
  onToggle,
  onDelete,
}: {
  product: ProductRow;
  /** Agents whose scope currently admits this product's category. */
  buyers: { id: string; name: string }[];
  verdict?: { decision: string; reasoning: string };
  /** Whose verdict this is. The probe answers for ONE agent, and since catalog
   *  scope is per-agent an unattributed "allow" is a claim about nobody. */
  verdictAgent: string | null;
  verdictPending: boolean;
  busy: boolean;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className="rounded-xl border p-3"
      style={{
        borderColor: "var(--panel-border)",
        background: "var(--panel-2)",
        // Retired products stay visible but visibly inert. Hiding them would
        // make Retire indistinguishable from Delete.
        opacity: product.active ? 1 : 0.55,
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[13px] font-semibold">{product.name}</span>
            <code className="font-mono text-[10px]" style={{ color: "var(--muted-2)" }}>
              {product.sku}
            </code>
            {!product.active && (
              <span
                className="rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider"
                style={{ background: "var(--panel)", color: "var(--muted)" }}
              >
                retired
              </span>
            )}
          </div>
          <p className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed" style={{ color: "var(--muted)" }}>
            {product.description}
          </p>
        </div>

        <div className="shrink-0 text-right">
          <p className="text-[13px] font-semibold tabular-nums">{formatMoney(product.pricePaise, "INR")}</p>
          <p className="text-[10px]" style={{ color: "var(--muted-2)" }}>
            {product.category}
          </p>
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[10.5px]">
        {/* Derived from traces, never stored -- same rule every other panel
            follows, and the reason these numbers cannot drift from the log. */}
        <span style={{ color: "var(--muted-2)" }}>
          {product.unitsSold === 0 ? (
            "no sales yet"
          ) : (
            <>
              <span className="tabular-nums" style={{ color: "var(--foreground)" }}>
                {product.unitsSold}
              </span>{" "}
              sold ·{" "}
              <span className="tabular-nums" style={{ color: "var(--foreground)" }}>
                {formatMoney(product.revenuePaise, "INR")}
              </span>
            </>
          )}
        </span>

        {product.active && (
          <span
            style={{ color: buyers.length === 0 ? "var(--decision-escalate)" : "var(--muted-2)" }}
            title={
              buyers.length === 0
                ? "No agent's catalog scope currently admits this category."
                : buyers.map((b) => b.name).join(", ")
            }
          >
            {buyers.length === 0
              ? "no agent may buy this"
              : `${buyers.length} agent${buyers.length === 1 ? "" : "s"} may buy this`}
          </span>
        )}

        {product.active && (
          <span style={{ color: verdict ? decisionColor(verdict.decision) : "var(--muted-2)" }} title={verdict?.reasoning}>
            {verdictPending
              ? "checking with the engine…"
              : verdict
                ? `${verdictAgent ?? "engine"}: ${verdict.decision}`
                : "not checked"}
          </span>
        )}

        <span className="ml-auto flex items-center gap-1.5">
          <GhostButton onClick={onEdit} disabled={busy} className="px-2! py-1! text-[10px]!">
            Edit
          </GhostButton>
          <GhostButton onClick={onToggle} disabled={busy} className="px-2! py-1! text-[10px]!">
            {product.active ? "Retire" : "Restore"}
          </GhostButton>
          {/* Only offered when it is actually safe. A delete button that
              usually errors is worse than no delete button. */}
          {product.deletable && (
            <GhostButton onClick={onDelete} disabled={busy} className="px-2! py-1! text-[10px]!">
              Delete
            </GhostButton>
          )}
        </span>
      </div>
    </div>
  );
}

function ProductForm({
  draft,
  setDraft,
  busy,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  draft: ProductInput;
  setDraft: (d: ProductInput) => void;
  busy: boolean;
  submitLabel: string;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const inputStyle = {
    borderColor: "var(--panel-border)",
    background: "var(--panel-2)",
    color: "var(--foreground)",
  };
  return (
    <div className="mb-3 rounded-xl border p-3" style={{ borderColor: "var(--panel-border-strong)" }}>
      <div className="grid gap-2 sm:grid-cols-2">
        <input
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder="Name"
          className="w-full rounded-lg border px-3 py-2 text-sm outline-none"
          style={inputStyle}
        />
        <input
          value={draft.sku}
          onChange={(e) => setDraft({ ...draft, sku: e.target.value })}
          placeholder="SKU — lowercase, e.g. monitor-01"
          className="w-full rounded-lg border px-3 py-2 font-mono text-[12px] outline-none"
          style={inputStyle}
        />
      </div>
      <textarea
        value={draft.description}
        onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        placeholder="Description — this is all an agent has to reason from, so write it for a reader with no picture and no shelf label."
        rows={2}
        className="mt-2 w-full resize-none rounded-lg border px-3 py-2 text-sm outline-none"
        style={inputStyle}
      />
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <input
          type="number"
          value={draft.pricePaise === 0 ? "" : draft.pricePaise / 100}
          onChange={(e) =>
            setDraft({ ...draft, pricePaise: Math.round(Number(e.target.value || 0) * 100) })
          }
          placeholder="Price in rupees"
          className="w-full rounded-lg border px-3 py-2 text-sm tabular-nums outline-none"
          style={inputStyle}
        />
        <select
          value={draft.category}
          onChange={(e) => setDraft({ ...draft, category: e.target.value })}
          className="w-full rounded-lg border px-3 py-2 text-sm outline-none"
          style={inputStyle}
        >
          {PRODUCT_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <PrimaryButton onClick={onSubmit} disabled={busy} className="px-4!">
          <span className="flex items-center justify-center gap-1.5">
            {busy && <Spinner />}
            {submitLabel}
          </span>
        </PrimaryButton>
        <GhostButton onClick={onCancel} disabled={busy}>
          Cancel
        </GhostButton>
      </div>
    </div>
  );
}

function CatalogHealth({ issues, total }: { issues: CatalogHealthIssue[]; total: number }) {
  return (
    <Panel
      title="Catalog health"
      icon={<Icons.Shield />}
      accent={issues.length ? "var(--decision-escalate)" : "var(--decision-allow)"}
      count={issues.length}
    >
      <p className="mb-3 text-[11.5px] leading-relaxed" style={{ color: "var(--muted)" }}>
        What an AI buyer needs from a catalog, checked without a model — the same way policy health
        is checked. An agent has the JSON and nothing else: no photograph, no shelf, no salesperson.
        A gap a human would fill from context is a gap an agent cannot fill at all.
      </p>
      {issues.length === 0 ? (
        <div
          className="rounded-lg border px-3 py-2.5 text-[11.5px]"
          style={{
            borderColor: "color-mix(in srgb, var(--decision-allow) 35%, transparent)",
            color: "var(--decision-allow)",
          }}
        >
          All {total} active {total === 1 ? "product is" : "products are"} complete: a real description,
          a known category, a positive price and a stable SKU.
        </div>
      ) : (
        <div className="space-y-1.5">
          {issues.map((i, n) => (
            <div
              key={`${i.sku}-${n}`}
              className="rounded-lg border p-2.5"
              style={{ borderColor: "color-mix(in srgb, var(--decision-escalate) 30%, transparent)" }}
            >
              <div className="flex items-baseline gap-2">
                <span className="text-[11.5px] font-semibold" style={{ color: "var(--decision-escalate)" }}>
                  {i.problem}
                </span>
                <code className="font-mono text-[10px]" style={{ color: "var(--muted-2)" }}>
                  {i.sku}
                </code>
              </div>
              <p className="mt-1 text-[11px] leading-relaxed" style={{ color: "var(--muted)" }}>
                {i.why}
              </p>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
