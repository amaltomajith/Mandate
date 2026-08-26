import { DECISION_COLORS, ENTITY_COLORS } from "./colors";

const ENTITY_ITEMS = [
  { color: ENTITY_COLORS.agent, shape: "circle" as const, label: "AI agent", hint: "glow size = trust score" },
  { color: ENTITY_COLORS.rule, shape: "diamond" as const, label: "Policy rule", hint: "the guardrail that fired" },
  { color: ENTITY_COLORS.mandate, shape: "diamond" as const, label: "Mandate", hint: "ring = active/paused/revoked" },
  { color: ENTITY_COLORS.transaction, shape: "circle" as const, label: "Action taken", hint: "one order, refund, or payout" },
];

const DECISION_ITEMS = [
  { color: DECISION_COLORS.allow, label: "Allowed" },
  { color: DECISION_COLORS.escalate, label: "Escalated — needs your approval" },
  { color: DECISION_COLORS.block, label: "Blocked by policy" },
  { color: DECISION_COLORS.protocol_reject, label: "Rejected — invalid signature" },
];

function Swatch({ color, shape }: { color: string; shape: "circle" | "diamond" }) {
  return (
    <span
      className="inline-block h-2.5 w-2.5 shrink-0"
      style={{
        background: color,
        borderRadius: shape === "circle" ? "999px" : "2px",
        transform: shape === "diamond" ? "rotate(45deg)" : undefined,
        boxShadow: `0 0 6px ${color}`,
      }}
    />
  );
}

/**
 * The graph's whole point is legibility to someone who didn't build it — this
 * is the difference between "a pretty visualization" and something a merchant
 * can actually read a decision off of. Always visible, not tucked behind a
 * button; a legend nobody opens doesn't do its job.
 */
export function GraphLegend() {
  return (
    <div className="pointer-events-none absolute bottom-4 left-4 z-10 w-64 rounded-xl border p-3.5 text-white backdrop-blur-md" style={{ background: "rgba(9,11,18,0.82)", borderColor: "rgba(255,255,255,0.1)" }}>
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-white/50">What you&apos;re looking at</p>

      <div className="space-y-1.5">
        {ENTITY_ITEMS.map((item) => (
          <div key={item.label} className="flex items-center gap-2">
            <Swatch color={item.color} shape={item.shape} />
            <span className="text-[12px] font-medium">{item.label}</span>
            <span className="text-[11px] text-white/45">— {item.hint}</span>
          </div>
        ))}
      </div>

      <div className="my-2.5 h-px" style={{ background: "rgba(255,255,255,0.1)" }} />

      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-white/50">Ring around an action</p>
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
