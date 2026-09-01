"use client";

import { useState } from "react";
import type { Agent, PolicyRule } from "@/types/db";
import type { TrustComponents } from "@/lib/trust/score";
import { TrustBreakdown } from "./TrustBreakdown";
import { EmptyState, Icons, Panel } from "./ui";

/** The bands the bar is coloured by. Named rather than numeric because a
 *  merchant reads "restricted", not "below 35" — and the labels say what the
 *  system will actually do, not just where the number sits. */
function standing(score: number, floor: number | null) {
  if (floor !== null && score < floor) {
    return { label: "Restricted", color: "var(--decision-block)", note: "held for approval at any amount" };
  }
  if (score >= 70) return { label: "Trusted", color: "var(--decision-allow)", note: "acting within policy" };
  if (score >= 50) return { label: "Established", color: "var(--entity-agent)", note: "acting within policy" };
  return { label: "Watch", color: "var(--decision-escalate)", note: "approaching the trust floor" };
}

/**
 * The 3D graph encodes trust as glow size — real, but only readable by
 * hovering one node at a time. This is the same `trust_score`
 * (src/lib/trust/score.ts) as a flat, scannable list.
 *
 * The bar carries a marker at whatever an active `trust_floor` rule is set to,
 * read from the live rule set rather than hardcoded. That is the whole point
 * of showing a score at all: on its own 69 means nothing, but 69 against a
 * floor of 35 says how much room this agent has before the engine starts
 * holding its actions. If no such rule is active the marker is simply absent —
 * there is then genuinely no threshold to be near.
 *
 * There is no "register an agent" control. This deployment runs a single
 * agent, so a button minting credentials for a second one was a path to
 * nowhere — the mechanism still exists (an agent is a row with a public key),
 * it just isn't something done from this screen.
 */
export function AgentTrustPanel({ agents, rules }: { agents: Agent[]; rules: PolicyRule[] }) {
  const sorted = [...agents].sort((a, b) => b.trust_score - a.trust_score);
  // One open at a time: the breakdown is detail-on-demand, and two expanded at
  // once in a column this narrow pushes everything out of view.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const trustFloor = (() => {
    const rule = rules.find((r) => r.type === "trust_floor" && r.status === "active");
    const min = (rule?.params as { min_score?: number } | null)?.min_score;
    return typeof min === "number" ? min : null;
  })();

  return (
    <Panel
      title="Agent trust"
      icon={<Icons.Sparkles />}
      accent="var(--entity-agent)"
      // Sizes to its content instead of claiming half the column: the agent
      // roster is small and stable, so a fixed share left a large void under
      // one card while the escalation queue above was scrolling. Capped so a
      // long roster still can't crowd out the queue.
      className="max-h-[55%] shrink-0"
      bodyClassName="flex flex-col overflow-y-auto pr-1"
    >
      {sorted.length === 0 ? (
        <EmptyState text="No agents yet — start the simulated agent to see one." />
      ) : (
        <div className="space-y-2.5">
          {sorted.map((agent) => {
            const components = agent.trust_components as TrustComponents | null;
            const expanded = expandedId === agent.id;
            // An agent that has never acted has nothing to explain — its score
            // is just the untouched starting value.
            const explainable = Boolean(components && components.totalDecisions > 0);
            const state = standing(agent.trust_score, trustFloor);
            const pct = Math.max(0, Math.min(100, agent.trust_score));

            return (
              <div
                key={agent.id}
                className="rounded-xl border p-3 transition-colors"
                style={{
                  borderColor: expanded ? "color-mix(in srgb, var(--entity-agent) 45%, transparent)" : "var(--panel-border)",
                  background: "var(--panel-2)",
                }}
              >
                <button
                  onClick={() => setExpandedId(expanded ? null : agent.id)}
                  disabled={!explainable}
                  className="w-full text-left disabled:cursor-default"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-semibold">{agent.name}</p>
                      <span
                        className="mt-1 inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider"
                        style={{ background: `color-mix(in srgb, ${state.color} 16%, transparent)`, color: state.color }}
                      >
                        <span className="h-1 w-1 rounded-full" style={{ background: state.color }} />
                        {state.label}
                      </span>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-[22px] font-semibold leading-none tabular-nums" style={{ color: state.color }}>
                        {agent.trust_score.toFixed(0)}
                      </p>
                      <p className="mt-1 text-[9px] uppercase tracking-wider" style={{ color: "var(--muted-2)" }}>
                        of 100
                      </p>
                    </div>
                  </div>

                  <div className="relative mt-2.5">
                    <div className="h-2 w-full overflow-hidden rounded-full" style={{ background: "var(--panel-border)" }}>
                      <div
                        className="h-full rounded-full transition-all duration-500"
                        style={{
                          width: `${pct}%`,
                          background: `linear-gradient(90deg, color-mix(in srgb, ${state.color} 55%, transparent), ${state.color})`,
                        }}
                      />
                    </div>
                    {trustFloor !== null && (
                      // The threshold the engine actually acts on, drawn where
                      // it falls on the same scale as the score above it.
                      <div
                        className="pointer-events-none absolute -top-0.5 h-3 w-px"
                        style={{ left: `${trustFloor}%`, background: "var(--decision-block)", opacity: 0.85 }}
                      />
                    )}
                  </div>

                  <div className="mt-1.5 flex items-center justify-between gap-2">
                    <p className="truncate text-[10px]" style={{ color: "var(--muted-2)" }}>
                      {state.note}
                    </p>
                    {trustFloor !== null && (
                      <p className="shrink-0 text-[10px] tabular-nums" style={{ color: "var(--muted-2)" }}>
                        floor {trustFloor}
                      </p>
                    )}
                  </div>

                  {explainable && components && (
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px]" style={{ color: "var(--muted-2)" }}>
                      <Stat value={components.approvals} label="allowed" color="var(--decision-allow)" />
                      <Stat value={components.escalations} label="escalated" color="var(--decision-escalate)" />
                      <Stat value={components.blocks} label="blocked" color="var(--decision-block)" />
                      <span className="ml-auto" style={{ color: "var(--muted-2)" }}>
                        {expanded ? "hide breakdown" : "why?"}
                      </span>
                    </div>
                  )}
                </button>

                {expanded && components && <TrustBreakdown components={components} />}

                {!explainable && (
                  <p className="mt-2 text-[10px]" style={{ color: "var(--muted-2)" }}>
                    No decisions yet — still at the starting score.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="mt-3 shrink-0 text-[10.5px] leading-relaxed" style={{ color: "var(--muted-2)" }}>
        Every agent starts at 50 and moves with its own recent record. Below the floor, its actions
        are held for a human regardless of amount.
      </p>
    </Panel>
  );
}

function Stat({ value, label, color }: { value?: number; label: string; color: string }) {
  if (typeof value !== "number") return null;
  return (
    <span className="flex items-center gap-1">
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      <span className="font-semibold tabular-nums" style={{ color: "var(--foreground)" }}>
        {value}
      </span>
      {label}
    </span>
  );
}
