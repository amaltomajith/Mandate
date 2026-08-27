"use client";

import type { Agent } from "@/types/db";
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
 * `className="h-full"` on Panel plus `flex-1` here lets this stretch to
 * fill whatever's left in the Overview sidebar below Escalations, instead
 * of leaving a bare gap under a short list — the footer note (real
 * information about how the score works, not decorative filler) is what
 * actually occupies that space when there are only one or two agents.
 */
export function AgentTrustPanel({ agents }: { agents: Agent[] }) {
  const sorted = [...agents].sort((a, b) => b.trust_score - a.trust_score);

  return (
    <Panel title="Agent trust" icon={<Icons.Sparkles />} accent="var(--entity-agent)" className="flex h-full flex-col">
      <div className="flex flex-1 flex-col">
        {sorted.length === 0 ? (
          <EmptyState text="No agents yet — click Run demo to register one." />
        ) : (
          <div className="space-y-3">
            {sorted.map((agent) => {
              const color = trustColor(agent.trust_score);
              return (
                <div key={agent.id}>
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="truncate text-[13px] font-medium">{agent.name}</span>
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
