"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { AnimatePresence, animate, motion, useInView, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import { X } from "@phosphor-icons/react";

/**
 * Motion for the dashboard. Rules, from the design brief:
 * - Springs, critically damped by default; bounce only where a gesture carried momentum.
 * - Entrance animation runs on MOUNT only. The page re-renders every 4 seconds
 *   (LiveRefresher), so nothing here is keyed to data, or it would replay.
 * - Reduced motion falls back to short fades.
 */

export const spring = { type: "spring", bounce: 0, duration: 0.45 } as const;
export const springSnappy = { type: "spring", bounce: 0, duration: 0.3 } as const;

/** Fades and lifts its children in once, staggered by `index`. */
export function Reveal({ children, index = 0, className }: { children: ReactNode; index?: number; className?: string }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduce ? { duration: 0.15 } : { ...spring, delay: Math.min(index, 8) * 0.045 }}
    >
      {children}
    </motion.div>
  );
}

/** Counts up to `value` once on mount, then follows changes without replaying. */
export function AnimatedNumber({ value, format }: { value: number; format: (n: number) => string }) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLSpanElement>(null);
  const mv = useMotionValue(reduce ? value : 0);
  const text = useTransform(mv, (n) => format(n));
  const first = useRef(true);
  useEffect(() => {
    const controls = animate(mv, value, reduce ? { duration: 0 } : { duration: first.current ? 1.1 : 0.5, ease: [0.16, 1, 0.3, 1] });
    first.current = false;
    return () => controls.stop();
  }, [value, mv, reduce]);
  return <motion.span ref={ref}>{text}</motion.span>;
}

/** A small trend line. `points` are in order, oldest first. Draws itself once. */
export function Sparkline({ points, color = "var(--brand-violet)", height = 40, className }: { points: number[]; color?: string; height?: number; className?: string }) {
  const id = useId();
  const reduce = useReducedMotion();
  const ref = useRef<SVGSVGElement>(null);
  const seen = useInView(ref, { once: true });
  const w = 160;
  const data = points.length > 1 ? points : [0, 0];
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pad = 3;
  const xy = data.map((v, i) => [(i / (data.length - 1)) * w, pad + (1 - (v - min) / span) * (height - pad * 2)] as const);
  const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const area = `${line} L${w} ${height} L0 ${height} Z`;
  return (
    <svg ref={ref} viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className={className} style={{ width: "100%", height }} aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.32" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <motion.path d={area} fill={`url(#${id})`} initial={{ opacity: 0 }} animate={{ opacity: seen ? 1 : 0 }} transition={{ duration: reduce ? 0 : 0.8, delay: 0.2 }} />
      <motion.path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        initial={{ pathLength: reduce ? 1 : 0 }}
        animate={{ pathLength: seen ? 1 : reduce ? 1 : 0 }}
        transition={{ duration: reduce ? 0 : 1.1, ease: [0.16, 1, 0.3, 1] }}
      />
    </svg>
  );
}

/** A ring from 0 to 1. */
export function ProgressRing({ value, size = 56, stroke = 6, color = "var(--brand-violet)", children }: { value: number; size?: number; stroke?: number; color?: string; children?: ReactNode }) {
  const reduce = useReducedMotion();
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={stroke} />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          initial={{ strokeDashoffset: reduce ? c * (1 - v) : c }}
          animate={{ strokeDashoffset: c * (1 - v) }}
          transition={reduce ? { duration: 0 } : { duration: 1, ease: [0.16, 1, 0.3, 1] }}
        />
      </svg>
      {children && <div className="absolute inset-0 flex items-center justify-center">{children}</div>}
    </div>
  );
}

/** A segmented control with a sliding thumb (shared layout). */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string; count?: number }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  const group = useId();
  return (
    <div
      role="tablist"
      aria-label={label}
      className="inline-flex max-w-full overflow-x-auto rounded-full border p-1"
      style={{ borderColor: "var(--hairline-strong)", background: "rgba(255,255,255,0.03)" }}
      onKeyDown={(e) => {
        // Arrow keys, Home and End move between options, as a tab list should.
        const i = options.findIndex((o) => o.value === value);
        const next = e.key === "ArrowRight" ? (i + 1) % options.length : e.key === "ArrowLeft" ? (i - 1 + options.length) % options.length : e.key === "Home" ? 0 : e.key === "End" ? options.length - 1 : -1;
        if (next < 0) return;
        e.preventDefault();
        onChange(options[next].value);
        (e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[next] as HTMLElement | undefined)?.focus();
      }}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            type="button"
            onClick={() => onChange(o.value)}
            className="focus-ring relative rounded-full px-4 py-2 text-[14px] font-medium transition-colors"
            style={{ color: active ? "#fff" : "var(--muted)" }}
          >
            {active && <motion.span layoutId={`seg-${group}`} className="absolute inset-0 rounded-full" style={{ background: "linear-gradient(135deg, #7c5cff, #5227ff)" }} transition={springSnappy} />}
            <span className="relative z-10 inline-flex items-center gap-2">
              {o.label}
              {typeof o.count === "number" && <span className="num text-[12px] opacity-70">{o.count}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * A side sheet. Enters from the right and leaves to the right (same path in and
 * out), can be dragged to the right to dismiss (velocity decides), and closes on
 * Escape or a click on the scrim. Focus moves into it and returns on close.
 */
export function Drawer({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 560,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const reduce = useReducedMotion();
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);

  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    panel.current?.focus();
    const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onClose();
      if (e.key !== "Tab") return;
      // Keep Tab inside the sheet: the page behind it is not reachable while it is open.
      const nodes = panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!nodes || nodes.length === 0) {
        e.preventDefault();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
      (opener.current as HTMLElement | null)?.focus?.();
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[60]">
          <motion.div
            className="absolute inset-0 bg-black/55"
            style={{ backdropFilter: "blur(3px)" }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
          />
          <motion.div
            ref={panel}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="glass absolute inset-y-0 right-0 flex max-w-full flex-col outline-none"
            style={{ width, borderRadius: "28px 0 0 28px" }}
            initial={reduce ? { opacity: 0 } : { x: "100%" }}
            animate={reduce ? { opacity: 1 } : { x: 0 }}
            exit={reduce ? { opacity: 0 } : { x: "100%" }}
            transition={reduce ? { duration: 0.15 } : { type: "spring", bounce: 0, duration: 0.5 }}
            drag={reduce ? false : "x"}
            dragConstraints={{ left: 0, right: 0 }}
            dragElastic={{ left: 0, right: 0.6 }}
            onDragEnd={(_, info) => {
              if (info.offset.x > 120 || info.velocity.x > 500) onClose();
            }}
          >
            <header className="flex items-start justify-between gap-4 px-8 pb-4 pt-8">
              <div>
                <h2 id={titleId} className="text-[24px] font-semibold leading-[30px] tracking-tight">{title}</h2>
                {description && (
                  <p className="mt-1.5 text-[15px] leading-6" style={{ color: "var(--muted)" }}>
                    {description}
                  </p>
                )}
              </div>
              <button type="button" onClick={onClose} aria-label="Close" className="focus-ring flex h-10 w-10 shrink-0 items-center justify-center rounded-full border transition-colors hover:bg-white/10" style={{ borderColor: "var(--hairline-strong)" }}>
                <X size={18} />
              </button>
            </header>
            <div className="fade-mask-y min-h-0 flex-1 overflow-y-auto px-8 py-2">{children}</div>
            {footer && <footer className="border-t px-8 py-5" style={{ borderColor: "var(--hairline)" }}>{footer}</footer>}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

/** Confirmation sheet replacing window.confirm: in-app, keyboard friendly. */
export function ConfirmSheet({
  open,
  title,
  body,
  confirmLabel,
  onConfirm,
  onClose,
  danger,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  danger?: boolean;
}) {
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={title}
      width={460}
      footer={
        <div className="flex justify-end gap-3">
          <button type="button" onClick={onClose} className="focus-ring rounded-[12px] border px-5 py-3 text-[15px] font-medium transition-colors hover:bg-white/5" style={{ borderColor: "var(--hairline-strong)" }}>
            Keep it
          </button>
          <button
            type="button"
            // The sheet closes (and unmounts) on this press, so it cannot be pressed twice.
            onClick={() => {
              onConfirm();
              onClose();
            }}
            className="focus-ring rounded-[12px] px-5 py-3 text-[15px] font-semibold text-white transition-transform active:scale-[0.97]"
            style={{ background: danger ? "linear-gradient(135deg,#ef4444,#dc2626)" : "linear-gradient(135deg,#7c5cff,#5227ff)" }}
          >
            {confirmLabel}
          </button>
        </div>
      }
    >
      <p className="text-[15px] leading-7" style={{ color: "var(--muted)" }}>
        {body}
      </p>
    </Drawer>
  );
}
