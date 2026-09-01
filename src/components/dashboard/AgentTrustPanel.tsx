"use client";

import { useState } from "react";
import type { Agent } from "@/types/db";
import type { TrustComponents } from "@/lib/trust/score";
import { TrustBreakdown } from "./TrustBreakdown";
import { EmptyState, Icons, Panel } from "./ui";

function trustColor(score: number): string {
  if (score >= 70) return "var(--decision-allow)";
  if (score >= 40) return "var(--decision-escalate)";
  return "var(--decision-block)";
}

/**
 * The 3D graph encodes trust as glow size — real, but only readable by
 * hovering one node at a time. This is the same `trust_score` (see
 * src/lib/trust/score.ts), just as a flat, scannable list: every agent,
 * at a glance, without touching the graph.
 *
 * There is no "register an agent" control here. This deployment runs a single
 * agent, so a button minting credentials for a second one was a path to
 * nowhere — the mechanism still exists (an agent is just a row with a public
 * key; see src/lib/demo/shared.ts), it simply isn't a thing a merchant does
 * from this screen while there is one agent to manage.
 *
 * `className="h-full"` on Panel plus `flex-1` in DashboardTabs.tsx lets
 * this stretch to fill whatever's left in the Overview sidebar below
 * Escalations — the footer note is what actually occupies that space when
 * there are only one or two agents, not blank padding.
 */
export function AgentTrustPanel({ agents }: { agents: Agent[] }) {
  const sorted = [...agents].sort((a, b) => b.trust_score - a.trust_score);
  // One open at a time: the breakdown is detail-on-demand, and two expanded at
  // once in a sidebar this narrow just pushes everything out of view.
  const [expandedId, setExpandedId] = useState<string | null>(null);


  return (
    <Panel
      title="Agent trust"
      icon={<Icons.Sparkles />}
      accent="var(--entity-agent)"
      className="flex h-full flex-col"
    >
      <div className="flex flex-1 flex-col">

        {sorted.length === 0 ? (
          <EmptyState text="No agents yet — start the simulated agent to see one." />
        ) : (
          <div className="space-y-3">
            {sorted.map((agent) => {
              const color = trustColor(agent.trust_score);
              const components = agent.trust_components as TrustComponents | null;
              const expanded = expandedId === agent.id;
              // An agent that has never acted has nothing to explain — its score
              // is just the untouched starting value.
              const explainable = Boolean(components && components.totalDecisions > 0);

              return (
                <div key={agent.id}>
                  <button
                    onClick={() => setExpandedId(expanded ? null : agent.id)}
                    disabled={!explainable}
                    className="w-full text-left disabled:cursor-default"
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-[13px] font-medium">{agent.name}</span>
                        {explainable && (
                          <span
                            className="shrink-0 text-[9px] transition-transform"
                            style={{ color: "var(--muted-2)", transform: expanded ? "rotate(90deg)" : undefined }}
                          >
                            ▶
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 text-[12px] font-semibold tabular-nums" style={{ color }}>
                        {agent.trust_score.toFixed(0)}
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: "var(--panel-2)" }}>
                      <div
                        className="h-full rounded-full transition-all"
                        style={{ width: `${Math.max(0, Math.min(100, agent.trust_score))}%`, background: color }}
                      />
                    </div>
                  </button>

                  {expanded && components && <TrustBreakdown components={components} />}

                  {!explainable && (
                    <p className="mt-1 text-[10px]" style={{ color: "var(--muted-2)" }}>
                      No decisions yet — still at the starting score.
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <p className="mt-auto pt-4 text-[11px] leading-relaxed" style={{ color: "var(--muted-2)" }}>
          Starts at 50 for a new agent — moves up with clean approvals, down with blocks and
          escalations, and ticks up slowly with account age. The full formula and reasoning is
          always available via the <code>explain</code> tool.
        </p>
      </div>
    </Panel>
  );
}
