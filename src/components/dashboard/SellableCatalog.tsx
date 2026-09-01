"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { getSellableCatalog, type SellableItem, type SellableSnapshot } from "@/lib/actions/sellable";
import { formatMoney } from "@/lib/format";
import { GhostButton, Icons, Panel, Spinner, relativeTime } from "./ui";

const DECISION_META: Record<SellableItem["decision"], { label: string; color: string }> = {
  allow: { label: "Clears", color: "var(--decision-allow)" },
  escalate: { label: "Needs you", color: "var(--decision-escalate)" },
  block: { label: "Refused", color: "var(--decision-block)" },
};

/**
 * The catalog, answered by the policy engine rather than listed.
 *
 * Every item is put through `simulate_action`, so each answer is the one the
 * engine would actually give — not the UI's own reading of the rules, which
 * could drift from them. It moves as trust moves and as caps are edited, which
 * is the whole point: a static price list cannot tell a merchant that half
 * their range just became unsellable because an agent's trust fell.
 *
 * Probing is free — velocity counts only enforce-mode traces — so this costs
 * no rate budget and moves no money. It is the same check the agent runs
 * before proposing an upsell, pointed at the merchant instead.
 */
export function SellableCatalog() {
  const [snapshot, setSnapshot] = useState<SellableSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const load = useCallback(() => {
    setError(null);
    startTransition(async () => {
      try {
        setSnapshot(await getSellableCatalog());
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't check the catalog.");
      }
    });
  }, []);

  // Loads once on open. Not on an interval: it costs a round trip per item and
  // nothing changes between renders unless a rule or the agent's standing
  // does. Deferred out of the commit phase rather than called directly —
  // starting a transition synchronously inside an effect cascades renders.
  useEffect(() => {
    const id = setTimeout(load, 0);
    return () => clearTimeout(id);
  }, [load]);

  const total = snapshot ? snapshot.clearsValue + snapshot.needsApprovalValue + snapshot.refusedValue : 0;
  const pct = (v: number) => (total > 0 ? (v / total) * 100 : 0);

  return (
    <Panel
      title="What the agent can sell"
      icon={<Icons.Shield />}
      accent="var(--entity-agent)"
      action={
        <GhostButton onClick={load} disabled={isPending} className="py-1! px-2.5! text-[10px]!">
          {isPending ? "Checking…" : "Re-check"}
        </GhostButton>
      }
    >
      <p className="mb-3 text-xs leading-relaxed" style={{ color: "var(--muted)" }}>
        Every item put to the policy engine as it stands right now. This is the same check the agent
        runs before proposing something — nothing is bought, and probing costs no rate budget.
      </p>

      {error && (
        <p className="mb-3 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: "var(--decision-block)", color: "var(--decision-block)", background: "color-mix(in srgb, var(--decision-block) 14%, transparent)" }}>
          {error}
        </p>
      )}

      {!snapshot && isPending && (
        <div className="flex items-center gap-2 py-6 text-xs" style={{ color: "var(--muted)" }}>
          <Spinner /> Asking the engine about each item…
        </div>
      )}

      {snapshot && (
        <>
          <div className="flex h-1.5 w-full overflow-hidden rounded-full" style={{ background: "var(--panel-border)" }}>
            {pct(snapshot.clearsValue) > 0 && (
              <div style={{ width: `${pct(snapshot.clearsValue)}%`, background: "var(--decision-allow)" }} />
            )}
            {pct(snapshot.needsApprovalValue) > 0 && (
              <div style={{ width: `${pct(snapshot.needsApprovalValue)}%`, background: "var(--decision-escalate)" }} />
            )}
            {pct(snapshot.refusedValue) > 0 && (
              <div style={{ width: `${pct(snapshot.refusedValue)}%`, background: "var(--decision-block)" }} />
            )}
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]" style={{ color: "var(--muted-2)" }}>
            <Tally label="clears now" value={snapshot.clearsValue} color="var(--decision-allow)" />
            <Tally label="needs approval" value={snapshot.needsApprovalValue} color="var(--decision-escalate)" />
            <Tally label="refused" value={snapshot.refusedValue} color="var(--decision-block)" />
            <span className="ml-auto">checked {relativeTime(snapshot.checkedAt)}</span>
          </div>

          <div className="mt-3 space-y-1.5">
            {snapshot.items.map((item) => {
              const meta = DECISION_META[item.decision];
              return (
                <div
                  key={item.sku}
                  className="flex items-start gap-2.5 rounded-lg px-2.5 py-2"
                  style={{ background: "var(--panel-2)" }}
                >
                  <span
                    className="mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide"
                    style={{ background: `${meta.color}26`, color: meta.color }}
                  >
                    {meta.label}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="truncate text-[12px] font-medium">{item.name}</p>
                      <p className="shrink-0 text-[12px] font-semibold tabular-nums">
                        {formatMoney(item.priceInPaise, "INR")}
                      </p>
                    </div>
                    {item.decision !== "allow" && (
                      <p className="mt-0.5 text-[10px] leading-snug" style={{ color: "var(--muted-2)" }}>
                        {item.reasoning}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </Panel>
  );
}

function Tally({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      <span className="font-semibold tabular-nums" style={{ color: "var(--foreground)" }}>
        {formatMoney(value, "INR")}
      </span>
      {label}
    </span>
  );
}
