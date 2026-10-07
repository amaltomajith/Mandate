import type { ReactNode } from "react";

import { Bell, CheckCircle, Info, ShieldCheck, Sparkle, Warning, WarningCircle, X as XIcon, XCircle } from "@phosphor-icons/react/dist/ssr";

/**
 * The card every section sits in. `bodyClassName` lets a card own a scroll
 * region (it needs `min-h-0` for a flex child to shrink). `accent` now tints the
 * icon chip only; the old top strip is gone, so cards no longer all look alike.
 */
export function Panel({
  title,
  description,
  icon,
  accent,
  count,
  action,
  children,
  className,
  bodyClassName,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  accent?: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`surface flex flex-col p-7 ${className ?? ""}`}>
      <div className="mb-6 flex shrink-0 items-start justify-between gap-4">
        <div className="flex items-start gap-3.5">
          {icon && (
            <span
              className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px]"
              style={{ background: `color-mix(in srgb, ${accent ?? "var(--brand-violet)"} 16%, transparent)`, color: accent ?? "var(--brand-pink)" }}
            >
              {icon}
            </span>
          )}
          <div>
            <h2 className="flex items-center gap-2.5 text-[17px] font-semibold leading-6 tracking-[-0.01em] text-foreground">
              {title}
              {typeof count === "number" && count > 0 && (
                <span className="num rounded-full px-2 py-0.5 text-[12px] font-semibold text-black" style={{ background: accent ?? "var(--decision-escalate)" }}>
                  {count}
                </span>
              )}
            </h2>
            {description && (
              <p className="mt-0.5 text-[14px] leading-5" style={{ color: "var(--muted)" }}>
                {description}
              </p>
            )}
          </div>
        </div>
        {action}
      </div>
      <div className={`min-h-0 flex-1 ${bodyClassName ?? ""}`}>{children}</div>
    </section>
  );
}

export function EmptyState({ text, hint }: { text: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5 rounded-[14px] border border-dashed px-6 py-10 text-center" style={{ borderColor: "var(--hairline-strong)" }}>
      <Sparkle size={22} weight="duotone" style={{ color: "var(--muted-2)" }} />
      <p className="text-[15px]" style={{ color: "var(--foreground)" }}>
        {text}
      </p>
      {hint && (
        <p className="max-w-sm text-[13px] leading-5" style={{ color: "var(--muted)" }}>
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * "38s ago". Correct, and NOT safe to render during SSR — see {@link TimeAgo}.
 *
 * Two things in here differ between the server and the browser. `Date.now()`
 * advances between the two renders, so a row served at 38 seconds hydrates at
 * 39. And `toLocaleDateString()` formats in the *runtime's* locale and time
 * zone, which for a server in UTC and a reader in IST is a different string for
 * the same instant. Either one is a hydration mismatch; the first is just the
 * one that fires every time.
 */
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

const btn = "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-[12px] px-5 text-[15px] font-semibold transition-all duration-200 focus-ring active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50";

export function PrimaryButton({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`${btn} group relative overflow-hidden text-white shadow-[0_8px_24px_-8px_rgba(82,39,255,0.8)] hover:brightness-110 ${props.className ?? ""}`}
      style={{ background: "linear-gradient(135deg, #7c5cff, #5227ff)", ...props.style }}
    >
      <span className="relative z-10 inline-flex items-center gap-2">{children}</span>
      <span className="absolute inset-0 -translate-x-full bg-white/20 transition-transform duration-500 group-hover:translate-x-full motion-reduce:hidden" />
    </button>
  );
}

/**
 * Inline activity indicator for a button mid-action. Inherits `currentColor`
 * so it works on any button colour without a variant per button.
 */
export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className="animate-spin" aria-hidden="true" style={{ flexShrink: 0 }}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.28" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function SuccessButton({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...props} className={`${btn} text-[#04110a] hover:brightness-110 ${props.className ?? ""}`} style={{ background: "linear-gradient(135deg, #4ade80, #22c55e)", ...props.style }}>
      {children}
    </button>
  );
}

export function DangerButton({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...props} className={`${btn} text-white hover:brightness-110 ${props.className ?? ""}`} style={{ background: "linear-gradient(135deg, #ef4444, #dc2626)", ...props.style }}>
      {children}
    </button>
  );
}

export function GhostButton({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...props} className={`${btn} border font-medium hover:bg-white/[0.06] ${props.className ?? ""}`} style={{ borderColor: "var(--hairline-strong)", color: "var(--foreground)", ...props.style }}>
      {children}
    </button>
  );
}

// Phosphor icons behind the old names, so call sites keep working. One weight.
type IconProps = { size?: number };
const W = "regular" as const;

export const Icons = {
  Escalation: ({ size = 18 }: IconProps) => <Warning size={size} weight={W} />,
  Shield: ({ size = 18 }: IconProps) => <ShieldCheck size={size} weight={W} />,
  Bell: ({ size = 18 }: IconProps) => <Bell size={size} weight={W} />,
  Sparkles: ({ size = 18 }: IconProps) => <Sparkle size={size} weight={W} />,
  CheckCircle: ({ size = 18 }: IconProps) => <CheckCircle size={size} weight={W} />,
  AlertTriangle: ({ size = 18 }: IconProps) => <WarningCircle size={size} weight={W} />,
  XCircle: ({ size = 18 }: IconProps) => <XCircle size={size} weight={W} />,
  X: ({ size = 18 }: IconProps) => <XIcon size={size} weight={W} />,
  Info: ({ size = 18 }: IconProps) => <Info size={size} weight={W} />,
};
