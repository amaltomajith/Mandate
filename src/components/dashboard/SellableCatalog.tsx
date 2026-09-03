"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import {
  getSellableCatalog,
  listHeadroomAgents,
  type HeadroomAgent,
  type SellableItem,
  type SellableSnapshot,
} from "@/lib/actions/sellable";
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
 * Probing is free — nothing is written — so this costs no rate budget and moves
 * no money. It is the same check the agent runs before proposing an upsell,
 * pointed at the merchant instead.
 *
 * PER AGENT. It used to answer for the merchant's own identity whoever asked,
 * which made it render identically for every agent and made the headroom claim
 * false. Pick an agent and the same catalog is judged against that agent's
 * trust, its rate budget and its assigned catalog scope.
 */
export function SellableCatalog() {
  const [snapshot, setSnapshot] = useState<SellableSnapshot | null>(null);
  const [agents, setAgents] = useState<HeadroomAgent[]>([]);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const load = useCallback((forAgent?: string | null) => {
    setError(null);
    startTransition(async () => {
      try {
        setSnapshot(await getSellableCatalog(forAgent ?? undefined));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't check the catalog.");
      }
    });
  }, []);

  useEffect(() => {
    listHeadroomAgents()
      .then(setAgents)
      .catch(() => {
        /* the picker just stays empty; the default view still works */
      });
  }, []);

  // Loads once on open. Not on an interval: it costs a round trip per item and
  // nothing changes between renders unless a rule or the agent's standing
  // does. Deferred out of the commit phase rather than called directly —
  // starting a transition synchronously inside an effect cascades renders.
  useEffect(() => {
    const id = setTimeout(() => load(agentId), 0);
    return () => clearTimeout(id);
  }, [load, agentId]);

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
        <GhostButton onClick={() => load(agentId)} disabled={isPending} className="py-1! px-2.5! text-[10px]!">
          {isPending ? "Checking…" : "Re-check"}
        </GhostButton>
      }
    >
      <p className="mb-3 text-xs leading-relaxed" style={{ color: "var(--muted)" }}>
        Every item put to the policy engine as it stands right now, <em className="not-italic text-[var(--foreground)]">for one agent</em>.
        Same check the agent runs before proposing something — nothing is bought, and it costs no
        rate budget.
      </p>

      {agents.length > 1 && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {agents.map((a) => (
            <button
              key={a.id}
              onClick={() => setAgentId(a.id)}
              disabled={isPending}
              className="rounded-full border px-2.5 py-1 text-[10px] font-medium transition-colors hover:brightness-125 disabled:opacity-50"
              style={
                (agentId ?? snapshot?.agent?.id) === a.id
                  ? { background: "var(--entity-agent)", borderColor: "var(--entity-agent)", color: "#08080c" }
                  : { background: "transparent", borderColor: "var(--panel-border-strong)", color: "var(--muted)" }
              }
              title={
                a.catalogScope === null
                  ? "Full catalog"
                  : a.catalogScope.length === 0
                    ? "Scoped to nothing"
                    : `Scoped to ${a.catalogScope.join(", ")}`
              }
            >
              {a.name}
              {a.managed && " ·"}
            </button>
          ))}
        </div>
      )}

      {/* Said out loud, because a short list of verdicts is otherwise
          indistinguishable from a small catalog. NULL and an empty array both
          render as "no categories" and mean opposite things. */}
      {snapshot?.agent && (
        <p className="mb-3 text-[11px]" style={{ color: "var(--muted-2)" }}>
          {snapshot.agent.name} · trust {Math.round(snapshot.agent.trustScore)} ·{" "}
          {snapshot.agent.catalogScope === null
            ? "full catalog"
            : snapshot.agent.catalogScope.length === 0
              ? "scoped to no categories, so nothing here is sellable by it"
              : `scoped to ${snapshot.agent.catalogScope.join(", ")}`}
        </p>
      )}

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

