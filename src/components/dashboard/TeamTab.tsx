"use client";

import { useState } from "react";
import { Power, TestTube } from "@phosphor-icons/react";
import type { Agent, PolicyRule } from "@/types/db";
import type { CooData } from "@/lib/cooData";
import { setDryRun, setTeamEnabled } from "@/lib/actions/team";
import { EmptyState, Icons, Panel } from "./ui";
import { ErrorLine, Pill, useRunner } from "./kit";
import { ConfirmSheet, Reveal } from "./motion";
import { TimeAgo } from "./TimeAgo";
import { AgentsPanel } from "./AgentsPanel";
import { AgentTrustPanel } from "./AgentTrustPanel";

/**
 * The autonomous team and the switches that stop it. The big one halts every
 * agent at the Payment Wall, not by asking the agents to stop.
 */
export function TeamTab({ coo, agents, rules }: { coo: CooData; agents: Agent[]; rules: PolicyRule[] }) {
  const { error, pending, run } = useRunner();
  const [confirmOff, setConfirmOff] = useState(false);
  const s = coo.settings;
  const on = s.agents_enabled;

  return (
    <div className="flex flex-col gap-8">
      <ErrorLine error={error} />

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Reveal index={0} className="h-full">
          <div className="surface flex h-full flex-col justify-between gap-6 p-7" style={{ borderColor: on ? undefined : "var(--decision-block)" }}>
            <div className="flex items-start gap-4">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[14px]" style={{ background: `color-mix(in srgb, ${on ? "var(--decision-allow)" : "var(--decision-block)"} 16%, transparent)`, color: on ? "var(--decision-allow)" : "var(--decision-block)" }}>
                <Power size={26} weight="bold" />
              </span>
              <div>
                <p className="flex items-center gap-3 text-[19px] font-semibold tracking-[-0.01em]">
                  {on ? "Your team is on" : "Your team is switched off"}
                  <Pill color={on ? "var(--decision-allow)" : "var(--decision-block)"}>{on ? "Working" : "Stopped"}</Pill>
                </p>
                <p className="mt-2 text-[15px] leading-6" style={{ color: "var(--muted)" }}>
                  {on
                    ? "Switching off blocks every action either agent proposes, at the Payment Wall. It does not rely on the agents stopping when asked."
                    : "No agent action will go through, and the worker skips this account, until you switch it back on."}
                </p>
              </div>
            </div>
            <button
              type="button"
              disabled={pending}
              onClick={() => (on ? setConfirmOff(true) : run(() => setTeamEnabled(true)))}
              className="focus-ring min-h-[48px] rounded-[12px] px-6 text-[15px] font-semibold text-white transition-transform active:scale-[0.97] disabled:opacity-50"
              style={{ background: on ? "linear-gradient(135deg,#ef4444,#dc2626)" : "linear-gradient(135deg,#22c55e,#16a34a)" }}
            >
              {on ? "Switch the team off" : "Switch the team on"}
            </button>
          </div>
        </Reveal>

        <Reveal index={1} className="h-full">
          <div className="surface flex h-full flex-col justify-between gap-6 p-7">
            <div className="flex items-start gap-4">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[14px]" style={{ background: "color-mix(in srgb, var(--decision-escalate) 16%, transparent)", color: "var(--decision-escalate)" }}>
                <TestTube size={26} weight="bold" />
              </span>
              <div>
                <p className="flex items-center gap-3 text-[19px] font-semibold tracking-[-0.01em]">
                  Dry run
                  <Pill color={s.dry_run ? "var(--decision-escalate)" : "var(--muted)"}>{s.dry_run ? "On" : "Off"}</Pill>
                </p>
                <p className="mt-2 text-[15px] leading-6" style={{ color: "var(--muted)" }}>
                  The team still thinks and proposes, and the wall still decides, but nothing is executed: no payout, no price change, no link. Use it to watch what it would do before trusting it.
                </p>
              </div>
            </div>
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => setDryRun(!s.dry_run))}
              className="focus-ring min-h-[48px] rounded-[12px] border px-6 text-[15px] font-semibold transition-colors hover:bg-white/[0.06] active:scale-[0.97] disabled:opacity-50"
              style={{ borderColor: "var(--hairline-strong)" }}
            >
              {s.dry_run ? "Turn dry run off" : "Turn dry run on"}
            </button>
          </div>
        </Reveal>
      </section>

      <AgentsPanel agents={agents} runs={coo.runs} />

      <AgentTrustPanel agents={agents} rules={rules} />

      <Panel title="Run history" description="Every pass the worker has made." icon={<Icons.Sparkles />} accent="var(--entity-mandate)" bodyClassName="max-h-[640px] overflow-y-auto fade-mask-y">
        {coo.runs.length === 0 ? (
          <EmptyState text="The worker has not run yet." hint="Start it with npm run worker." />
        ) : (
          <ul className="divide-y" style={{ borderColor: "var(--hairline)" }}>
            {coo.runs.map((r) => (
              <li key={r.id} className="grid grid-cols-[auto_1fr_auto] items-start gap-4 py-4">
                <span className="w-24 text-[15px] font-medium">{r.kind === "buying" ? "Buying" : "Selling"}</span>
                <div className="min-w-0">
                  <div className="mb-1 flex flex-wrap gap-2">
                    <Pill color={r.status === "ok" ? "var(--decision-allow)" : r.status === "error" ? "var(--decision-block)" : "var(--muted)"}>{r.status === "ok" ? "Done" : r.status}</Pill>
                    {r.dry_run && <Pill color="var(--decision-escalate)">Dry run</Pill>}
                  </div>
                  <p className="text-[14px] leading-6" style={{ color: r.status === "error" ? "var(--decision-block)" : "var(--muted)" }}>
                    {r.status === "error" ? r.error : r.summary}
                  </p>
                </div>
                <span className="text-[13px]" style={{ color: "var(--muted-2)" }}>
                  <TimeAgo iso={r.started_at} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <ConfirmSheet
        open={confirmOff}
        danger
        title="Switch the team off?"
        body="Every action either agent proposes will be blocked at the Payment Wall until you switch the team back on. Nothing in flight is undone."
        confirmLabel="Switch off"
        onClose={() => setConfirmOff(false)}
        onConfirm={() => run(() => setTeamEnabled(false))}
      />
    </div>
  );
}
