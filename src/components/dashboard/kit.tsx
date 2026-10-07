"use client";

import { useState, useTransition, type ReactNode } from "react";

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
      className="mb-3 rounded-lg px-3 py-2 text-xs"
      style={{ background: "color-mix(in srgb, var(--decision-block) 14%, transparent)", color: "var(--decision-block)" }}
    >
      {error}
    </p>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string }) {
  return (
    <div className="panel-card rounded-2xl p-4">
      <p className="text-[11px] font-medium uppercase tracking-wider" style={{ color: "var(--muted-2)" }}>
        {label}
      </p>
      <p className="mt-1.5 text-[22px] font-semibold tabular-nums tracking-tight" style={{ color: tone ?? "var(--foreground)" }}>
        {value}
      </p>
      {sub && (
        <p className="mt-0.5 text-xs" style={{ color: "var(--muted)" }}>
          {sub}
        </p>
      )}
    </div>
  );
}

export function Pill({ children, color }: { children: ReactNode; color?: string }) {
  const c = color ?? "var(--muted)";
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
      style={{ background: `color-mix(in srgb, ${c} 16%, transparent)`, color: c }}
    >
      {children}
    </span>
  );
}

export const inputClass =
  "w-full rounded-lg border bg-transparent px-3 py-2 text-[13px] outline-none transition-colors focus:border-[var(--brand-violet)] disabled:opacity-50";
export const inputStyle = { borderColor: "var(--panel-border-strong)", color: "var(--foreground)" } as const;

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium" style={{ color: "var(--muted)" }}>
        {label}
      </span>
      {children}
      {hint && (
        <span className="mt-1 block text-[11px]" style={{ color: "var(--muted-2)" }}>
          {hint}
        </span>
      )}
    </label>
  );
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-left text-[12.5px]">
        <thead>
          <tr style={{ color: "var(--muted-2)" }}>
            {head.map((h) => (
              <th key={h} className="whitespace-nowrap px-2 py-2 text-[10.5px] font-semibold uppercase tracking-wider">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y" style={{ borderColor: "var(--panel-border)" }}>
          {children}
        </tbody>
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
