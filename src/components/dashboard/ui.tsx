import type { ReactNode } from "react";

export function Panel({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      className="rounded-xl border p-4"
      style={{ background: "var(--panel)", borderColor: "var(--panel-border)" }}
    >
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          {typeof count === "number" && count > 0 && (
            <span
              className="rounded-full px-1.5 py-0.5 text-[10px] font-medium text-black"
              style={{ background: "var(--decision-escalate)" }}
            >
              {count}
            </span>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function EmptyState({ text }: { text: string }) {
  return (
    <p className="py-2 text-xs" style={{ color: "var(--muted)" }}>
      {text}
    </p>
  );
}

export function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function decisionColor(decision: string): string {
  switch (decision) {
    case "allow":
      return "var(--decision-allow)";
    case "block":
      return "var(--decision-block)";
    case "escalate":
      return "var(--decision-escalate)";
    case "protocol_reject":
      return "var(--decision-reject)";
    default:
      return "var(--muted)";
  }
}
