"use client";

import { useId, useMemo, type ReactNode } from "react";
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

  const { layers, maxTotal, plotH } = useMemo(() => {
    const axisH = 22; // reserved for x-axis labels
    const plotHeight = height - axisH;
    const totals = rows.map((d) => series.reduce((sum, s) => sum + (Number(d[s.key]) || 0), 0));
    const max = Math.max(1, ...totals);

    // Cumulative stack: each series' baseline is the sum of every series
    // before it, so the fills sit on top of one another rather than
    // overlapping. Built with reduce rather than a reassigned outer `let` —
    // the previous version mutated a variable captured by the map callback
    // across iterations, which reads correctly but is exactly the shape
    // React's hooks lint now flags as unsafe mutation inside a memo.
    const built = series.reduce<{ s: StackedAreaSeries; top: number[]; bottom: number[] }[]>((acc, s) => {
      const baseline = acc.length > 0 ? acc[acc.length - 1].top : rows.map(() => 0);
      const top = rows.map((d, i) => baseline[i] + (Number(d[s.key]) || 0));
      acc.push({ s, top, bottom: baseline });
      return acc;
    }, []);
    return { layers: built, maxTotal: max, plotH: plotHeight };
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

  const x = (i: number) => (data.length > 1 ? (i / (data.length - 1)) * VIEW_W : VIEW_W / 2);
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

        {/* Two y-axis readings — the top of the stack and zero — rather than a
            dense tick ladder. Drawn AFTER the fills, not before: this text sat
            behind the topmost layer's gradient in an earlier pass, since SVG
            paints later siblings on top of earlier ones and the leftmost
            column can reach nearly to the top of the plot. A small dark
            backing rect keeps it legible over whichever fill sits under it. */}
        <rect x={0} y={2} width={70} height={14} fill="var(--panel)" opacity={0.85} rx={2} />
        <text x={4} y={12} fontSize={10.5} fill="var(--muted-2)">
          {valueFormatter(maxTotal)}
        </text>
        <text x={4} y={plotH - 4} fontSize={10.5} fill="var(--muted-2)">
          0
        </text>

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

        {/* x-axis labels, thinned to fit */}
        {data.map((d, i) =>
          i % labelEvery === 0 ? (
            <text
              key={i}
              x={x(i)}
              y={height - 6}
              fontSize={10.5}
              textAnchor={i === 0 ? "start" : i === data.length - 1 ? "end" : "middle"}
              fill="var(--muted-2)"
            >
              {String(d[indexKey])}
            </text>
          ) : null
        )}
      </svg>

      {hovered && hoverIndex !== null && renderTooltip && (
        <div
          className="pointer-events-none absolute top-0 z-20 -translate-y-2"
          style={{
            left: `${data.length > 1 ? (hoverIndex / (data.length - 1)) * 100 : 50}%`,
            transform: `translate(${hoverIndex < data.length / 2 ? "0" : "-100%"}, -4px)`,
          }}
        >
          {renderTooltip(hovered, hoverIndex)}
        </div>
      )}

      {/* Legend */}
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
