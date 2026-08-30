"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { generateBackgroundTraffic } from "@/lib/actions/backgroundTraffic";
import type { BackgroundTrafficSummary } from "@/lib/demo/backgroundTraffic";
import { formatMoney } from "@/lib/format";
import { GhostButton } from "./ui";

/**
 * A deliberately secondary, utility-styled control — this isn't a narrative
 * beat, it's a "make the dashboard look like a living system" button: ordinary
 * transactions across a small pool of synthetic customers, so Transactions /
 * Agent trust / the policy audit have more than just the scripted demo's
 * handful of rows to work with. Any escalation or block it happens to generate
 * still surfaces normally via the existing alert toasts.
 *
 * Two modes, same underlying path:
 *
 *  - Burst: one click, a handful of transactions, done.
 *  - Live: one transaction every LIVE_INTERVAL_MS until stopped, so the
 *    dashboard visibly moves on its own while you're talking over it. The
 *    existing 4-second LiveRefresher poll is what makes each one appear.
 *
 * LIVE_INTERVAL_MS is not an arbitrary "feels about right" number. The
 * purchases domain carries a velocity rule of 6 actions / 2 minutes per agent,
 * and this bot has its own identity, so its own budget: firing faster than one
 * per 20s would rate-limit *itself* and fill the transactions table with
 * meaningless velocity blocks instead of the ordinary traffic this exists to
 * show. 25s leaves real headroom under that ceiling. If that rule is ever
 * retuned, this needs retuning with it.
 */
const LIVE_INTERVAL_MS = 25_000;

export function BackgroundTrafficButton() {
  const [summary, setSummary] = useState<BackgroundTrafficSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [live, setLive] = useState(false);
  const [liveCount, setLiveCount] = useState(0);

  // Held in a ref so the interval callback can bail if a tick is still in
  // flight — a slow round trip must not stack requests on top of each other.
  const inFlight = useRef(false);

  useEffect(() => {
    if (!live) return;

    let cancelled = false;

    async function tick() {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const result = await generateBackgroundTraffic(1);
        if (cancelled) return;
        setSummary(result);
        setLiveCount((n) => n + result.generated);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        // Stop rather than retry on a loop: a failing server action would
        // otherwise keep firing every 25s with nobody watching the console.
        setError(err instanceof Error ? err.message : "Live traffic stopped after an error.");
        setLive(false);
      } finally {
        inFlight.current = false;
      }
    }

    void tick(); // fire immediately so the first transaction isn't 25s away
    const id = setInterval(tick, LIVE_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [live]);

  function runBurst() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await generateBackgroundTraffic();
        setSummary(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Background traffic generation failed.");
      }
    });
  }

  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed px-4 py-3"
      style={{ borderColor: live ? "var(--decision-allow)" : "var(--panel-border-strong)" }}
    >
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-xs font-medium">
          Generate background activity
          {live && (
            <span className="flex items-center gap-1.5 text-[10px]" style={{ color: "var(--decision-allow)" }}>
              <span className="live-dot h-1.5 w-1.5 rounded-full" style={{ background: "var(--decision-allow)" }} />
              live — one every 25s
            </span>
          )}
        </p>
        <p className="mt-0.5 text-[11px]" style={{ color: "var(--muted-2)" }}>
          Ordinary purchases across a few synthetic customers — real, signed MCP calls, weighted
          toward the catalog&apos;s cheaper items. Run live and the dashboard keeps moving on its own.
        </p>
        {live && liveCount > 0 && (
          <p className="mt-1.5 text-[11px]" style={{ color: "var(--muted)" }}>
            {liveCount} transaction{liveCount === 1 ? "" : "s"} so far this session.
          </p>
        )}
        {!live && summary && (
          <p className="mt-1.5 text-[11px]" style={{ color: "var(--muted)" }}>
            Generated {summary.generated} transaction{summary.generated === 1 ? "" : "s"} (
            {formatMoney(summary.totalAmountPaise, "INR")} total) — {summary.allowed} allowed,{" "}
            {summary.escalated} escalated, {summary.blocked} blocked.
          </p>
        )}
        {error && (
          <p className="mt-1.5 text-[11px]" style={{ color: "var(--decision-block)" }}>
            {error}
          </p>
        )}
      </div>

      <div className="flex shrink-0 gap-2">
        <GhostButton onClick={runBurst} disabled={isPending || live} className="px-4">
          {isPending ? "Generating…" : "Generate burst"}
        </GhostButton>
        <GhostButton
          onClick={() => {
            setLiveCount(0);
            setLive((v) => !v);
          }}
          disabled={isPending}
          className="px-4"
        >
          {live ? "Stop live" : "Run live"}
        </GhostButton>
      </div>
    </div>
  );
}
