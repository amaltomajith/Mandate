"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { useChartHover } from "./useChartHover";

/**
 * A single-series line that draws itself in on mount and tracks the cursor —
 * the interaction shape asked for by the React Bits Pro `simple-graph`
 * reference. That component is gated behind a license key this deployment
 * doesn't have (same wall the Animated List hit earlier in this project), so
 * this is a hand-rolled equivalent in the app's own visual language rather
 * than a blocked dependency.
 *
 * The draw-in uses SVG's normalized `pathLength="1"` rather than measuring the
 * real path with `getTotalLength()` — that needs a DOM node to exist first,
 * which means an effect and a re-render; `pathLength` lets the browser do the
 * normalization and the animation is one CSS transition on `stroke-dashoffset`
 * triggered by a class toggled a tick after mount.
 *
 * EVERY TEXT LABEL IS HTML, NOT SVG — the same fix StackedAreaChart needed for
 * the same reason. `width="100%"` against a fixed-width `viewBox` with
 * `preserveAspectRatio="none"` stretches the SVG horizontally to fill a wide
 * panel; shape strokes are protected from that with `vectorEffect=
 * "non-scaling-stroke"`, but plain SVG `<text>` has no equivalent protection,
 * so its glyphs were getting stretched by the same non-uniform factor —
 * visible as unnaturally wide lettering once the axis labels were otherwise
 * legible enough to notice it. An HTML element positioned in an absolute
 * overlay over the SVG sits outside that transform entirely.
 */

export interface AnimatedLineChartProps {
  data: { label: string; value: number }[];
  color?: string;
  height?: number;
  valueFormatter?: (value: number) => string;
  /** A meaningful reference line for this domain — e.g. the active
   *  trust_floor threshold — not generic chart chrome. Omit when there is
   *  nothing to compare against. */
  thresholdLine?: { value: number; label: string; color?: string };
  /** The y-axis floor may never go below this, even after padding. Real bug
   *  this closes: a monotonically increasing "money made" curve got a NEGATIVE
   *  axis minimum, because the 12% headroom pad was applied unconditionally —
   *  correct for a series that can dip either way, wrong for one that
   *  structurally can't go below its first value (a cumulative sum) or below
   *  zero (money, a trust score). Pass 0 for either of those; omit it for a
   *  series where the true minimum genuinely needs breathing room below it. */
  clampMin?: number;
  className?: string;
}

const VIEW_W = 1000;
/** Fraction of the width left empty on each side, so the line has visible
 *  breathing room instead of touching the panel's own edges. */
const INSET = 0.015;

export function AnimatedLineChart({
  data,
  color = "var(--entity-agent)",
  height = 160,
  valueFormatter = (n) => n.toFixed(1),
  thresholdLine,
  clampMin,
  className,
}: AnimatedLineChartProps) {
  const gradientId = useId();
  const { svgRef, hoverIndex, onPointerMove, onPointerLeave } = useChartHover(data.length, VIEW_W);
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    // One frame so the browser paints the 0-length state first — without it
    // the transition has nothing to animate FROM and the line just appears.
    const id = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(id);
  }, [data.length]);

  const { min, max, plotH } = useMemo(() => {
    const values = data.map((d) => d.value);
    const lo = Math.min(...values, thresholdLine?.value ?? Infinity);
    const hi = Math.max(...values, thresholdLine?.value ?? -Infinity);
    // A little headroom so the line and its hover dot never clip the edge.
    const pad = Math.max(1, (hi - lo) * 0.12);
    const h = 20;
    // clampMin is applied AFTER padding, not instead of it — the point is to
    // stop the pad from pushing the floor past a value the series can never
    // actually reach, not to remove the pad entirely.
    const paddedMin = lo - pad;
    return {
      min: clampMin !== undefined ? Math.max(paddedMin, clampMin) : paddedMin,
      max: hi + pad,
      plotH: height - h,
    };
  }, [data, thresholdLine, height, clampMin]);

  if (data.length === 0) {
    return (
      <div
        className={`flex items-center justify-center rounded-xl border border-dashed text-[12px] ${className ?? ""}`}
        style={{ height, borderColor: "var(--panel-border-strong)", color: "var(--muted-2)" }}
      >
        No history yet.
      </div>
    );
  }

  // x() stays in SVG units (for the path); xPct() is the same position as a
  // percentage of width, for the HTML label overlay — both read off one inset
  // range so a label and the point it names always agree.
  const x = (i: number) => {
    const t = data.length > 1 ? i / (data.length - 1) : 0.5;
    return (INSET + t * (1 - 2 * INSET)) * VIEW_W;
  };
  const xPct = (i: number) => (x(i) / VIEW_W) * 100;
  const y = (v: number) => plotH - ((v - min) / Math.max(max - min, 1e-6)) * plotH;
  const linePath = data.map((d, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(d.value)}`).join(" ");
  const areaPath = `${linePath} L${x(data.length - 1)},${plotH} L${x(0)},${plotH} Z`;

  const hovered = hoverIndex !== null ? data[hoverIndex] : null;
  const chip = {
    background: "var(--panel)",
    color: "var(--muted-2)",
    border: "1px solid var(--panel-border)",
  } as const;

  return (
    <div className={`relative ${className ?? ""}`} style={{ height }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VIEW_W} ${plotH}`}
        width="100%"
        height={plotH}
        preserveAspectRatio="none"
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        style={{ overflow: "visible", touchAction: "pan-y", display: "block" }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.28} />
            <stop offset="100%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
        </defs>

        {thresholdLine && (
          <line
            x1={0}
            x2={VIEW_W}
            y1={y(thresholdLine.value)}
            y2={y(thresholdLine.value)}
            stroke={thresholdLine.color ?? "var(--decision-block)"}
            strokeWidth={1}
            strokeDasharray="5 4"
            vectorEffect="non-scaling-stroke"
            opacity={0.7}
          />
        )}

        <path d={areaPath} fill={`url(#${gradientId})`} opacity={drawn ? 1 : 0} style={{ transition: "opacity 0.6s ease 0.3s" }} />

        <path
          d={linePath}
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          pathLength={1}
          strokeDasharray={1}
          strokeDashoffset={drawn ? 0 : 1}
          style={{ transition: "stroke-dashoffset 0.9s cubic-bezier(0.16, 1, 0.3, 1)" }}
        />

        {hoverIndex !== null && (
          <>
            <line
              x1={x(hoverIndex)}
              x2={x(hoverIndex)}
              y1={0}
              y2={plotH}
              stroke="var(--muted)"
              strokeWidth={1}
              strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke"
            />
            <circle cx={x(hoverIndex)} cy={y(data[hoverIndex].value)} r={4.5} fill={color} stroke="var(--panel)" strokeWidth={2} />
          </>
        )}
      </svg>

      {/* Every label is HTML, positioned against this same box — the SVG's
          height IS real pixels (only its width is stretched), so vertical
          placement carries straight over with no conversion. */}
      <div className="pointer-events-none absolute inset-0">
        {thresholdLine && (
          <div
            className="absolute whitespace-nowrap text-[10px]"
            style={{
              color: thresholdLine.color ?? "var(--decision-block)",
              opacity: 0.9,
              right: 0,
              top: y(thresholdLine.value) - 14,
            }}
          >
            {thresholdLine.label}
          </div>
        )}

        <div className="absolute rounded px-1.5 py-0.5 text-[10.5px]" style={{ ...chip, left: 0, top: 2 }}>
          {valueFormatter(max)}
        </div>
        <div className="absolute rounded px-1.5 py-0.5 text-[10.5px]" style={{ ...chip, left: 0, top: plotH - 12 }}>
          {valueFormatter(min)}
        </div>

        {[0, data.length - 1].map((i) => (
          <div
            key={i}
            className="absolute whitespace-nowrap text-[10.5px]"
            style={{
              color: "var(--muted-2)",
              left: `${xPct(i)}%`,
              top: plotH + 4,
              transform: `translateX(${i === 0 ? "0%" : "-100%"})`,
            }}
          >
            {data[i].label}
          </div>
        ))}
      </div>

      {hovered && hoverIndex !== null && (
        <div
          className="pointer-events-none absolute top-0 z-20 rounded-lg border px-2 py-1 text-[11px] font-medium shadow-lg"
          style={{
            left: `${xPct(hoverIndex)}%`,
            transform: `translate(${xPct(hoverIndex) < 50 ? "6px" : "calc(-100% - 6px)"}, -2px)`,
            background: "var(--panel)",
            borderColor: "var(--panel-border-strong)",
            color: "var(--foreground)",
          }}
        >
          {valueFormatter(hovered.value)}
          <span className="ml-1.5 font-normal" style={{ color: "var(--muted-2)" }}>
            {hovered.label}
          </span>
        </div>
      )}
    </div>
  );
}
