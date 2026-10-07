"use client";

import { useState } from "react";
import { DECISION_COLORS, ENTITY_COLORS, ESCALATION_OUTCOME_COLORS, STOCK_COLORS, VENDOR_COLORS } from "./colors";

const ENTITY_ITEMS = [
  { color: ENTITY_COLORS.wall, shape: "ring" as const, label: "Payment Wall", hint: "every money action crosses it" },
  { color: ENTITY_COLORS.agent, shape: "circle" as const, label: "Your agents", hint: "inside the wall; glow = trust" },
  { color: ENTITY_COLORS.rule, shape: "diamond" as const, label: "Guardrail", hint: "the rule that fired" },
  { color: ENTITY_COLORS.inventory, shape: "square" as const, label: "Product", hint: "height = cash in stock" },
  { color: ENTITY_COLORS.vendor, shape: "diamond" as const, label: "Supplier", hint: "dim = awaiting approval" },
  { color: ENTITY_COLORS.purchaseOrder, shape: "square" as const, label: "Order", hint: "between wallet and supplier" },
  { color: ENTITY_COLORS.wallet, shape: "circle" as const, label: "Wallet", hint: "grows with the balance" },
];

const STOCK_ITEMS = [
  { color: STOCK_COLORS.healthy, label: "Healthy stock" },
  { color: STOCK_COLORS.dead, label: "Not selling" },
  { color: STOCK_COLORS.low, label: "Running low (pulses)" },
  { color: STOCK_COLORS.stockout, label: "Out of stock (pulses)" },
  { color: VENDOR_COLORS.candidate, label: "Supplier awaiting approval" },
];

/* Ordered as a story: cleared on its own, then the three things that can happen
   to an escalation, then the refusals. An escalation is a state machine, and
   showing only "escalated" would hide that most of them are already resolved. */
const DECISION_ITEMS = [
  { color: DECISION_COLORS.allow, label: "Allowed automatically" },
  { color: DECISION_COLORS.escalate, label: "Held for your approval" },
  { color: ESCALATION_OUTCOME_COLORS.approved, label: "You approved it" },
  { color: ESCALATION_OUTCOME_COLORS.denied, label: "You denied it" },
  { color: DECISION_COLORS.block, label: "Blocked by a guardrail" },
  { color: DECISION_COLORS.protocol_reject, label: "Forged request rejected" },
];

function Swatch({ color, shape }: { color: string; shape: "circle" | "diamond" | "square" | "ring" }) {
  return (
    <span
      className="inline-block h-2.5 w-2.5 shrink-0"
      style={{
        background: shape === "ring" ? "transparent" : color,
        border: shape === "ring" ? `2px solid ${color}` : undefined,
        borderRadius: shape === "circle" || shape === "ring" ? "999px" : "2px",
        transform: shape === "diamond" ? "rotate(45deg)" : undefined,
        boxShadow: `0 0 6px ${color}`,
      }}
    />
  );
}

/**
 * Collapsed behind a small "?" by default: an always-open legend permanently
 * covers part of the scene, a worse trade once a viewer knows how to read it.
 */
export function GraphLegend() {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        aria-label="Show legend"
        className="absolute bottom-4 left-4 z-10 flex h-9 w-9 items-center justify-center rounded-full border text-[15px] font-semibold text-white/80 backdrop-blur-md transition-colors hover:text-white"
        style={{ background: "rgba(8,8,12,0.84)", borderColor: "rgba(255,255,255,0.14)" }}
      >
        ?
      </button>
    );
  }

  return (
    <div className="absolute bottom-4 left-4 z-10 max-h-[calc(100%-2rem)] w-72 overflow-y-auto rounded-xl border p-3.5 text-white backdrop-blur-md" style={{ background: "rgba(8,8,12,0.9)", borderColor: "rgba(255,255,255,0.1)" }}>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-white/50">What you&apos;re looking at</p>
        <button onClick={() => setOpen(false)} aria-label="Hide legend" className="-mr-1 -mt-1 flex h-6 w-6 items-center justify-center rounded-md text-white/50 transition-colors hover:bg-white/10 hover:text-white">
          ✕
        </button>
      </div>

      <div className="space-y-1.5">
        {ENTITY_ITEMS.map((item) => (
          <div key={item.label} className="flex items-center gap-2">
            <Swatch color={item.color} shape={item.shape} />
            <span className="text-[12px] font-medium">{item.label}</span>
            <span className="text-[11px] text-white/45">· {item.hint}</span>
          </div>
        ))}
      </div>

      <div className="my-2.5 h-px" style={{ background: "rgba(255,255,255,0.1)" }} />
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-white/50">Stock</p>
      <div className="space-y-1.5">
        {STOCK_ITEMS.map((item) => (
          <div key={item.label} className="flex items-center gap-2">
            <Swatch color={item.color} shape="square" />
            <span className="text-[12px]">{item.label}</span>
          </div>
        ))}
      </div>

      <div className="my-2.5 h-px" style={{ background: "rgba(255,255,255,0.1)" }} />
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-white/50">Wall flare and ring around an action</p>
      <div className="space-y-1.5">
        {DECISION_ITEMS.map((item) => (
          <div key={item.label} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full border-2" style={{ borderColor: item.color }} />
            <span className="text-[12px]">{item.label}</span>
          </div>
        ))}
      </div>

      <div className="my-2.5 h-px" style={{ background: "rgba(255,255,255,0.1)" }} />
      <p className="text-[11px] text-white/45">Drag to orbit · scroll to zoom · hover any node for details</p>
    </div>
  );
}
