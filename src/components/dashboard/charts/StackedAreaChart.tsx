"use client";

import { useId, useMemo, type CSSProperties, type ReactNode } from "react";
import { useChartHover } from "./useChartHover";

/**
 * A stacked area timeline with a rich hover tooltip — the shape asked for by
 * the Tremor/`AreaChart` reference, hand-rolled rather than pulling in
 * Recharts for one chart. This project's other visuals (the entity graph, the
 * decision-flow figure) are all inline SVG with no charting dependency, and a
 * five-category stack over a few dozen points doesn't need one either.
 *
 * Deliberately straight-segment, not curve-smoothed. A smoothed stacked area
 * can overshoot past its neighbours at a sharp turn — the classic bug where a
 * bezier control point pushes a layer's boundary above the one stacked on top
 * of it for a few pixels. Straight segments can't do that, and at this data
 * density (day/hour buckets) the smoothing would be decorative, not legible.
 *
 * EVERY TEXT LABEL IS HTML, NOT SVG. The SVG here is stretched on purpose —
 * `width="100%"` against a fixed 1000-unit `viewBox` with
 * `preserveAspectRatio="none"` is what makes a 30-bucket chart fill a wide
 * panel responsively. Shape strokes are protected from that stretch with
 * `vectorEffect="non-scaling-stroke"`, but plain SVG `<text>` has no
 * equivalent protection — its glyphs get stretched by the same non-uniform
 * factor as the geometry, which reads as wide, distorted lettering the moment
 * the container is wider than it is tall (every panel this renders in). That
 * was shipped and unnoticed for a few iterations because two other bugs
 * (a stray label collision, and axis text with no backing) were loud enough
 * to fix first — once those were gone, the stretching was the next thing
 * visible. HTML text sitting in an absolutely-positioned overlay over the SVG
 * is never inside its coordinate transform, so it can't be stretched by it;
 * this is the same technique the hover tooltip already used, extended to
 * every other label.
 */

export interface StackedAreaSeries {
  key: string;
  label: string;
  color: string;
}

export interface StackedAreaChartProps<T extends object> {
  data: T[];
  /** The field on each point holding its x-axis label. */
  indexKey: keyof T & string;
  series: StackedAreaSeries[];
  valueFormatter?: (value: number) => string;
  height?: number;
  /** Render prop for the hover tooltip — the caller owns its content (the
   *  reference's `customTooltip`), this component owns positioning and which
   *  point is nearest the cursor. */
  renderTooltip?: (point: T, index: number) => ReactNode;
  className?: string;
}

const VIEW_W = 1000;
/** Fraction of the width left empty on each side, so the plotted shape has
 *  visible breathing room instead of touching the panel's own edges. */
const INSET = 0.015;

export function StackedAreaChart<T extends object>({
  data,
  indexKey,
  series,
  valueFormatter = (n) => n.toLocaleString("en-IN"),
  height = 220,
  renderTooltip,
  className,
}: StackedAreaChartProps<T>) {
  const gradientId = useId();
  const { svgRef, hoverIndex, onPointerMove, onPointerLeave } = useChartHover(data.length, VIEW_W);

  // Read through an untyped view once, here — every generic T this component
  // is actually called with (the revenue timeline today) is a plain record of
  // numbers keyed by category, but the public prop type stays T rather than
  // Record<string, unknown> so a caller's `renderTooltip` gets its real,
  // narrow type back instead of `unknown` on every field.
  const rows = data as unknown as Record<string, unknown>[];

  const { layers, maxTotal, plotH, clipped } = useMemo(() => {
    const axisH = 22; // reserved for x-axis labels
    const plotHeight = height - axisH;
    const totals = rows.map((d) => series.reduce((sum, s) => sum + (Number(d[s.key]) || 0), 0));
    const trueMax = Math.max(1, ...totals);

    /**
     * A single extreme bucket on a LINEAR, shared axis crushes every other
     * bucket flat — the real bug a screenshot caught: one bucket at ~3.66L
     * against neighbours in the hundreds made 29 of 30 buckets unreadable.
     * The fix is a cap on RENDERED height only, computed from a percentile of
     * the bucket totals (robust to exactly the single-outlier case this
     * exists for) rather than the true max. Only engages with enough buckets
     * to make a percentile meaningful (below that, this behaves exactly as
     * before — cap equals the true max, nothing is ever compressed).
     *
     * The values themselves are NEVER altered where they're reported: the
     * hover tooltip reads straight from `data`, untouched, and every clipped
     * bucket gets its true total stated in a marker label right on the chart.
     * Only the SHAPE — where the fill and stroke are drawn — is compressed.
     */
    let cap = trueMax;
    if (totals.length >= 8) {
      const sorted = [...totals].sort((a, b) => a - b);
      const p90 = sorted[Math.floor(0.9 * (sorted.length - 1))];
      // Never cap below something a normal-sized bucket would still clear —
      // a flat or near-uniform dataset should never get compressed just
      // because the 90th percentile happens to sit under the true max.
      if (p90 > 0 && p90 < trueMax * 0.85) cap = p90;
    }

    // Per-bucket scale: 1 everywhere except where the true total exceeds the
    // cap, where every category at that bucket is scaled down by the same
    // factor — proportions BETWEEN categories in that one bucket are
    // preserved exactly; only the bucket's overall height is compressed.
    const scale = totals.map((t) => (t > cap ? cap / t : 1));
    const clippedPoints = totals
      .map((t, i) => ({ i, trueTotal: t, isClipped: scale[i] < 1 }))
      .filter((c) => c.isClipped);

    // Cumulative stack over the SCALED per-category values, not the raw ones
    // — restacking scaled inputs keeps every layer's own proportion correct
    // at a clipped bucket, rather than scaling already-cumulative tops after
    // the fact and compounding rounding across layers.
    const built = series.reduce<{ s: StackedAreaSeries; top: number[]; bottom: number[] }[]>((acc, s) => {
      const baseline = acc.length > 0 ? acc[acc.length - 1].top : rows.map(() => 0);
      const top = rows.map((d, i) => baseline[i] + (Number(d[s.key]) || 0) * scale[i]);
      acc.push({ s, top, bottom: baseline });
      return acc;
    }, []);
    return { layers: built, maxTotal: cap, plotH: plotHeight, clipped: clippedPoints };
  }, [rows, series, height]);

  if (data.length === 0) {
    return (
      <div
        className={`flex items-center justify-center rounded-xl border border-dashed text-[12px] ${className ?? ""}`}
        style={{ height, borderColor: "var(--panel-border-strong)", color: "var(--muted-2)" }}
      >
        Nothing to chart yet.
      </div>
    );
  }

  // x() stays in SVG units (for paths); xPct() is the SAME position expressed
  // as a percentage of width, for the HTML overlay labels — both read off one
  // inset range so a label and the point it names always line up.
  const x = (i: number) => {
    const t = data.length > 1 ? i / (data.length - 1) : 0.5;
    return (INSET + t * (1 - 2 * INSET)) * VIEW_W;
  };
  const xPct = (i: number) => (x(i) / VIEW_W) * 100;
  const y = (v: number) => plotH - (v / maxTotal) * plotH;
  const pathFor = (values: number[], baseline: number[]) => {
    const top = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(v)}`).join(" ");
    const bottom = [...baseline]
      .map((v, i) => `L${x(i)},${y(v)}`)
      .reverse()
      .join(" ");
    return `${top} ${bottom} Z`;
  };

  const hovered = hoverIndex !== null ? data[hoverIndex] : null;
  // Ticks thin out so labels never overlap — every point at 30 buckets is
  // unreadable, every 5th is not.
  const labelEvery = Math.max(1, Math.ceil(data.length / 8));

  const chip: CSSProperties = {
    background: "var(--panel)",
    color: "var(--muted-2)",
    border: "1px solid var(--panel-border)",
  };

  return (
    <div className={className}>
      {/* Fixed to exactly `height` — every absolute label below is positioned
          against THIS box, including the x-axis row reserved in `plotH`'s
          22px axisH gap. The legend deliberately lives OUTSIDE it, in normal
          flow below, rather than being squeezed inside a box whose height is
          locked to the plot area — that was a real bug in the first draft of
          this rewrite, caught before it shipped: the legend would have
          overflowed past its reserved space and overlapped whatever the panel
          renders next. */}
      <div className="relative" style={{ height }}>
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
          {layers.map(({ s }) => (
            <linearGradient key={s.key} id={`${gradientId}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity={0.32} />
              <stop offset="100%" stopColor={s.color} stopOpacity={0.03} />
            </linearGradient>
          ))}
        </defs>

        {/* Gridlines: three, quiet, unlabeled decoration except at the axis. */}
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1={0}
            x2={VIEW_W}
            y1={plotH * f}
            y2={plotH * f}
            stroke="var(--panel-border)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <line x1={0} x2={VIEW_W} y1={plotH} y2={plotH} stroke="var(--panel-border-strong)" strokeWidth={1} vectorEffect="non-scaling-stroke" />

        {layers.map(({ s, top, bottom }) => (
          <g key={s.key}>
            <path d={pathFor(top, bottom)} fill={`url(#${gradientId}-${s.key})`} />
            <path
              d={top.map((v, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(v)}`).join(" ")}
              fill="none"
              stroke={s.color}
              strokeWidth={1.75}
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
            />
          </g>
        ))}

        {clipped.map(({ i }) => (
          <line
            key={`clip-${i}`}
            x1={x(i)}
            x2={x(i)}
            y1={2}
            y2={14}
            stroke="var(--muted)"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {hoverIndex !== null && (
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
        )}
      </svg>

      {/* Every label below is a plain HTML element, positioned by percentage
          (horizontal) or by pixel (vertical — the SVG's height IS real
          pixels; only its width is stretched, so vertical placement needs no
          conversion). None of this sits inside the SVG's transform, so none
          of it can be stretched by it. */}
      <div className="pointer-events-none absolute inset-0">
        {/* Where a bucket's true height was compressed to fit the cap, its
            real total is stated directly, right above the clipped peak. */}
        {clipped.map(({ i, trueTotal }) => {
          const pct = xPct(i);
          const edge = pct < 12 ? "start" : pct > 88 ? "end" : "middle";
          return (
            <div
              key={`clip-${i}`}
              className="absolute whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium"
              style={{
                ...chip,
                left: `${pct}%`,
                top: 18,
                transform: `translateX(${edge === "start" ? "0%" : edge === "end" ? "-100%" : "-50%"})`,
              }}
            >
              actual {valueFormatter(trueTotal)}
            </div>
          );
        })}

        {/* The y-axis "max" reading is only ever shown when nothing was
            clipped — once a bucket's rendered height is compressed, this
            number is a percentile cutoff, not a true maximum, and printing it
            plainly beside a bucket labelled with a BIGGER "actual" figure
            reads as contradictory. The per-bucket labels above already carry
            every large number that matters. */}
        {clipped.length === 0 && (
          <div className="absolute rounded px-1.5 py-0.5 text-[10.5px]" style={{ ...chip, left: 0, top: 2 }}>
            {valueFormatter(maxTotal)}
          </div>
        )}
        <div className="absolute rounded px-1.5 py-0.5 text-[10.5px]" style={{ ...chip, left: 0, top: plotH - 12 }}>
          0
        </div>

        {/* x-axis labels, thinned to fit */}
        {data.map((d, i) => {
          if (i % labelEvery !== 0) return null;
          const pct = xPct(i);
          const edge = i === 0 ? "start" : i === data.length - 1 ? "end" : "middle";
          return (
            <div
              key={i}
              className="absolute whitespace-nowrap text-[10.5px]"
              style={{
                color: "var(--muted-2)",
                left: `${pct}%`,
                top: plotH + 4,
                transform: `translateX(${edge === "start" ? "0%" : edge === "end" ? "-100%" : "-50%"})`,
              }}
            >
              {String(d[indexKey])}
            </div>
          );
        })}
      </div>

      {hovered && hoverIndex !== null && renderTooltip && (
        <div
          className="pointer-events-none absolute top-0 z-20 -translate-y-2"
          style={{
            left: `${xPct(hoverIndex)}%`,
            transform: `translate(${xPct(hoverIndex) < 50 ? "0" : "-100%"}, -4px)`,
          }}
        >
          {renderTooltip(hovered, hoverIndex)}
        </div>
      )}
      </div>

      {/* Legend — outside the fixed-height box above, in normal flow. */}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        {series.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5 text-[10.5px]" style={{ color: "var(--muted)" }}>
            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}
