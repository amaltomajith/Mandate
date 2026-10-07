"use client";

import { useState, useTransition } from "react";
import { Pause, Play, ShoppingCartSimple, Tag } from "@phosphor-icons/react";
import type { Agent, AgentRun } from "@/types/db";
import { setAgentStatus } from "@/lib/actions/agents";
import { EmptyState, GhostButton, PrimaryButton } from "./ui";
import { ErrorLine } from "./kit";
import { ProgressRing, Reveal } from "./motion";
import { TimeAgo } from "./TimeAgo";

interface Props {
  agents: Agent[];
  runs: AgentRun[];
}

const KIND: Record<Agent["kind"], { label: string; job: string }> = {
  selling: { label: "Selling agent", job: "Clears slow stock down a margin-safe ladder and answers buyers." },
  buying: { label: "Buying agent", job: "Spots bestsellers running out, gets quotes, and orders." },
  external: { label: "Outside agent", job: "An agent that is not run by Mandate." },
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

  if (team.length === 0) return <EmptyState text="No agents yet." />;

  return (
    <div>
      <ErrorLine error={error} />
      <div className="grid gap-6 lg:grid-cols-2">
        {team.map((agent, idx) => {
          const last = runs.find((r) => r.agent_id === agent.id);
          const paused = agent.status === "paused";
          const trust = Math.max(0, Math.min(100, agent.trust_score));
          const trustColor = trust >= 70 ? "var(--decision-allow)" : trust >= 40 ? "var(--decision-escalate)" : "var(--decision-block)";
          const meta = KIND[agent.kind];
          const Icon = agent.kind === "buying" ? ShoppingCartSimple : Tag;
          return (
            <Reveal key={agent.id} index={idx} className="h-full">
              <section className="surface flex h-full flex-col p-7">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-4">
                    <span className="flex h-14 w-14 items-center justify-center rounded-[16px]" style={{ background: "color-mix(in srgb, var(--entity-agent) 18%, transparent)", color: "var(--entity-agent)" }}>
                      <Icon size={28} weight="fill" />
                    </span>
                    <div>
                      <p className="text-[19px] font-semibold tracking-[-0.01em]">{agent.name}</p>
                      <p className="mt-0.5 flex items-center gap-2 text-[14px]" style={{ color: paused ? "var(--decision-escalate)" : "var(--decision-allow)" }}>
                        <span className={paused ? "h-2 w-2 rounded-full" : "live-dot h-2 w-2 rounded-full"} style={{ background: "currentColor" }} />
                        {paused ? "Paused" : "Working"}
                      </p>
                    </div>
                  </div>
                  <ProgressRing value={trust / 100} size={64} stroke={6} color={trustColor}>
                    <span className="num text-[16px] font-semibold">{Math.round(trust)}</span>
                  </ProgressRing>
                </div>

                <p className="mt-5 text-[15px] leading-6" style={{ color: "var(--muted)" }}>
                  {meta.job}
                </p>

                <div className="mt-5 rounded-[14px] bg-white/[0.04] px-5 py-4">
                  <p className="text-[13px]" style={{ color: "var(--muted-2)" }}>
                    {last ? (
                      <>
                        Last run <TimeAgo iso={last.started_at} />, {last.status === "ok" ? "finished fine" : last.status}
                      </>
                    ) : (
                      "Has not run yet"
                    )}
                  </p>
                  {last?.summary && (
                    <p className="mt-1.5 line-clamp-3 text-[14px] leading-6" style={{ color: "var(--muted)" }}>
                      {last.summary}
                    </p>
                  )}
                </div>

                <div className="mt-auto pt-6">
                  {paused ? (
                    <PrimaryButton onClick={() => toggle(agent)} disabled={pending} className="w-full">
                      <Play size={18} weight="fill" /> Resume {agent.name}
                    </PrimaryButton>
                  ) : (
                    <GhostButton onClick={() => toggle(agent)} disabled={pending} className="w-full">
                      <Pause size={18} weight="fill" /> Pause {agent.name}
                    </GhostButton>
                  )}
                  <p className="mt-3 text-[13px] leading-5" style={{ color: "var(--muted-2)" }}>
                    The ring is trust. Pausing is enforced at the Payment Wall.
                  </p>
                </div>
              </section>
            </Reveal>
          );
        })}
      </div>
    </div>
  );
}
