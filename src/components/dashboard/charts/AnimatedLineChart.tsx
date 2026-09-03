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

  const x = (i: number) => (data.length > 1 ? (i / (data.length - 1)) * VIEW_W : VIEW_W / 2);
  const y = (v: number) => plotH - ((v - min) / Math.max(max - min, 1e-6)) * plotH;
  const linePath = data.map((d, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(d.value)}`).join(" ");
  const areaPath = `${linePath} L${x(data.length - 1)},${plotH} L${x(0)},${plotH} Z`;

  const hovered = hoverIndex !== null ? data[hoverIndex] : null;

  return (
    <div className={`relative ${className ?? ""}`}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VIEW_W} ${height}`}
        width="100%"
        height={height}
        preserveAspectRatio="none"
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        style={{ overflow: "visible", touchAction: "pan-y" }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.28} />
            <stop offset="100%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
        </defs>

        {thresholdLine && (
          <>
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
            <text
              x={VIEW_W}
              y={y(thresholdLine.value) - 5}
              fontSize={10}
              textAnchor="end"
              fill={thresholdLine.color ?? "var(--decision-block)"}
              opacity={0.85}
            >
              {thresholdLine.label}
            </text>
          </>
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

        <text x={4} y={12} fontSize={10.5} fill="var(--muted-2)">
          {valueFormatter(max)}
        </text>
        <text x={4} y={plotH - 4} fontSize={10.5} fill="var(--muted-2)">
          {valueFormatter(min)}
        </text>

        {[0, data.length - 1].map((i) => (
          <text
            key={i}
            x={x(i)}
            y={height - 6}
            fontSize={10.5}
            textAnchor={i === 0 ? "start" : "end"}
            fill="var(--muted-2)"
          >
            {data[i].label}
          </text>
        ))}
      </svg>

      {hovered && hoverIndex !== null && (
        <div
          className="pointer-events-none absolute top-0 z-20 rounded-lg border px-2 py-1 text-[11px] font-medium shadow-lg"
          style={{
            left: `${data.length > 1 ? (hoverIndex / (data.length - 1)) * 100 : 50}%`,
            transform: `translate(${hoverIndex < data.length / 2 ? "6px" : "calc(-100% - 6px)"}, -2px)`,
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
