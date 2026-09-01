"use client";

import { useState } from "react";
import { Icons, Panel } from "./ui";

/**
 * Proof that the merchant is reachable by a machine, not just by this
 * dashboard.
 *
 * The claim "transactable by an AI buyer" is easy to assert and hard to show.
 * These are the URLs that make it true: a catalog an agent can read
 * without credentials, a key directory anything can verify signatures
 * against, and the endpoint orders go to. All live, all public, all openable.
 *
 * The endpoints are rendered from NEXT_PUBLIC_APP_URL rather than written out,
 * so what is displayed is what a deployed instance actually serves — a card
 * showing localhost on a live deployment would be worse than no card.
 */
export function StorefrontCard() {
  const [copied, setCopied] = useState<string | null>(null);
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

  const endpoints = [
    {
      key: "catalog",
      path: "/api/catalog",
      title: "Storefront",
      blurb: "What's for sale, and how to buy it — the MCP endpoint, the signing scheme, and what each outcome means. Public, so an agent can find the merchant before it has credentials.",
    },
    {
      key: "directory",
      path: "/api/wba-directory",
      title: "Key directory",
      blurb: "Public keys for every registered agent, so anyone can verify a signature independently rather than taking this server's word for it.",
    },
    {
      key: "mcp",
      path: "/api/mcp",
      title: "Transact",
      blurb: "Where signed orders go. Every request is verified before any policy runs; an unsigned or tampered one never reaches the engine.",
    },
  ];

  async function copy(key: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 2000);
    } catch {
      // Clipboard can fail on permissions or a non-HTTPS origin; the URL is
      // still selectable text, so this isn't a dead end.
    }
  }

  return (
    <Panel title="Open to AI buyers" icon={<Icons.Sparkles />} accent="var(--decision-allow)">
      <p className="mb-3 text-xs leading-relaxed" style={{ color: "var(--muted)" }}>
        An outside agent doesn&apos;t need a human to read documentation first. These three URLs are
        everything it needs to discover this merchant, verify who it&apos;s talking to, and transact.
      </p>

      <div className="space-y-2">
        {endpoints.map((e) => (
          <div key={e.key} className="rounded-xl border p-2.5" style={{ borderColor: "var(--panel-border)", background: "var(--panel-2)" }}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold">{e.title}</span>
              <div className="flex shrink-0 items-center gap-1.5">
                <a
                  href={e.path}
                  target="_blank"
                  rel="noopener"
                  className="text-[10px] font-medium transition-colors hover:brightness-125"
                  style={{ color: "var(--entity-agent)" }}
                >
                  Open
                </a>
                <button
                  onClick={() => copy(e.key, `${base}${e.path}`)}
                  className="text-[10px] font-medium transition-colors hover:brightness-125"
                  style={{ color: "var(--muted)" }}
                >
                  {copied === e.key ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
            <code className="mt-1 block break-all text-[10px]" style={{ color: "var(--muted-2)" }}>
              {base}
              {e.path}
            </code>
            <p className="mt-1 text-[10px] leading-snug" style={{ color: "var(--muted-2)" }}>
              {e.blurb}
            </p>
          </div>
        ))}
      </div>

      <p className="mt-3 text-[10.5px] leading-relaxed" style={{ color: "var(--muted-2)" }}>
        The catalog deliberately omits the policy thresholds. Publishing them would hand an adversary
        the map for structuring underneath — agents are pointed at <code>simulate_action</code> instead,
        which answers whether a specific action clears without revealing the rule that decides it.
      </p>
    </Panel>
  );
}
