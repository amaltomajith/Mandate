"use client";

import { useState } from "react";
import { DownloadSimple } from "@phosphor-icons/react";
import type { Agent, Customer, PolicyRule, Trace } from "@/types/db";
import type { CooData } from "@/lib/cooData";
import { EmptyState } from "./ui";
import { Pill } from "./kit";
import { Drawer, Segmented } from "./motion";
import { TimeAgo } from "./TimeAgo";
import { TransactionsView } from "./TransactionsView";

type View = "decisions" | "conversations";

/**
 * Everything the team did, with nothing hidden: every proposed action and what
 * the wall decided, and every conversation with a supplier or buyer, including
 * the messages agents sent in the merchant's name.
 */
export function ActivityTab({
  coo,
  traces,
  agents,
  customers,
  rules,
  onJumpToRule,
}: {
  coo: CooData;
  traces: Trace[];
  agents: Agent[];
  customers: Customer[];
  rules: PolicyRule[];
  onJumpToRule: (id: string) => void;
}) {
  const [view, setView] = useState<View>("decisions");
  const [openThread, setOpenThread] = useState<string | null>(null);
  const vendorName = (id: string | null) => coo.vendors.find((v) => v.id === id)?.name;
  const customerName = (id: string | null) => customers.find((c) => c.id === id)?.name;

  const thread = openThread ? coo.threads.find((t) => t.id === openThread) : undefined;
  const threadMsgs = thread ? coo.messages.filter((m) => m.thread_id === thread.id) : [];
  const who = thread ? vendorName(thread.vendor_id) ?? customerName(thread.customer_id) ?? thread.counterparty : "";

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <Segmented
          label="Activity view"
          value={view}
          onChange={setView}
          options={[
            { value: "decisions", label: "Decisions", count: traces.length },
            { value: "conversations", label: "Conversations", count: coo.threads.length },
          ]}
        />
        <a
          href="/api/export/audit"
          className="focus-ring inline-flex min-h-[44px] items-center gap-2 rounded-[12px] border px-5 text-[15px] font-medium transition-colors hover:bg-white/[0.06]"
          style={{ borderColor: "var(--hairline-strong)" }}
        >
          <DownloadSimple size={18} /> Download audit trail (CSV)
        </a>
      </div>

      {view === "decisions" ? (
        <TransactionsView traces={traces} agents={agents} customers={customers} rules={rules} onJumpToRule={onJumpToRule} />
      ) : (
        <section className="surface p-7">
          {coo.threads.length === 0 ? (
            <EmptyState text="No conversations yet." hint="When the team asks a supplier for a quote or answers a buyer, the thread appears here." />
          ) : (
            <ul>
              {coo.threads.map((t) => {
                const msgs = coo.messages.filter((m) => m.thread_id === t.id);
                const name = vendorName(t.vendor_id) ?? customerName(t.customer_id) ?? t.counterparty;
                const unhandled = msgs.some((m) => m.direction === "in" && !m.handled);
                const last = msgs[msgs.length - 1];
                return (
                  <li key={t.id}>
                    <button type="button" onClick={() => setOpenThread(t.id)} className="focus-ring flex w-full items-center gap-4 rounded-[14px] px-4 py-4 text-left transition-colors hover:bg-white/[0.04]">
                      <span
                        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-[17px] font-semibold"
                        style={{ background: `color-mix(in srgb, ${t.kind === "vendor" ? "var(--entity-agent)" : "var(--entity-customer)"} 20%, var(--surface-3))`, color: t.kind === "vendor" ? "var(--entity-agent)" : "var(--entity-customer)" }}
                      >
                        {name.slice(0, 1).toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2 text-[16px] font-medium">
                          {name}
                          <Pill color={t.kind === "vendor" ? "var(--entity-agent)" : "var(--entity-customer)"}>{t.kind === "vendor" ? "Supplier" : "Buyer"}</Pill>
                          {t.channel === "sandbox" && <Pill color="var(--entity-mandate)">Sandbox</Pill>}
                          {unhandled && <Pill color="var(--decision-escalate)">Unread</Pill>}
                        </span>
                        <span className="mt-0.5 block truncate text-[14px]" style={{ color: "var(--muted)" }}>
                          {t.subject ?? last?.body.slice(0, 100) ?? ""}
                        </span>
                      </span>
                      <span className="shrink-0 text-right text-[13px]" style={{ color: "var(--muted-2)" }}>
                        <span className="block">
                          {msgs.length} message{msgs.length === 1 ? "" : "s"}
                        </span>
                        <TimeAgo iso={t.last_message_at} />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      <Drawer open={!!thread} onClose={() => setOpenThread(null)} title={who || "Conversation"} description={thread?.subject ?? undefined} width={600}>
        <div className="space-y-4 pb-6">
          {threadMsgs.map((m) => (
            <div key={m.id} className={`flex ${m.direction === "out" ? "justify-end" : "justify-start"}`}>
              <div
                className="max-w-[88%] whitespace-pre-wrap rounded-[18px] px-5 py-4 text-[15px] leading-6"
                style={{
                  background: m.direction === "out" ? "linear-gradient(135deg, rgba(124,92,255,0.45), rgba(82,39,255,0.3))" : "var(--surface-3)",
                  borderLeft: m.direction === "in" ? "3px solid var(--decision-escalate)" : undefined,
                }}
              >
                <span className="mb-1.5 block text-[12px] font-medium" style={{ color: m.direction === "out" ? "rgba(255,255,255,0.7)" : "var(--muted)" }}>
                  {m.direction === "out" ? "Your team" : `${who}, an outside party (treated as untrusted)`}
                </span>
                {m.body}
              </div>
            </div>
          ))}
        </div>
      </Drawer>
    </div>
  );
}
