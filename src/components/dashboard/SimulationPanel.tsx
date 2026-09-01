"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { stepSimulation } from "@/lib/actions/simulation";
import type { SimulationEvent, SimulationSummary } from "@/lib/demo/simulation";
import { formatMoney } from "@/lib/format";
import { GhostButton, decisionColor } from "./ui";

/**
 * The simulated agent's controls — and the only "run something" surface on the
 * dashboard, replacing a scripted eleven-step demo.
 *
 * The frequency options aren't cosmetic. The purchases velocity rule allows a
 * fixed number of actions per window, so the interval decides whether the
 * simulated agent stays inside its own rate limit or outruns it:
 *
 *   Calm / Busy  — comfortably under the limit; blocks come from amounts and
 *                  categories, which is the ordinary picture.
 *   Stress       — deliberately faster than the limit allows, so the rate
 *                  limiter engages and starts refusing the agent's own
 *                  traffic. That isn't a malfunction to apologise for, it's
 *                  the guardrail doing its job, visible live.
 *
 * If the velocity rule is retuned, these numbers need revisiting with it —
 * the labels claim a relationship to it that only holds by arithmetic.
 */
const SPEEDS = [
  { label: "Calm", ms: 30_000, hint: "one every 30s" },
  { label: "Busy", ms: 10_000, hint: "one every 10s" },
  { label: "Stress", ms: 3_000, hint: "one every 3s — outruns the rate limit" },
] as const;

const DECISION_LABEL: Record<SimulationEvent["decision"], string> = {
  allow: "Allowed",
  escalate: "Escalated",
  block: "Blocked",
  protocol_reject: "Rejected",
};

export function SimulationPanel() {
  const [running, setRunning] = useState(false);
  const [speedMs, setSpeedMs] = useState<number>(SPEEDS[1].ms);
  const [showSpeeds, setShowSpeeds] = useState(false);
  const [feed, setFeed] = useState<SimulationEvent[]>([]);
  const [totals, setTotals] = useState({ allowed: 0, escalated: 0, blocked: 0, rejected: 0, amount: 0 });
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  // A tick is a real round trip — sign the request, verify the signature,
  // evaluate policy, and on an allow actually call Razorpay — which takes a
  // few seconds. Without saying so the feed just sits there and the thing
  // looks stalled, so the pending action is shown as a row of its own and
  // resolves in place into whatever the engine decided.
  const [processing, setProcessing] = useState(false);

  // Guards against a slow round trip stacking requests on top of each other.
  const inFlight = useRef(false);

  function absorb(summary: SimulationSummary) {
    setFeed((prev) => [...summary.events, ...prev].slice(0, 40));
    setTotals((t) => ({
      allowed: t.allowed + summary.allowed,
      escalated: t.escalated + summary.escalated,
      blocked: t.blocked + summary.blocked,
      rejected: t.rejected + summary.rejected,
      amount: t.amount + summary.totalAmountPaise,
    }));
  }

  useEffect(() => {
    if (!running) return;
    let cancelled = false;

    async function tick() {
      if (inFlight.current) return;
      inFlight.current = true;
      setProcessing(true);
      try {
        const summary = await stepSimulation(1);
        if (cancelled) return;
        absorb(summary);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        // Stop rather than retry forever into a void.
        setError(err instanceof Error ? err.message : "Simulation stopped after an error.");
        setRunning(false);
      } finally {
        inFlight.current = false;
        if (!cancelled) setProcessing(false);
      }
    }

    void tick();
    const id = setInterval(tick, speedMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [running, speedMs]);

  function stepOnce() {
    setError(null);
    setProcessing(true);
    startTransition(async () => {
      try {
        absorb(await stepSimulation(1));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Simulation step failed.");
      } finally {
        setProcessing(false);
      }
    });
  }

  const activeSpeed = SPEEDS.find((s) => s.ms === speedMs) ?? SPEEDS[1];

  return (
    <div className="panel-card rounded-2xl p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-semibold">
            Simulated agent
            {running && (
              <span className="flex items-center gap-1.5 text-[10px] font-normal" style={{ color: "var(--decision-allow)" }}>
                <span className="live-dot h-1.5 w-1.5 rounded-full" style={{ background: "var(--decision-allow)" }} />
                {activeSpeed.hint}
              </span>
            )}
          </p>
          <p className="mt-0.5 max-w-2xl text-xs" style={{ color: "var(--muted)" }}>
            An AI buyer agent transacting continuously — real, signed MCP calls through the same policy
            engine any external agent would hit. Most go through; some cross the approval threshold, some
            touch a banned category, and some are forged requests that never reach the engine at all.
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {/* Deliberately understated: the speed control is for whoever is
              driving, not a primary action competing with Start. */}
          <button
            onClick={() => setShowSpeeds((v) => !v)}
            aria-label="Simulation speed"
            className="rounded-lg px-2 py-1.5 text-[11px] transition-colors hover:bg-[var(--panel-2)]"
            style={{ color: "var(--muted-2)" }}
          >
            {activeSpeed.label} ▾
          </button>
          <GhostButton onClick={stepOnce} disabled={isPending || running} className="px-3">
            {isPending ? "Deciding…" : "Step once"}
          </GhostButton>
          <GhostButton onClick={() => setRunning((v) => !v)} className="px-4">
            {running ? "Stop" : "Start"}
          </GhostButton>
        </div>
      </div>

      {showSpeeds && (
        <div className="mt-3 flex flex-wrap gap-2 rounded-xl border p-2.5" style={{ borderColor: "var(--panel-border)", background: "var(--panel-2)" }}>
          {SPEEDS.map((s) => (
            <button
              key={s.label}
              onClick={() => {
                setSpeedMs(s.ms);
                setShowSpeeds(false);
              }}
              className="rounded-lg px-3 py-1.5 text-[11px] font-medium transition-colors"
              style={{
                background: s.ms === speedMs ? "var(--panel-border-strong)" : "transparent",
                color: s.ms === speedMs ? "var(--foreground)" : "var(--muted)",
              }}
            >
              {s.label}
              <span className="ml-1.5 text-[10px]" style={{ color: "var(--muted-2)" }}>
                {s.hint}
              </span>
            </button>
          ))}
        </div>
      )}

      {error && (
        <p className="mt-3 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: "var(--decision-block)", color: "var(--decision-block)", background: "color-mix(in srgb, var(--decision-block) 14%, transparent)" }}>
          {error}
        </p>
      )}

      {(totals.allowed + totals.escalated + totals.blocked + totals.rejected) > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]" style={{ color: "var(--muted)" }}>
          <Tally label="allowed" value={totals.allowed} color="var(--decision-allow)" />
          <Tally label="escalated" value={totals.escalated} color="var(--decision-escalate)" />
          <Tally label="blocked" value={totals.blocked} color="var(--decision-block)" />
          <Tally label="rejected" value={totals.rejected} color="var(--decision-reject)" />
          <span style={{ color: "var(--muted-2)" }}>{formatMoney(totals.amount, "INR")} attempted this session</span>
        </div>
      )}

      {(processing || feed.length > 0) && (
        <div className="mt-3 max-h-60 space-y-1.5 overflow-y-auto border-t pt-3 pr-1" style={{ borderColor: "var(--panel-border)" }}>
          {processing && <PendingRow />}
          {feed.map((e, i) => {
            const color = decisionColor(e.decision);
            return (
              <div key={i} className="flex items-start gap-2.5 rounded-lg px-2 py-1.5" style={{ background: "var(--panel-2)" }}>
                <span
                  className="mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide"
                  style={{ background: `${color}26`, color }}
                >
                  {DECISION_LABEL[e.decision]}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[12px] font-medium">
                    {e.label}
                    {e.amountPaise > 0 && (
                      <span className="ml-1.5 tabular-nums" style={{ color: "var(--muted-2)" }}>
                        {formatMoney(e.amountPaise, "INR")}
                      </span>
                    )}
                  </p>
                  <p className="text-[11px] leading-snug" style={{ color: "var(--muted)" }}>
                    {e.reasoning}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * The in-flight action, shown in the same shape as a decided one so it
 * resolves in place rather than appearing from nowhere. The steps listed are
 * the real ones the request goes through, in order — it isn't a generic
 * spinner standing in for unknown work.
 */
function PendingRow() {
  return (
    <div
      className="flex items-start gap-2.5 rounded-lg px-2 py-1.5"
      style={{ background: "var(--panel-2)", border: "1px dashed var(--panel-border-strong)" }}
    >
      <span
        className="mt-0.5 flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide"
        style={{ background: "color-mix(in srgb, var(--entity-agent) 18%, transparent)", color: "var(--entity-agent)" }}
      >
        <span className="live-dot h-1 w-1 rounded-full" style={{ background: "var(--entity-agent)" }} />
        Deciding
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[12px] font-medium" style={{ color: "var(--muted)" }}>
          Agent action in flight
        </p>
        <p className="text-[11px] leading-snug" style={{ color: "var(--muted-2)" }}>
          Signing the request, verifying it, checking the mandate, evaluating policy — then
          calling Razorpay if it&apos;s allowed.
        </p>
      </div>
    </div>
  );
}

function Tally({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      <span className="font-semibold tabular-nums" style={{ color: "var(--foreground)" }}>
        {value}
      </span>
      {label}
    </span>
  );
}
