"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import type { Agent, Mandate, PolicyRule } from "@/types/db";
import type { TrustComponents, TrustTrajectoryPoint } from "@/lib/trust/score";
import {
  agentActivity,
  agentSpec,
  agentTrustTrajectory,
  deleteAgent,
  exportAgent,
  registerAgent,
  setAgentCatalogScope,
  setAgentRetired,
  setAgentPace,
  setAgentStatus,
  type AgentActivity } from "@/lib/actions/agents";
import type { AgentSpec } from "@/lib/agentSpec";
import { pauseMandate, revokeMandate, reactivateMandate } from "@/lib/actions/mandates";
import { formatMoney } from "@/lib/format";
import { PRODUCT_CATEGORIES } from "@/lib/demo/catalog";
import { TrustBreakdown } from "./TrustBreakdown";
import { EmptyState, GhostButton, Icons, Panel, PrimaryButton, Spinner } from "./ui";
import { TimeAgo } from "./TimeAgo";
import { AnimatedLineChart } from "./charts/AnimatedLineChart";

const PACE_OPTIONS = [
  { label: "Calm", ms: 60_000 },
  { label: "Steady", ms: 30_000 },
  { label: "Brisk", ms: 10_000 },
  { label: "No limit", ms: 0 },
];

interface Props {
  agents: Agent[];
  rules: PolicyRule[];
  mandates: Mandate[];
}

/**
 * The agent roster, and the two different ways to stop one.
 *
 * The distinction this page exists to make legible:
 *
 *   Pausing the AGENT is COOPERATIVE. It changes what the agent is told when it
 *   polls /agent-control, and a well-behaved agent stops. It saves that agent's
 *   tokens and keeps this trace log clean. It does not refuse anything.
 *
 *   Pausing or revoking a MANDATE is ENFORCED. It runs inside the request path,
 *   before the policy engine, and it does not care whether the agent cooperates.
 *
 * Presenting them as one control would be the worst kind of interface bug here
 * — a merchant reaching for "stop" during an incident has to know which of
 * those two they just got, because one of them a hostile agent can ignore.
 */
export function AgentsPanel({ agents, rules, mandates }: Props) {
  const [activity, setActivity] = useState<AgentActivity[]>([]);
  const [spec, setSpec] = useState<AgentSpec | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // `managed` is the merchant's own traffic generator; everything else was
  // registered by a third party who holds their own key.
  //
  // Retired agents are hidden HERE and in the graph, and nowhere else. The
  // agents array itself still carries them, because TransactionsView builds its
  // agent-name map from that same array -- filter them out upstream and every
  // trace a retired agent ever produced starts rendering "Unknown agent",
  // which is losing the history by a slower route than deleting it.
  const live = agents.filter((a) => !a.retired);
  const managed = live.filter((a) => a.managed);
  const thirdParty = live.filter((a) => !a.managed);
  const retiredCount = agents.length - live.length;

  const trustFloor = (() => {
    const rule = rules.find((r) => r.type === "trust_floor" && r.status === "active");
    const params = rule?.params as { min_score?: number } | null;
    return typeof params?.min_score === "number" ? params.min_score : null;
  })();

  const refresh = useCallback(() => {
    startTransition(async () => {
      try {
        const [act, sp] = await Promise.all([agentActivity(), agentSpec()]);
        setActivity(act);
        setSpec(sp);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't load agent activity.");
      }
    });
  }, []);

  useEffect(() => {
    const id = setTimeout(refresh, 0);
    return () => clearTimeout(id);
  }, [refresh]);

  function run(fn: () => Promise<unknown>) {
    setError(null);
    startTransition(async () => {
      try {
        await fn();
        setActivity(await agentActivity());
      } catch (err) {
        setError(err instanceof Error ? err.message : "That didn't work.");
      }
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Panel title="Agents" icon={<Icons.Shield />} accent="var(--entity-agent)">
          {error && (
            <p
              className="mb-3 rounded-lg border px-3 py-2 text-xs"
              style={{
                borderColor: "var(--decision-block)",
                color: "var(--decision-block)",
                background: "color-mix(in srgb, var(--decision-block) 14%, transparent)",
              }}
            >
              {error}
            </p>
          )}

          {/* Third-party agents first, and alone in the primary list. Mandate's
              own traffic generator used to sit among them looking like a fourth
              customer of the platform, which quietly overstates how many
              parties are actually integrated. */}
          {thirdParty.length === 0 ? (
            <EmptyState text="No third-party agents registered yet. Register one below." />
          ) : (
            <div className="space-y-3">
              {thirdParty.map((agent) => (
                <AgentRow
                  key={agent.id}
                  agent={agent}
                  trustFloor={trustFloor}
                  activity={activity.find((a) => a.agentId === agent.id)}
                  mandates={mandates.filter((m) => m.agent_id === agent.id)}
                  busy={isPending}
                  onRun={run}
                />
              ))}
            </div>
          )}

          {retiredCount > 0 && (
            <p className="mt-4 text-[10.5px]" style={{ color: "var(--muted-2)" }}>
              {retiredCount} retired agent{retiredCount === 1 ? "" : "s"} hidden. Their keys no longer
              verify, and their past actions still appear in Transactions under their own names.
            </p>
          )}

          {managed.length > 0 && (
            <div className="mt-5 border-t pt-4" style={{ borderColor: "var(--panel-border)" }}>
              <p
                className="text-[9.5px] font-semibold uppercase tracking-wider"
                style={{ color: "var(--muted-2)" }}
              >
                Mandate&rsquo;s own traffic generator
              </p>
              <p className="mt-1 mb-3 text-[10.5px] leading-relaxed" style={{ color: "var(--muted-2)" }}>
                Not a third party. This is the merchant-side simulation, signing with a key this
                deployment holds. It produces the ordinary, high-value, banned-category and forged
                requests — a real buyer never forges its own signature, so this is where the
                protocol-reject evidence comes from.
              </p>
              <div className="space-y-3">
                {managed.map((agent) => (
                  <AgentRow
                    key={agent.id}
                    agent={agent}
                    trustFloor={trustFloor}
                    activity={activity.find((a) => a.agentId === agent.id)}
                    mandates={mandates.filter((m) => m.agent_id === agent.id)}
                    busy={isPending}
                    onRun={run}
                  />
                ))}
              </div>
            </div>
          )}
        </Panel>

        <RegisterAgent onError={setError} onRegistered={refresh} />
      </div>

      {/* Full width, not a sidebar rail. This is the most distinctive artifact
          in the product -- the thing that says what it takes to talk to this
          merchant -- and it was set at ten pixels in a 420px column, which is
          unreadable across a room. */}
      <CompatibilityContract spec={spec} />
    </div>
  );
}

function AgentRow({
  agent,
  trustFloor,
  activity,
  mandates,
  busy,
  onRun,
}: {
  agent: Agent;
  trustFloor: number | null;
  activity?: AgentActivity;
  mandates: Mandate[];
  busy: boolean;
  onRun: (fn: () => Promise<unknown>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [trajectory, setTrajectory] = useState<TrustTrajectoryPoint[] | null>(null);

  // Lazy, on first expand — not on mount for every row in the roster. A
  // trajectory fetch replays this agent's whole enforce history through the
  // same formula recomputeTrust runs live (see computeTrustTrajectory), which
  // is cheap for one agent and wasteful to run for every row before anyone
  // has asked to see it.
  useEffect(() => {
    if (!open || trajectory !== null) return;
    agentTrustTrajectory(agent.id)
      .then(setTrajectory)
      .catch(() => setTrajectory([]));
  }, [open, trajectory, agent.id]);

  const paused = agent.status === "paused";
  const components = agent.trust_components as unknown as TrustComponents | null;
  const restricted = trustFloor !== null && agent.trust_score < trustFloor;
  // Computed server-side (Date.now() during render is impure). Only meaningful
  // for an agent that was asked to work -- a paused one being quiet is it
  // complying, not it stuck.
  const stale = activity?.stale === true;

  const liveMandates = mandates.filter((m) => m.status === "active");
  const heldMandates = mandates.filter((m) => m.status === "paused");

  return (
    <div
      className="rounded-xl border p-3"
      style={{ borderColor: "var(--panel-border)", background: "var(--panel-2)", opacity: busy ? 0.7 : 1 }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold">{agent.name}</p>
          <p className="mt-0.5 truncate text-[10.5px]" style={{ color: "var(--muted-2)" }}>
            {agent.persona ?? agent.description ?? "no description"}
          </p>
          <p className="mt-1 font-mono text-[9.5px]" style={{ color: "var(--muted-2)" }}>
            {agent.id}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p
            className="text-[17px] font-semibold tabular-nums"
            style={{ color: restricted ? "var(--decision-block)" : "var(--foreground)" }}
          >
            {agent.trust_score.toFixed(0)}
          </p>
          <p className="text-[9.5px]" style={{ color: "var(--muted-2)" }}>
            trust
          </p>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px]" style={{ color: "var(--muted-2)" }}>
        {/* Cooperative status is what the merchant ASKED FOR; liveness is
            whether the agent is doing it. Showing only the first made
            "working · last seen 13m ago" read as a contradiction, when in fact
            it was two different facts sitting next to each other. */}
        <span style={{ color: paused ? "var(--decision-escalate)" : "var(--decision-allow)" }}>
          {paused ? "asked to pause" : "asked to work"}
        </span>
        <span>pace {agent.pace_ms === 0 ? "unlimited" : `${Math.round(agent.pace_ms / 1000)}s`}</span>
        {/* "never deployed" rather than "last seen never". A registered agent
            that has not run has no history, and saying so plainly is the honest
            display -- the old wording read like a fault in the dashboard. */}
        <span style={{ color: stale ? "var(--decision-escalate)" : undefined }}>
          {activity?.lastSeen ? (
            <>
              {stale && !paused ? "not acting · " : ""}
              last seen <TimeAgo iso={activity.lastSeen} />
            </>
          ) : (
            "never deployed"
          )}
        </span>
        {restricted && <span style={{ color: "var(--decision-block)" }}>below the trust floor</span>}
      </div>

      {/* --- The two controls, kept visibly apart because they guarantee
              different things. --- */}
      <div className="mt-3 space-y-2">
        <div className="rounded-lg border p-2" style={{ borderColor: "color-mix(in srgb, var(--entity-agent) 30%, transparent)" }}>
          <p className="text-[9.5px] font-semibold uppercase tracking-wider" style={{ color: "var(--entity-agent)" }}>
            Cooperative — the agent complies
          </p>
          <p className="mt-0.5 text-[10px] leading-snug" style={{ color: "var(--muted-2)" }}>
            Changes what this agent is told when it asks whether to work. It saves the agent&apos;s tokens
            and keeps your log clean. It does <strong>not</strong> refuse anything: an agent that ignores
            it still gets judged on the merits, exactly as before.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <GhostButton
              onClick={() => onRun(() => setAgentStatus(agent.id, paused ? "active" : "paused"))}
              disabled={busy}
              className="py-1! px-2.5! text-[10px]!"
            >
              {paused ? "Ask it to resume" : "Ask it to pause"}
            </GhostButton>
            {PACE_OPTIONS.map((p) => (
              <button
                key={p.label}
                onClick={() => onRun(() => setAgentPace(agent.id, p.ms))}
                disabled={busy}
                className="rounded-full border px-2 py-1 text-[10px] font-medium transition-colors hover:brightness-125 disabled:opacity-50"
                /* Inactive pills used to be --muted-2 text on transparent over
                   --panel-2, which is barely above the background: the labels
                   were there, just invisible, so the row read as one selected
                   pill and three blanks. They now carry the same border and
                   readable foreground as any other control, and selection is
                   shown by the fill rather than by being the only legible one. */
                style={
                  agent.pace_ms === p.ms
                    ? { background: "var(--entity-agent)", borderColor: "var(--entity-agent)", color: "#08080c" }
                    : { background: "transparent", borderColor: "var(--panel-border-strong)", color: "var(--muted)" }
                }
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-lg border p-2" style={{ borderColor: "color-mix(in srgb, var(--decision-block) 30%, transparent)" }}>
          <p className="text-[9.5px] font-semibold uppercase tracking-wider" style={{ color: "var(--decision-block)" }}>
            Enforced — the gate refuses
          </p>
          <p className="mt-0.5 text-[10px] leading-snug" style={{ color: "var(--muted-2)" }}>
            Runs before the policy engine and does not need the agent&apos;s cooperation. This is what to
            use when you do not trust it to stop on its own.
          </p>
          {mandates.length === 0 ? (
            <p className="mt-1.5 text-[10px]" style={{ color: "var(--muted-2)" }}>
              No mandates — this agent has no standing authorization to withdraw.
            </p>
          ) : (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-[10px]" style={{ color: "var(--muted-2)" }}>
                {liveMandates.length} active, {heldMandates.length} held
              </span>
              {liveMandates.length > 0 && (
                <GhostButton
                  onClick={() => onRun(async () => Promise.all(liveMandates.map((m) => pauseMandate(m.id))))}
                  disabled={busy}
                  className="py-1! px-2.5! text-[10px]!"
                >
                  Hold all mandates
                </GhostButton>
              )}
              {heldMandates.length > 0 && (
                <GhostButton
                  onClick={() => onRun(async () => Promise.all(heldMandates.map((m) => reactivateMandate(m.id))))}
                  disabled={busy}
                  className="py-1! px-2.5! text-[10px]!"
                >
                  Release held
                </GhostButton>
              )}
              {liveMandates.length > 0 && (
                <GhostButton
                  onClick={() => {
                    if (confirm("Revoking is permanent. The agent would need a fresh mandate. Continue?")) {
                      onRun(async () => Promise.all(liveMandates.map((m) => revokeMandate(m.id))));
                    }
                  }}
                  disabled={busy}
                  className="py-1! px-2.5! text-[10px]!"
                >
                  Revoke all
                </GhostButton>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <GhostButton onClick={() => setOpen((o) => !o)} className="py-1! px-2.5! text-[10px]!">
          {open ? "Hide detail" : "Trust & recent actions"}
        </GhostButton>
        <GhostButton
          onClick={() =>
            onRun(async () => {
              const definition = await exportAgent(agent.id);
              await navigator.clipboard.writeText(JSON.stringify(definition, null, 2));
            })
          }
          disabled={busy}
          className="py-1! px-2.5! text-[10px]!"
        >
          Copy definition
        </GhostButton>
      </div>

      {open && (
        <div className="mt-2 border-t pt-2" style={{ borderColor: "var(--panel-border)" }}>
          {components && <TrustBreakdown components={components} />}

          {/* The number next to this line only ever shows today. Replayed
              from the same trace history and the same formula, so the curve
              can never disagree with the score printed above it — see
              agentTrustTrajectory / computeTrustTrajectory. */}
          <div className="mt-3 border-t pt-2.5" style={{ borderColor: "var(--panel-border)" }}>
            <p className="mb-1.5 text-[9.5px] font-semibold uppercase tracking-wider" style={{ color: "var(--muted-2)" }}>
              Trust over time
            </p>
            {trajectory === null ? (
              <div className="flex h-[120px] items-center justify-center text-[10.5px]" style={{ color: "var(--muted-2)" }}>
                Loading history…
              </div>
            ) : trajectory.length < 2 ? (
              <p className="py-3 text-center text-[10.5px]" style={{ color: "var(--muted-2)" }}>
                Not enough history yet for a trend — one point isn&rsquo;t a line.
              </p>
            ) : (
              <AnimatedLineChart
                data={trajectory.map((p) => ({
                  label: new Date(p.at).toLocaleDateString("en-IN", { month: "short", day: "numeric" }),
                  value: p.score,
                }))}
                color="var(--entity-agent)"
                height={120}
                valueFormatter={(v) => v.toFixed(0)}
                thresholdLine={trustFloor !== null ? { value: trustFloor, label: `floor ${trustFloor}` } : undefined}
                // Trust is a 0-100 score; the axis floor should never read
                // negative for the same reason the revenue curve shouldn't.
                clampMin={0}
              />
            )}
          </div>

          <CatalogScope agent={agent} busy={busy} onRun={onRun} />

          <div className="mt-3 flex items-center gap-1.5 border-t pt-2.5" style={{ borderColor: "var(--panel-border)" }}>
            <GhostButton
              disabled={busy}
              className="px-2! py-1! text-[10px]!"
              onClick={() => {
                const ok = window.confirm(
                  `Retire ${agent.name}?

` +
                    `Its key stops verifying immediately — requests are refused before any policy runs, ` +
                    `whether it cooperates or not. It disappears from this roster and from the graph.

` +
                    `Nothing is lost: everything it has already done stays in Transactions under its name. ` +
                    `You can bring it back.`
                );
                if (ok) onRun(() => setAgentRetired(agent.id, true));
              }}
            >
              Retire
            </GhostButton>

            {/* Offered only when it is genuinely safe. A delete button that
                usually errors is worse than no delete button -- same rule the
                product row follows. */}
            {activity && activity.totalRequests === 0 && !agent.managed && (
              <GhostButton
                disabled={busy}
                className="px-2! py-1! text-[10px]!"
                onClick={() => {
                  const ok = window.confirm(
                    `Delete ${agent.name} permanently?

` +
                      `It has never made a request, so there is no history to lose. ` +
                      `An agent that has acted cannot be deleted — retire it instead.`
                  );
                  if (ok) onRun(() => deleteAgent(agent.id));
                }}
              >
                Delete
              </GhostButton>
            )}
          </div>
          <p className="mt-2 text-[9.5px] font-semibold uppercase tracking-wider" style={{ color: "var(--muted-2)" }}>
            Recent actions, and what it said about them
          </p>
          {!activity?.recent.length ? (
            <p className="mt-1 text-[10.5px]" style={{ color: "var(--muted-2)" }}>
              {/* Three states, said out loud. "Nothing yet" used to cover both
                  "never called" and "called, but never moved money", which are
                  different facts about whether an integration is working. */}
              {activity && activity.totalRequests > 0
                ? `Connected, but no money actions yet — ${activity.totalRequests} request${
                    activity.totalRequests === 1 ? "" : "s"
                  }, all headroom checks.`
                : "Never called. Registered, but this agent has not run."}
            </p>
          ) : (
            <div className="mt-1 space-y-1">
              {activity.recent.map((r) => (
                <div key={r.traceId} className="rounded px-2 py-1.5" style={{ background: "var(--panel-2)" }}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[10.5px] font-medium">{r.decision}</span>
                    <span className="text-[10.5px] tabular-nums" style={{ color: "var(--muted-2)" }}>
                      {r.amountPaise !== null ? formatMoney(r.amountPaise, "INR") : ""}
                    </span>
                  </div>
                  {/* The agent's own words. Sanitised at write time, not just
                      escaped at render — see safeAgentReason. */}
                  {r.agentReason && (
                    <p className="mt-0.5 text-[10px] italic" style={{ color: "var(--muted)" }}>
                      &ldquo;{r.agentReason}&rdquo;
                    </p>
                  )}
                  <p className="mt-0.5 text-[9.5px]" style={{ color: "var(--muted-2)" }}>
                    {r.reasoning}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Owns its own submit state rather than reading the panel's shared `isPending`.
 *
 * Two problems with sharing it. The transition covered `registerAgent`, which
 * ends in `revalidatePath("/dashboard")` -- so the pending flag stayed true
 * through a full re-render of a force-dynamic page that queries ten tables, and
 * the button sat spinning long after the agent had been created. And because
 * the flag was shared, nudging a pace pill anywhere in the roster spun the
 * Register button too, which is a claim about the wrong thing entirely.
 *
 * Local state clears the moment the call returns, which is when registration is
 * actually finished. Refreshing the roster afterwards is a separate concern and
 * is allowed to take as long as it takes.
 */
function RegisterAgent({
  onError,
  onRegistered,
}: {
  onError: (message: string | null) => void;
  onRegistered: () => void;
}) {
  const [name, setName] = useState("");
  const [persona, setPersona] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [endpointUrl, setEndpointUrl] = useState("");
  const [registered, setRegistered] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  return (
    <Panel title="Register an agent" icon={<Icons.Sparkles />} accent="var(--decision-allow)">
      <p className="mb-3 text-xs leading-relaxed" style={{ color: "var(--muted)" }}>
        An agent generates its own keypair and gives you the <strong>public</strong> half. You register
        it and hand back the id it signs with — there is no API key here, and no way for an agent to
        register itself.
      </p>

      <div className="space-y-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name — e.g. Procurement Buyer"
          className="w-full rounded-lg border px-3 py-2 text-sm outline-none"
          style={{ borderColor: "var(--panel-border)", background: "var(--panel-2)", color: "var(--foreground)" }}
        />
        <input
          value={persona}
          onChange={(e) => setPersona(e.target.value)}
          placeholder="What is it for? — e.g. buys office supplies under ₹15,000"
          className="w-full rounded-lg border px-3 py-2 text-sm outline-none"
          style={{ borderColor: "var(--panel-border)", background: "var(--panel-2)", color: "var(--foreground)" }}
        />
        <input
          value={publicKey}
          onChange={(e) => setPublicKey(e.target.value)}
          placeholder="Ed25519 public key (base64, 32 bytes)"
          className="w-full rounded-lg border px-3 py-2 font-mono text-[11px] outline-none"
          style={{ borderColor: "var(--panel-border)", background: "var(--panel-2)", color: "var(--foreground)" }}
        />
        <input
          value={endpointUrl}
          onChange={(e) => setEndpointUrl(e.target.value)}
          placeholder="Where it runs (optional, for your reference only)"
          className="w-full rounded-lg border px-3 py-2 text-sm outline-none"
          style={{ borderColor: "var(--panel-border)", background: "var(--panel-2)", color: "var(--foreground)" }}
        />
      </div>

      <PrimaryButton
        onClick={async () => {
          onError(null);
          setSubmitting(true);
          try {
            const agent = await registerAgent({ name, persona, publicKey, endpointUrl });
            setRegistered(agent.id);
            setName("");
            setPersona("");
            setPublicKey("");
            setEndpointUrl("");
            onRegistered();
          } catch (err) {
            onError(err instanceof Error ? err.message : "That didn't work.");
          } finally {
            setSubmitting(false);
          }
        }}
        disabled={submitting || !name.trim() || !publicKey.trim()}
        className="mt-3 w-full"
      >
        <span className="flex items-center justify-center gap-1.5">
          {submitting && <Spinner />}
          {submitting ? "Registering…" : "Register"}
        </span>
      </PrimaryButton>

      {registered && (
        <div
          className="mt-3 rounded-lg border p-2.5"
          style={{
            borderColor: "var(--decision-allow)",
            background: "color-mix(in srgb, var(--decision-allow) 10%, transparent)",
          }}
        >
          <p className="text-[11px] font-semibold">Registered. Give the agent this id:</p>
          <p className="mt-1 break-all font-mono text-[11px]">{registered}</p>
          <p className="mt-1 text-[10px]" style={{ color: "var(--muted-2)" }}>
            It signs with this as its <code>keyid</code>. Nothing else is issued — the keypair it already
            holds is its credential.
          </p>
        </div>
      )}
    </Panel>
  );
}

function CompatibilityContract({ spec }: { spec: AgentSpec | null }) {
  const [copied, setCopied] = useState(false);

  if (!spec) {
    return (
      <Panel title="What an agent must do" icon={<Icons.Shield />} accent="var(--muted)">
        <EmptyState text="Loading the contract…" />
      </Panel>
    );
  }

  const asText = [
    `Talking to ${spec.merchant.name}`,
    ``,
    `MCP        ${spec.endpoints.mcp}`,
    `Catalog    ${spec.endpoints.catalog}`,
    `Keys       ${spec.endpoints.keyDirectory}`,
    `Control    ${spec.endpoints.agentControl}`,
    ``,
    `Protocol   ${spec.protocol.revision} · ${spec.protocol.transport}`,
    `Signing    ${spec.protocol.signing}`,
    ``,
    ...spec.rules.map((r, i) => `${i + 1}. ${r.must}\n   ${r.why}`),
    ``,
    spec.keygen,
  ].join("\n");

  return (
    <Panel
      title="What an agent must do"
      icon={<Icons.Shield />}
      accent="var(--muted)"
      action={
        <GhostButton
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(asText);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {
              // Clipboard can fail on permissions or a non-HTTPS origin; the
              // text is still selectable, so this is not a dead end.
            }
          }}
          className="py-1! px-2.5! text-[10px]!"
        >
          {copied ? "Copied" : "Copy"}
        </GhostButton>
      }
    >
      <p className="mb-3 text-xs leading-relaxed" style={{ color: "var(--muted)" }}>
        Hand this to whoever is building an agent for you. The URLs are yours, and it contains no key —
        it tells them to generate their own.
      </p>

      <div className="space-y-1 rounded-lg p-2.5" style={{ background: "var(--panel-2)" }}>
        {Object.entries(spec.endpoints).map(([k, v]) => (
          <div key={k} className="flex items-baseline gap-2">
            <span className="w-16 shrink-0 text-[9.5px] uppercase tracking-wider" style={{ color: "var(--muted-2)" }}>
              {k.replace(/([A-Z])/g, " $1")}
            </span>
            <code className="min-w-0 flex-1 break-all text-[11px]" style={{ color: "var(--muted)" }}>
              {v}
            </code>
          </div>
        ))}
      </div>

      <div className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2.5 md:grid-cols-2">
        {spec.rules.map((r, i) => (
          <div key={r.id}>
            <p className="text-[12px] font-medium leading-snug">
              <span className="tabular-nums" style={{ color: "var(--muted-2)" }}>
                {i + 1}.{" "}
              </span>
              {r.must}
            </p>
            <p className="mt-0.5 pl-4 text-[11px] leading-snug" style={{ color: "var(--muted-2)" }}>
              {r.why}
            </p>
          </div>
        ))}
      </div>

      <p className="mt-3 border-t pt-2 text-[10px] leading-snug" style={{ borderColor: "var(--panel-border)", color: "var(--muted-2)" }}>
        {spec.keygen}
      </p>
    </Panel>
  );
}


/**
 * Which parts of the catalog this agent may transact.
 *
 * The unset state is spelled out rather than shown as an empty row of chips.
 * "Full catalog" and "scoped to nothing" both look like no-categories-selected,
 * and they are opposites -- one lets the agent buy everything, the other lets it
 * buy nothing at all. An empty control that could mean either is not a control,
 * it is a coin toss, so the two are separate explicit states here and the
 * summary line always says which one is in force.
 *
 * Enforcement is not this list. An agent naming an out-of-scope SKU directly is
 * blocked by the engine's catalog_scope rule; this only decides what it is
 * shown and offered.
 */
function CatalogScope({
  agent,
  busy,
  onRun,
}: {
  agent: Agent;
  busy: boolean;
  onRun: (fn: () => Promise<unknown>) => void;
}) {
  const scope = agent.catalog_scope;
  const unscoped = scope === null;

  const toggle = (category: string) => {
    const next = unscoped
      ? PRODUCT_CATEGORIES.filter((c) => c !== category)
      : scope.includes(category)
        ? scope.filter((c) => c !== category)
        : [...scope, category];
    onRun(() => setAgentCatalogScope(agent.id, next));
  };

  return (
    <div className="mt-3 border-t pt-2.5" style={{ borderColor: "var(--panel-border)" }}>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[9.5px] font-semibold uppercase tracking-wider" style={{ color: "var(--muted-2)" }}>
          What it may buy
        </p>
        <button
          onClick={() => onRun(() => setAgentCatalogScope(agent.id, unscoped ? [] : null))}
          disabled={busy}
          className="text-[10px] underline-offset-2 hover:underline disabled:opacity-50"
          style={{ color: "var(--muted)" }}
        >
          {unscoped ? "restrict" : "allow everything"}
        </button>
      </div>

      <p className="mt-1 text-[10.5px]" style={{ color: unscoped ? "var(--muted)" : "var(--entity-agent)" }}>
        {unscoped
          ? "Full catalog — every category, including any added later."
          : scope.length === 0
            ? "Nothing. This agent is scoped to no categories and can buy none of the catalog."
            : `Only ${scope.join(", ")}.`}
      </p>

      {!unscoped && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {PRODUCT_CATEGORIES.map((c) => {
            const on = scope.includes(c);
            return (
              <button
                key={c}
                onClick={() => toggle(c)}
                disabled={busy}
                className="rounded-full border px-2 py-1 text-[10px] font-medium transition-colors hover:brightness-125 disabled:opacity-50"
                style={
                  on
                    ? { background: "var(--entity-agent)", borderColor: "var(--entity-agent)", color: "#08080c" }
                    : { background: "transparent", borderColor: "var(--panel-border-strong)", color: "var(--muted)" }
                }
              >
                {c}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
