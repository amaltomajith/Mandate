"use client";

import { useState, useTransition } from "react";
import type { Agent, AgentRun } from "@/types/db";
import { setAgentStatus } from "@/lib/actions/agents";
import { EmptyState, GhostButton, Icons, Panel } from "./ui";
import { TimeAgo } from "./TimeAgo";

interface Props {
  agents: Agent[];
  runs: AgentRun[];
}

const KIND_LABEL: Record<Agent["kind"], string> = {
  selling: "Sells slow stock",
  buying: "Restocks bestsellers",
  external: "Outside agent",
};

/**
 * The merchant's autonomous team.
 *
 * Pausing an agent is enforced by the wall, not requested of the agent: a paused
 * agent's next action is blocked and recorded (see actionEvaluator.ts). That is
 * why the control sits here, one click from the money.
 */
export function AgentsPanel({ agents, runs }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const team = agents.filter((a) => !a.retired);

  function toggle(agent: Agent) {
    setError(null);
    startTransition(async () => {
      try {
        await setAgentStatus(agent.id, agent.status === "active" ? "paused" : "active");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't change that agent.");
      }
    });
  }

  return (
    <Panel title="Your team" icon={<Icons.Sparkles />} accent="var(--entity-agent)">
      {error && (
        <p className="mb-3 rounded-lg px-3 py-2 text-xs" style={{ background: "color-mix(in srgb, var(--decision-block) 14%, transparent)", color: "var(--decision-block)" }}>
          {error}
        </p>
      )}
      {team.length === 0 ? (
        <EmptyState text="No agents yet." />
      ) : (
        <ul className="divide-y" style={{ borderColor: "var(--panel-border)" }}>
          {team.map((agent) => {
            const last = runs.find((r) => r.agent_id === agent.id);
            const paused = agent.status === "paused";
            return (
              <li key={agent.id} className="flex flex-wrap items-center justify-between gap-3 py-3.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[13.5px] font-medium">{agent.name}</span>
                    <span
                      className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
                      style={{
                        background: paused ? "color-mix(in srgb, var(--decision-escalate) 18%, transparent)" : "color-mix(in srgb, var(--decision-allow) 16%, transparent)",
                        color: paused ? "var(--decision-escalate)" : "var(--decision-allow)",
                      }}
                    >
                      {paused ? "paused" : "working"}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs" style={{ color: "var(--muted)" }}>
                    {KIND_LABEL[agent.kind]} · trust {Math.round(agent.trust_score)}
                    {last && (
                      <>
                        {" "}· last run <TimeAgo iso={last.started_at} /> ({last.status})
                      </>
                    )}
                  </p>
                  {last?.summary && (
                    <p className="mt-1 max-w-xl text-xs" style={{ color: "var(--muted-2)" }}>
                      {last.summary}
                    </p>
                  )}
                </div>
                <GhostButton onClick={() => toggle(agent)} disabled={pending}>
                  {paused ? "Resume" : "Pause"}
                </GhostButton>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
