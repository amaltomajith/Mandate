"use client";

import { useState } from "react";
import type { RegisteredAgent } from "@/lib/actions/agents";
import { GhostButton } from "./ui";

/**
 * The three values an agent needs to actually call Mandate — and the reason
 * this component exists at all.
 *
 * Registration used to show the secret key alone, which made the whole flow a
 * dead end: `/api/mcp` looks agents up by `keyid` (src/app/api/mcp/route.ts),
 * and `keyid` IS the agent id, so a secret without its id cannot sign a single
 * request. You got a credential you could not use, with nothing on screen
 * saying so. This is now the single registration path; the terminal script
 * that used to duplicate it (and print all three values) was removed.
 *
 * Shown exactly once, on registration. The secret half is never stored server
 * side — that's a real property of Web Bot Auth, not a UI limitation — so
 * there is genuinely nowhere to retrieve it from afterwards.
 */
export function AgentCredentials({ agent, onDismiss }: { agent: RegisteredAgent; onDismiss: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);

  const endpoint = `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/api/mcp`;

  const fields: { key: string; label: string; value: string; secret?: boolean }[] = [
    { key: "endpoint", label: "Endpoint", value: endpoint },
    { key: "id", label: "Agent ID (sign as keyid)", value: agent.id },
    { key: "secret", label: "Secret key", value: agent.secretKeyBase64, secret: true },
  ];

  const envBlock = [
    `MANDATE_ENDPOINT=${endpoint}`,
    `MANDATE_AGENT_ID=${agent.id}`,
    `MANDATE_SECRET_KEY=${agent.secretKeyBase64}`,
  ].join("\n");

  async function copy(key: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 2000);
    } catch {
      // Clipboard can fail on permissions or a non-HTTPS origin — the values
      // are still selectable text, so this isn't a dead end.
    }
  }

  return (
    <div
      className="mb-3 rounded-xl border p-3"
      style={{
        borderColor: "var(--decision-escalate)",
        background: "color-mix(in srgb, var(--decision-escalate) 10%, transparent)",
      }}
    >
      <p className="text-[11px] font-semibold" style={{ color: "var(--decision-escalate)" }}>
        &quot;{agent.name}&quot; registered — save these now
      </p>
      <p className="mt-1 text-[10px] leading-relaxed" style={{ color: "var(--muted)" }}>
        The secret key is shown this once and never stored. All three values are needed to sign a
        request — an agent ID without its secret, or a secret without its ID, can&apos;t connect.
      </p>

      <div className="mt-2.5 space-y-2">
        {fields.map((f) => (
          <div key={f.key}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[9px] font-semibold uppercase tracking-wider" style={{ color: "var(--muted-2)" }}>
                {f.label}
              </span>
              <button
                onClick={() => copy(f.key, f.value)}
                className="text-[10px] font-medium transition-colors hover:brightness-125"
                style={{ color: "var(--entity-agent)" }}
              >
                {copied === f.key ? "Copied" : "Copy"}
              </button>
            </div>
            <code
              className="mt-0.5 block break-all rounded-lg border px-2 py-1 text-[10px]"
              style={{
                borderColor: "var(--panel-border-strong)",
                background: "var(--panel-2)",
                color: f.secret ? "var(--decision-escalate)" : "var(--foreground)",
              }}
            >
              {f.value}
            </code>
          </div>
        ))}
      </div>

      <div className="mt-2.5 flex gap-2">
        <GhostButton onClick={() => copy("env", envBlock)} className="flex-1 py-1! px-2! text-[10px]!">
          {copied === "env" ? "Copied" : "Copy all as .env"}
        </GhostButton>
        <GhostButton onClick={onDismiss} className="py-1! px-2! text-[10px]!">
          Done
        </GhostButton>
      </div>
    </div>
  );
}
