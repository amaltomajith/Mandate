"use client";

import { useState, useTransition } from "react";
import { proposeStepUpThreshold, replayStepUpThresholds } from "@/lib/actions/policy";
import type { ThresholdOutcome } from "@/lib/policy/thresholdSweep";
import { formatMoney } from "@/lib/format";
import { GhostButton, Icons, Panel, PrimaryButton, Spinner } from "./ui";

interface Replay {
  currency: string;
  currentThreshold: number | null;
  sampleSize: number;
  current: ThresholdOutcome | null;
  options: ThresholdOutcome[];
}

/**
 * The merchant's revenue/friction dial.
 *
 * A step-up threshold is usually set once and never revisited, because there
 * is no way to see what moving it would cost or earn. This replays candidate
 * thresholds against the merchant's *own* recent traffic and shows the trade
 * directly: a lower threshold holds more money for a human, a higher one
 * clears more without one.
 *
 * Every figure is a replay through the same pure `evaluatePolicy` the live
 * path uses — what the engine would have decided about actions that genuinely
 * happened. No projection, no assumed approval rate, no claim about revenue
 * that hasn't occurred. Choosing a threshold proposes it for review rather
 * than applying it, because a revenue dial that silently loosens a spending
 * control is not a dial anyone should trust.
 */
export function ThresholdTuner() {
  const [replay, setReplay] = useState<Replay | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [proposed, setProposed] = useState(false);
  const [isPending, startTransition] = useTransition();

  function load() {
    setError(null);
    setProposed(false);
    startTransition(async () => {
      try {
        const result = await replayStepUpThresholds();
        setReplay(result);
        setSelected(result.currentThreshold);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't replay thresholds.");
      }
    });
  }

  function apply() {
    if (!replay || selected === null) return;
    setError(null);
    startTransition(async () => {
      try {
        await proposeStepUpThreshold(selected, replay.currency);
        setProposed(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't propose that threshold.");
      }
    });
  }

  const chosen = replay?.options.find((o) => o.threshold === selected) ?? null;
  const current = replay?.current ?? null;
  // Money that stops for a human today but wouldn't at the chosen threshold.
  const freed = chosen && current ? current.escalatedValue - chosen.escalatedValue : 0;
  const fewerApprovals = chosen && current ? current.escalatedCount - chosen.escalatedCount : 0;

  return (
    <Panel title="Approval threshold" icon={<Icons.Sparkles />} accent="var(--decision-escalate)">
      <p className="mb-3 text-xs leading-relaxed" style={{ color: "var(--muted)" }}>
        Where the step-up threshold sits decides how much revenue waits on a human. Replay it against
        your own recent traffic to see the trade before changing it.
      </p>

      {!replay && (
        <PrimaryButton onClick={load} disabled={isPending} className="w-full">
          <span className="flex items-center justify-center gap-1.5">
            {isPending && <Spinner />}
            {isPending ? "Replaying…" : "Replay against recent traffic"}
          </span>
        </PrimaryButton>
      )}

      {error && (
        <p className="mt-3 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: "var(--decision-block)", color: "var(--decision-block)", background: "color-mix(in srgb, var(--decision-block) 14%, transparent)" }}>
          {error}
        </p>
      )}

      {replay && (
        <>
          <p className="mb-2 text-[10px] uppercase tracking-wider" style={{ color: "var(--muted-2)" }}>
            {replay.sampleSize} recent actions · refusals excluded
          </p>

          <div className="flex flex-wrap gap-1.5">
            {replay.options.map((o) => {
              const isCurrent = o.threshold === replay.currentThreshold;
              const isSelected = o.threshold === selected;
              return (
                <button
                  key={o.threshold}
                  onClick={() => setSelected(o.threshold)}
                  className="rounded-lg px-2.5 py-1.5 text-[11px] font-medium tabular-nums transition-colors"
                  style={{
                    background: isSelected ? "var(--panel-border-strong)" : "var(--panel-2)",
                    color: isSelected ? "var(--foreground)" : "var(--muted)",
                    boxShadow: isCurrent ? "inset 0 0 0 1px var(--decision-escalate)" : undefined,
                  }}
                >
                  {formatMoney(o.threshold, replay.currency)}
                  {isCurrent && <span className="ml-1 text-[9px] opacity-70">now</span>}
                </button>
              );
            })}
          </div>

          {chosen && (
            <div className="mt-3 rounded-xl border p-3" style={{ borderColor: "var(--panel-border)", background: "var(--panel-2)" }}>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-[10px] uppercase tracking-wider" style={{ color: "var(--muted-2)" }}>
                    Needs approval
                  </p>
                  <p className="mt-0.5 text-[15px] font-semibold tabular-nums" style={{ color: "var(--decision-escalate)" }}>
                    {formatMoney(chosen.escalatedValue, replay.currency)}
                  </p>
                  <p className="text-[10px]" style={{ color: "var(--muted-2)" }}>
                    {chosen.escalatedCount} action{chosen.escalatedCount === 1 ? "" : "s"} held for a human
                  </p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider" style={{ color: "var(--muted-2)" }}>
                    Clears automatically
                  </p>
                  <p className="mt-0.5 text-[15px] font-semibold tabular-nums" style={{ color: "var(--decision-allow)" }}>
                    {formatMoney(chosen.clearedValue, replay.currency)}
                  </p>
                  <p className="text-[10px]" style={{ color: "var(--muted-2)" }}>
                    {chosen.clearedCount} action{chosen.clearedCount === 1 ? "" : "s"}, no human involved
                  </p>
                </div>
              </div>

              {current && chosen.threshold !== current.threshold && (
                <p className="mt-3 border-t pt-2.5 text-[11px] leading-relaxed" style={{ borderColor: "var(--panel-border)" }}>
                  {freed > 0 ? (
                    <>
                      <span className="font-semibold" style={{ color: "var(--decision-allow)" }}>
                        {formatMoney(freed, replay.currency)}
                      </span>{" "}
                      would have cleared without waiting, and {fewerApprovals} fewer action
                      {Math.abs(fewerApprovals) === 1 ? "" : "s"} would have needed you — at the cost of a
                      higher bar before anyone is asked.
                    </>
                  ) : (
                    <>
                      <span className="font-semibold" style={{ color: "var(--decision-escalate)" }}>
                        {formatMoney(Math.abs(freed), replay.currency)}
                      </span>{" "}
                      more would have waited for approval across {Math.abs(fewerApprovals)} extra action
                      {Math.abs(fewerApprovals) === 1 ? "" : "s"} — tighter control, more of your time.
                    </>
                  )}
                </p>
              )}
            </div>
          )}

          <div className="mt-3 flex gap-2">
            <PrimaryButton
              onClick={apply}
              disabled={isPending || proposed || selected === replay.currentThreshold}
              className="flex-1"
            >
              <span className="flex items-center justify-center gap-1.5">
                {isPending && <Spinner />}
                {proposed ? "Sent for review" : "Propose this threshold"}
              </span>
            </PrimaryButton>
            <GhostButton onClick={load} disabled={isPending}>
              Refresh
            </GhostButton>
          </div>

          {proposed && (
            <p className="mt-2 text-[11px]" style={{ color: "var(--muted)" }}>
              Waiting in <span style={{ color: "var(--entity-rule)" }}>pending review</span> above — activating it
              there will offer to retire the threshold it replaces.
            </p>
          )}
        </>
      )}
    </Panel>
  );
}
