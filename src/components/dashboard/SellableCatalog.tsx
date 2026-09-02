"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { getSellableCatalog, type SellableItem, type SellableSnapshot } from "@/lib/actions/sellable";
import { formatMoney } from "@/lib/format";
import { GhostButton, Icons, Panel, Spinner, relativeTime } from "./ui";

const DECISION_META: Record<SellableItem["decision"], { label: string; color: string }> = {
  allow: { label: "Sells", color: "var(--decision-allow)" },
  escalate: { label: "Needs you", color: "var(--decision-escalate)" },
  block: { label: "Blocked", color: "var(--decision-block)" },
  unknown: { label: "Unknown", color: "var(--muted-2)" },
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

  // Counted, not summed. Adding up list prices produced a total of nothing in
  // particular — not revenue, not inventory, not anything a merchant could act
  // on — and "Rs 10,095 clears now" invites the question "Rs 10,095 of what?".
  // How many of your products the agent can sell unaided is a question with a
  // real answer.
  const counts = snapshot
    ? {
        sells: snapshot.items.filter((i) => i.decision === "allow").length,
        needsYou: snapshot.items.filter((i) => i.decision === "escalate").length,
        blocked: snapshot.items.filter((i) => i.decision === "block").length,
        unknown: snapshot.items.filter((i) => i.decision === "unknown").length,
      }
    : null;
  const total = snapshot?.items.length ?? 0;
  const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0);

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

      {snapshot && counts && (
        <>
          <p className="text-[13px] leading-relaxed">
            Your agent can sell{" "}
            <span className="font-semibold" style={{ color: "var(--decision-allow)" }}>
              {counts.sells} of {total}
            </span>{" "}
            products on its own.
            {counts.needsYou > 0 && (
              <>
                {" "}
                <span className="font-semibold" style={{ color: "var(--decision-escalate)" }}>
                  {counts.needsYou}
                </span>{" "}
                need{counts.needsYou === 1 ? "s" : ""} your approval first.
              </>
            )}
            {counts.unknown > 0 && (
              <>
                {" "}
                <span className="font-semibold" style={{ color: "var(--muted-2)" }}>
                  {counts.unknown}
                </span>{" "}
                couldn&apos;t be checked just now.
              </>
            )}
            {counts.blocked > 0 && (
              <>
                {" "}
                <span className="font-semibold" style={{ color: "var(--decision-block)" }}>
                  {counts.blocked}
                </span>{" "}
                {counts.blocked === 1 ? "is" : "are"} blocked outright.
              </>
            )}
          </p>

          <div className="mt-2.5 flex h-1.5 w-full overflow-hidden rounded-full" style={{ background: "var(--panel-border)" }}>
            {counts.sells > 0 && <div style={{ width: `${pct(counts.sells)}%`, background: "var(--decision-allow)" }} />}
            {counts.needsYou > 0 && <div style={{ width: `${pct(counts.needsYou)}%`, background: "var(--decision-escalate)" }} />}
            {counts.blocked > 0 && <div style={{ width: `${pct(counts.blocked)}%`, background: "var(--decision-block)" }} />}
            {counts.unknown > 0 && <div style={{ width: `${pct(counts.unknown)}%`, background: "var(--muted-2)" }} />}
          </div>

          <p className="mt-1.5 text-[10px]" style={{ color: "var(--muted-2)" }}>
            checked {relativeTime(snapshot.checkedAt)}
          </p>

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

