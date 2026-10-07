"use client";

import { useState, useTransition, type ReactNode } from "react";
import { Sparkline } from "./motion";

/**
 * Small shared pieces for the dashboard tabs: a runner for server actions that
 * shows failures in words, a stat tile, a pill, and a couple of form inputs.
 */

export function useRunner() {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return {
    error,
    pending,
    clear: () => setError(null),
    /** Runs a server action; any failure becomes a sentence in `error`. */
    run(fn: () => Promise<unknown>) {
      setError(null);
      start(async () => {
        try {
          await fn();
        } catch (err) {
          setError(err instanceof Error ? err.message : "That did not work.");
        }
      });
    },
  };
}

export function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p
      role="alert"
      className="mb-4 rounded-[12px] px-4 py-3 text-[14px] leading-5"
      style={{ background: "color-mix(in srgb, var(--decision-block) 14%, transparent)", color: "var(--decision-block)" }}
    >
      {error}
    </p>
  );
}

/**
 * A headline number. `spark` draws a trend under it; `onClick` makes the whole
 * tile a button (e.g. jump to the tab the number belongs to).
 */
export function Stat({
  label,
  value,
  sub,
  tone,
  spark,
  onClick,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: string;
  spark?: number[];
  onClick?: () => void;
}) {
  const body = (
    <>
      <p className="text-[13px] font-medium" style={{ color: "var(--muted)" }}>
        {label}
      </p>
      <p className="num mt-2 text-[34px] font-semibold leading-[40px]" style={{ color: tone ?? "var(--foreground)" }}>
        {value}
      </p>
      {sub && (
        <p className="mt-1.5 text-[13px] leading-5" style={{ color: "var(--muted)" }}>
          {sub}
        </p>
      )}
      {spark && spark.length > 1 && (
        <div className="mt-4 -mb-1">
          <Sparkline points={spark} color={tone ?? "var(--brand-violet)"} />
        </div>
      )}
    </>
  );
  const cls = "surface block w-full p-6 text-left";
  return onClick ? (
    <button type="button" onClick={onClick} className={`${cls} surface-interactive focus-ring`}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export function Pill({ children, color }: { children: ReactNode; color?: string }) {
  const c = color ?? "var(--muted)";
  return (
    <span
      className="inline-flex min-h-[26px] items-center rounded-full px-3 text-[12px] font-medium"
      style={{ background: `color-mix(in srgb, ${c} 16%, transparent)`, color: c }}
    >
      {children}
    </span>
  );
}

export const inputClass = "studio-input";
export const inputStyle = {} as const;

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-2 block text-[13px] font-medium" style={{ color: "var(--muted)" }}>
        {label}
      </span>
      {children}
      {hint && (
        <span className="mt-2 block text-[13px] leading-5" style={{ color: "var(--muted-2)" }}>
          {hint}
        </span>
      )}
    </label>
  );
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="-mx-2 overflow-x-auto">
      <table className="studio-table w-full min-w-[560px] text-left">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export const rupees = (paise: number | null | undefined) =>
  paise === null || paise === undefined ? "—" : `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/** Large amounts the way a merchant says them: ₹1.2L, ₹3.4Cr. */
export function rupeesShort(paise: number): string {
  const r = paise / 100;
  if (Math.abs(r) >= 1e7) return `₹${(r / 1e7).toFixed(2)}Cr`;
  if (Math.abs(r) >= 1e5) return `₹${(r / 1e5).toFixed(2)}L`;
  return `₹${r.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}
