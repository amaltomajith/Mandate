import type { ReactNode } from "react";

/**
 * `bodyClassName` exists so a panel can own a scroll region instead of growing
 * without limit. A panel in a fixed-height column must let its body shrink and
 * scroll, which needs `min-h-0` on the flex child — without it a flex item
 * refuses to shrink below its content and pushes the whole layout taller,
 * which is exactly how a growing escalation queue used to stretch the entity
 * graph off the bottom of the screen.
 */
export function Panel({
  title,
  icon,
  accent,
  count,
  action,
  children,
  className,
  bodyClassName,
}: {
  title: string;
  icon?: ReactNode;
  accent?: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`panel-card relative flex flex-col overflow-hidden rounded-2xl p-5 ${className ?? ""}`}>
      {accent && (
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-[3px] opacity-80"
          style={{ background: accent }}
        />
      )}
      <div className="mb-4 flex shrink-0 items-center justify-between">
        <div className="flex items-center gap-2.5">
          {icon && (
            <span
              className="flex h-7 w-7 items-center justify-center rounded-lg"
              style={{ background: `color-mix(in srgb, ${accent ?? "var(--muted-2)"} 16%, transparent)`, color: accent ?? "var(--muted)" }}
            >
              {icon}
            </span>
          )}
          <h2 className="text-[13px] font-semibold tracking-tight text-foreground">{title}</h2>
          {typeof count === "number" && count > 0 && (
            <span
              className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold text-white"
              style={{ background: "var(--decision-escalate)" }}
            >
              {count}
            </span>
          )}
        </div>
        {action}
      </div>
      <div className={`min-h-0 flex-1 ${bodyClassName ?? ""}`}>{children}</div>
    </section>
  );
}

export function EmptyState({ text }: { text: string }) {
  return (
    <div
      className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-6 text-center"
      style={{ borderColor: "var(--panel-border-strong)" }}
    >
      <p className="text-xs" style={{ color: "var(--muted)" }}>
        {text}
      </p>
    </div>
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

export { actionTypeLabel, formatMoney } from "@/lib/format";

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

export function PrimaryButton({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`group relative overflow-hidden rounded-lg py-2 text-xs font-semibold text-white shadow-sm transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50 ${props.className ?? ""}`}
      style={{ background: "linear-gradient(135deg, #7c5cff, #5227ff)", ...props.style }}
    >
      <span className="relative z-10">{children}</span>
      <span className="absolute inset-0 -translate-x-full bg-white/20 transition-transform duration-500 group-hover:translate-x-full" />
    </button>
  );
}

/**
 * Inline activity indicator for a button mid-action. Inherits `currentColor`
 * so it works on any button colour without a variant per button, and the
 * track/arc split reads as motion at 14px where a pulsing dot just looks like
 * a rendering glitch.
 */
export function Spinner({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className="animate-spin"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.28" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function SuccessButton({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`rounded-lg py-2 text-xs font-semibold text-white shadow-sm transition-all duration-200 hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50 ${props.className ?? ""}`}
      style={{ background: "linear-gradient(135deg, #22c55e, #16a34a)", ...props.style }}
    >
      {children}
    </button>
  );
}

export function DangerButton({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`rounded-lg py-2 text-xs font-semibold text-white shadow-sm transition-all duration-200 hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50 ${props.className ?? ""}`}
      style={{ background: "linear-gradient(135deg, #ef4444, #dc2626)", ...props.style }}
    >
      {children}
    </button>
  );
}

export function GhostButton({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`rounded-lg border py-2 text-xs font-medium transition-colors duration-200 hover:bg-[var(--panel-2)] disabled:cursor-not-allowed disabled:opacity-50 ${props.className ?? ""}`}
      style={{ borderColor: "var(--panel-border-strong)", color: "var(--foreground)", ...props.style }}
    >
      {children}
    </button>
  );
}

// Minimal inline icon set — no icon-library dependency.
type IconProps = { size?: number };

export const Icons = {
  Escalation: ({ size = 14 }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  ),
  Shield: ({ size = 14 }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
    </svg>
  ),
  Bell: ({ size = 14 }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  ),
  Sparkles: ({ size = 14 }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m12 3-1.9 4.9L5 9.8l4.1 2.9L7.6 18l4.4-3.1L16.4 18l-1.5-5.3L19 9.8l-6.1-1.9Z" />
    </svg>
  ),
  CheckCircle: ({ size = 14 }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  ),
  AlertTriangle: ({ size = 14 }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  ),
  XCircle: ({ size = 14 }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="m15 9-6 6M9 9l6 6" />
    </svg>
  ),
  X: ({ size = 14 }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  ),
};
