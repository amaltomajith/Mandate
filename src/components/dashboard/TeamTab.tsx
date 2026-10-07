"use client";

import type { Agent, PolicyRule } from "@/types/db";
import type { CooData } from "@/lib/cooData";
import { setDryRun, setTeamEnabled } from "@/lib/actions/team";
import { EmptyState, Icons, Panel } from "./ui";
import { ErrorLine, Pill, Table, useRunner } from "./kit";
import { TimeAgo } from "./TimeAgo";
import { AgentsPanel } from "./AgentsPanel";
import { AgentTrustPanel } from "./AgentTrustPanel";

/**
 * The autonomous team and the switches that stop it. The big one halts every
 * agent at the Payment Wall, not by asking the agents to stop.
 */
export function TeamTab({ coo, agents, rules }: { coo: CooData; agents: Agent[]; rules: PolicyRule[] }) {
  const { error, pending, run } = useRunner();
  const s = coo.settings;
  const on = s.agents_enabled;

  return (
    <div className="flex flex-col gap-5">
      <ErrorLine error={error} />

      <div
        className="panel-card flex flex-wrap items-center justify-between gap-4 rounded-2xl p-5"
        style={{ borderColor: on ? undefined : "var(--decision-block)" }}
      >
        <div className="max-w-xl">
          <p className="flex items-center gap-2 text-[15px] font-semibold">
            {on ? "Your team is on" : "Your team is switched off"}
            <Pill color={on ? "var(--decision-allow)" : "var(--decision-block)"}>{on ? "working" : "stopped"}</Pill>
          </p>
          <p className="mt-1 text-[13px]" style={{ color: "var(--muted)" }}>
            {on
              ? "Switching off blocks every action either agent proposes, at the Payment Wall. It does not rely on the agents stopping when asked."
              : "No agent action will go through, and the worker skips this account, until you switch it back on."}
          </p>
        </div>
        <button
          disabled={pending}
          onClick={() => run(() => setTeamEnabled(!on))}
          className="rounded-xl px-6 py-2.5 text-[13px] font-semibold text-white disabled:opacity-50"
          style={{ background: on ? "linear-gradient(135deg,#ef4444,#dc2626)" : "linear-gradient(135deg,#22c55e,#16a34a)" }}
        >
          {on ? "Switch the team off" : "Switch the team on"}
        </button>
      </div>

      <div className="panel-card flex flex-wrap items-center justify-between gap-4 rounded-2xl p-5">
        <div className="max-w-xl">
          <p className="flex items-center gap-2 text-[14px] font-semibold">
            Dry run
            <Pill color={s.dry_run ? "var(--decision-escalate)" : "var(--muted)"}>{s.dry_run ? "on" : "off"}</Pill>
          </p>
          <p className="mt-1 text-[13px]" style={{ color: "var(--muted)" }}>
            The team still thinks and proposes, and the wall still decides, but nothing is executed: no payout, no price change, no link. Use it to watch what it would do before trusting it.
          </p>
        </div>
        <button
          disabled={pending}
          onClick={() => run(() => setDryRun(!s.dry_run))}
          className="rounded-xl border px-5 py-2.5 text-[13px] font-semibold disabled:opacity-50"
          style={{ borderColor: "var(--panel-border-strong)" }}
        >
          {s.dry_run ? "Turn dry run off" : "Turn dry run on"}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <AgentsPanel agents={agents} runs={coo.runs} />
        <AgentTrustPanel agents={agents} rules={rules} />
      </div>

      <Panel title="Run history" icon={<Icons.Sparkles />} accent="var(--entity-mandate)" bodyClassName="max-h-[460px] overflow-y-auto">
        {coo.runs.length === 0 ? (
          <EmptyState text="The worker has not run yet." />
        ) : (
          <Table head={["Agent", "Result", "What happened", "When"]}>
            {coo.runs.map((r) => (
              <tr key={r.id}>
                <td className="px-2 py-2.5 text-[12.5px]">{r.kind === "buying" ? "Buying" : "Selling"}</td>
                <td className="px-2 py-2.5">
                  <Pill color={r.status === "ok" ? "var(--decision-allow)" : r.status === "error" ? "var(--decision-block)" : "var(--muted)"}>{r.status}</Pill>{" "}
                  {r.dry_run && <Pill color="var(--decision-escalate)">dry</Pill>}
                </td>
                <td className="max-w-xl px-2 py-2.5 text-[12px] leading-snug" style={{ color: "var(--muted)" }}>
                  {r.status === "error" ? r.error : r.summary}
                </td>
                <td className="px-2 py-2.5 text-[11px]" style={{ color: "var(--muted-2)" }}>
                  <TimeAgo iso={r.started_at} />
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </div>
  );
}
