"use client";

import { useState } from "react";
import type { Agent, Customer, PolicyRule, Trace } from "@/types/db";
import type { CooData } from "@/lib/cooData";
import { EmptyState, Icons, Panel } from "./ui";
import { Pill } from "./kit";
import { TimeAgo } from "./TimeAgo";
import { TransactionsView } from "./TransactionsView";

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
  const [open, setOpen] = useState<string | null>(null);
  const vendorName = (id: string | null) => coo.vendors.find((v) => v.id === id)?.name;
  const customerName = (id: string | null) => customers.find((c) => c.id === id)?.name;

  return (
    <div className="flex flex-col gap-5">
      <Panel title="Conversations" icon={<Icons.Bell />} accent="var(--entity-agent)">
        {coo.threads.length === 0 ? (
          <EmptyState text="No conversations yet. When the team asks a supplier for a quote or answers a buyer, the thread appears here." />
        ) : (
          <ul className="divide-y" style={{ borderColor: "var(--panel-border)" }}>
            {coo.threads.map((t) => {
              const msgs = coo.messages.filter((m) => m.thread_id === t.id);
              const who = vendorName(t.vendor_id) ?? customerName(t.customer_id) ?? t.counterparty;
              const unhandled = msgs.some((m) => m.direction === "in" && !m.handled);
              const isOpen = open === t.id;
              return (
                <li key={t.id} className="py-3">
                  <button className="flex w-full items-center justify-between gap-3 text-left" onClick={() => setOpen(isOpen ? null : t.id)}>
                    <span className="min-w-0">
                      <span className="flex items-center gap-2 text-[13px] font-medium">
                        {who}
                        <Pill color={t.kind === "vendor" ? "var(--entity-agent)" : "var(--entity-customer)"}>{t.kind === "vendor" ? "supplier" : "buyer"}</Pill>
                        {t.channel === "sandbox" && <Pill color="var(--entity-mandate)">sandbox</Pill>}
                        {unhandled && <Pill color="var(--decision-escalate)">unread</Pill>}
                      </span>
                      <span className="mt-0.5 block truncate text-[11.5px]" style={{ color: "var(--muted-2)" }}>
                        {t.subject ?? msgs[msgs.length - 1]?.body.slice(0, 80) ?? ""}
                      </span>
                    </span>
                    <span className="shrink-0 text-[10.5px]" style={{ color: "var(--muted-2)" }}>
                      {msgs.length} message{msgs.length === 1 ? "" : "s"} · <TimeAgo iso={t.last_message_at} />
                    </span>
                  </button>
                  {isOpen && (
                    <div className="mt-3 space-y-2.5">
                      {msgs.map((m) => (
                        <div key={m.id} className={`flex ${m.direction === "out" ? "justify-end" : "justify-start"}`}>
                          <div
                            className="max-w-[85%] whitespace-pre-wrap rounded-xl px-3 py-2 text-[12.5px] leading-relaxed"
                            style={{
                              background: m.direction === "out" ? "color-mix(in srgb, var(--brand-violet) 22%, var(--panel-2))" : "var(--panel-2)",
                              borderLeft: m.direction === "in" ? "2px solid var(--decision-escalate)" : undefined,
                            }}
                          >
                            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--muted-2)" }}>
                              {m.direction === "out" ? "Your team" : `${who} (outside party, treated as untrusted)`}
                            </span>
                            {m.body}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <TransactionsView traces={traces} agents={agents} customers={customers} rules={rules} onJumpToRule={onJumpToRule} />
    </div>
  );
}
