"use client";

import type { TrustComponents } from "@/lib/trust/score";

/**
 * "Why this score?" — the trust number on its own is an assertion; this is the
 * arithmetic behind it.
 *
 * Every agent starts at a neutral 50, and each term pushes up or down from
 * there. Rendering that as a diverging bar (centre line = the 50 baseline,
 * green pushing right, red pushing left) shows at a glance which factor
 * actually moved the number — a stacked or plain bar would hide the sign,
 * which is the one thing that matters here.
 *
 * Bar widths are scaled against the largest term present rather than a fixed
 * maximum, so a small set of small contributions is still readable instead of
 * collapsing into slivers. The numbers beside them are the real values, so the
 * scaling can't mislead.
 *
 * `components` is read straight off `agents.trust_components`, written by
 * recomputeTrust on every enforce decision — not recounted from the dashboard's
 * trace list, which is capped and would silently undercount a busy agent.
 *
 * The counts shown are the agent's most recent decisions, not its whole
 * history (see TRUST_WINDOW_SIZE in traceHelpers.ts), which is why the total
 * here stops climbing once an agent has been running a while.
 */

interface Term {
  label: string;
  value: number;
  /** Omitted when the underlying counts aren't available — components stored
   *  before the raw counts were persisted have the terms but not the numbers
   *  behind them. Showing a confident "0 allowed · 0 blocked" there would be a
   *  fabrication; showing nothing is honest, and the next decision this agent
   *  makes rewrites the row with real counts. */
  hint?: string;
}

export function TrustBreakdown({ components }: { components: TrustComponents }) {
  const hasCounts = typeof components.approvals === "number";

  const terms: Term[] = [
    {
      label: "Approvals vs blocks",
      value: components.approvalBlockTerm,
      hint: hasCounts ? `${components.approvals} allowed · ${components.blocks} blocked` : undefined,
    },
    {
      label: "Escalations",
      value: components.escalationPenalty,
      hint: hasCounts ? `${components.escalations} needed a human` : undefined,
    },
    {
      label: "Account age",
      value: components.tenureBonus,
      hint: typeof components.accountAgeDays === "number" ? `${Math.floor(components.accountAgeDays)} days, caps at 30` : undefined,
    },
  ];

  const scale = Math.max(1, ...terms.map((t) => Math.abs(t.value)));

  return (
    <div className="mt-2.5 rounded-lg border p-2.5" style={{ borderColor: "var(--panel-border)", background: "var(--panel-2)" }}>
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--muted-2)" }}>
          Starts at
        </span>
        <span className="text-[11px] tabular-nums" style={{ color: "var(--muted)" }}>
          {components.base.toFixed(0)}
        </span>
      </div>

      <div className="mt-2 space-y-2">
        {terms.map((term) => {
          const positive = term.value >= 0;
          const color = positive ? "var(--decision-allow)" : "var(--decision-block)";
          const width = (Math.abs(term.value) / scale) * 50; // half-width each side of centre

          return (
            <div key={term.label}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[11px]">{term.label}</span>
                <span className="shrink-0 text-[11px] font-semibold tabular-nums" style={{ color }}>
                  {positive ? "+" : "−"}
                  {Math.abs(term.value).toFixed(1)}
                </span>
              </div>

              {/* Centre line is the 50 baseline; the fill grows away from it in
                  the direction this term actually moved the score. */}
              <div className="relative mt-1 h-1.5 w-full rounded-full" style={{ background: "var(--panel-border)" }}>
                <div className="absolute inset-y-0 left-1/2 w-px" style={{ background: "var(--panel-border-strong)" }} />
                <div
                  className="absolute inset-y-0 rounded-full"
                  style={{
                    background: color,
                    width: `${width}%`,
                    left: positive ? "50%" : undefined,
                    right: positive ? undefined : "50%",
                  }}
                />
              </div>

              {term.hint && (
                <p className="mt-0.5 text-[10px]" style={{ color: "var(--muted-2)" }}>
                  {term.hint}
                </p>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-2.5 flex items-baseline justify-between border-t pt-2" style={{ borderColor: "var(--panel-border)" }}>
        <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--muted-2)" }}>
          Score
        </span>
        <span className="text-[12px] font-semibold tabular-nums">{components.score.toFixed(1)}</span>
      </div>
    </div>
  );
}
