"use client";

import { useState } from "react";
import { registerAgent, type RegisteredAgent } from "@/lib/actions/agents";
import type { Agent } from "@/types/db";
import { EmptyState, GhostButton, Icons, Panel, PrimaryButton } from "./ui";

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
 * "+ Register" closes a real inconsistency: once domains stopped being
 * hardcoded and became dashboard-creatable, agents still requiring a
 * terminal (`npm run gen-agent-key`) to register was the odd one out. Same
 * real Ed25519 keypair either way — src/lib/actions/agents.ts. The secret
 * half is shown exactly once, right here, with nowhere to retrieve it
 * again if you navigate away without copying it — that's a real security
 * property of Web Bot Auth (the secret is never stored server-side), not a
 * UI limitation to work around.
 *
 * `className="h-full"` on Panel plus `flex-1` in DashboardTabs.tsx lets
 * this stretch to fill whatever's left in the Overview sidebar below
 * Escalations — the footer note is what actually occupies that space when
 * there are only one or two agents, not blank padding.
 */
export function AgentTrustPanel({ agents }: { agents: Agent[] }) {
  const sorted = [...agents].sort((a, b) => b.trust_score - a.trust_score);
  const [registering, setRegistering] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justRegistered, setJustRegistered] = useState<RegisteredAgent | null>(null);
  const [copied, setCopied] = useState(false);

  async function submit() {
    if (!name.trim()) return;
    setPending(true);
    setError(null);
    try {
      const agent = await registerAgent(name, description);
      setJustRegistered(agent);
      setRegistering(false);
      setName("");
      setDescription("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't register the agent.");
    } finally {
      setPending(false);
    }
  }

  async function copySecret() {
    if (!justRegistered) return;
    try {
      await navigator.clipboard.writeText(justRegistered.secretKeyBase64);
      setCopied(true);
    } catch {
      // Clipboard API can fail silently (permissions, non-HTTPS) — the key
      // is still selectable text either way, so this isn't a dead end.
    }
  }

  return (
    <Panel
      title="Agent trust"
      icon={<Icons.Sparkles />}
      accent="var(--entity-agent)"
      className="flex h-full flex-col"
      action={
        !registering &&
        !justRegistered && (
          <GhostButton onClick={() => setRegistering(true)} className="py-1! px-2.5! text-[10px]!">
            + Register
          </GhostButton>
        )
      }
    >
      <div className="flex flex-1 flex-col">
        {justRegistered && (
          <div className="mb-3 rounded-xl border p-3" style={{ borderColor: "var(--decision-escalate)", background: "color-mix(in srgb, var(--decision-escalate) 10%, transparent)" }}>
            <p className="text-[11px] font-semibold" style={{ color: "var(--decision-escalate)" }}>
              &quot;{justRegistered.name}&quot; registered — save this secret key now
            </p>
            <p className="mt-1 text-[10px] leading-relaxed" style={{ color: "var(--muted)" }}>
              This is the only time it&apos;s shown. Mandate never stores it — losing it means registering a new agent.
            </p>
            <code
              className="mt-2 block break-all rounded-lg border px-2 py-1.5 text-[10px]"
              style={{ borderColor: "var(--panel-border-strong)", background: "var(--panel-2)", color: "var(--foreground)" }}
            >
              {justRegistered.secretKeyBase64}
            </code>
            <div className="mt-2 flex gap-2">
              <GhostButton onClick={copySecret} className="flex-1 py-1! px-2! text-[10px]!">
                {copied ? "Copied" : "Copy secret key"}
              </GhostButton>
              <GhostButton onClick={() => setJustRegistered(null)} className="py-1! px-2! text-[10px]!">
                Done
              </GhostButton>
            </div>
          </div>
        )}

        {registering && (
          <div className="mb-3 rounded-xl border p-3 space-y-2" style={{ borderColor: "var(--panel-border-strong)", background: "var(--panel-2)" }}>
            <input
              autoFocus
              placeholder="Agent name (e.g. Recovery Agent)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border px-2 py-1.5 text-xs"
              style={{ borderColor: "var(--panel-border-strong)", background: "var(--panel)", color: "var(--foreground)" }}
            />
            <input
              placeholder="Description (optional)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full rounded-lg border px-2 py-1.5 text-xs"
              style={{ borderColor: "var(--panel-border-strong)", background: "var(--panel)", color: "var(--foreground)" }}
            />
            {error && (
              <p className="text-[10px]" style={{ color: "var(--decision-block)" }}>
                {error}
              </p>
            )}
            <div className="flex gap-2">
              <PrimaryButton onClick={submit} disabled={pending || !name.trim()} className="flex-1">
                {pending ? "Registering…" : "Register"}
              </PrimaryButton>
              <GhostButton onClick={() => setRegistering(false)} disabled={pending}>
                Cancel
              </GhostButton>
            </div>
          </div>
        )}

        {sorted.length === 0 ? (
          <EmptyState text="No agents yet — register one above, or click Run demo." />
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
