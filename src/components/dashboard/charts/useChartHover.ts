"use client";

import { useCallback, useRef, useState } from "react";

/**
 * "Which data point is the cursor closest to" — the one piece of interaction
 * logic both charts in this folder need, in one place rather than two.
 *
 * Works in the SVG's own coordinate space (the `viewBox`, not screen pixels),
 * because both charts render at `viewBox="0 0 width height"` and scale via
 * CSS — reading `getBoundingClientRect()` and rescaling by the element's
 * *rendered* size is what makes the hover point track the cursor correctly at
 * any width, including inside a responsive panel that resizes the SVG without
 * re-rendering it.
 */
export function useChartHover(pointCount: number, viewBoxWidth: number) {
  const [index, setIndex] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);

  const onMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (pointCount === 0 || !ref.current) return;
      const rect = ref.current.getBoundingClientRect();
      if (rect.width === 0) return;
      const xInViewBox = ((e.clientX - rect.left) / rect.width) * viewBoxWidth;
      const step = pointCount > 1 ? viewBoxWidth / (pointCount - 1) : viewBoxWidth;
      const nearest = Math.round(xInViewBox / step);
      setIndex(Math.max(0, Math.min(pointCount - 1, nearest)));
    },
    [pointCount, viewBoxWidth]
  );

  const onLeave = useCallback(() => setIndex(null), []);

  return { svgRef: ref, hoverIndex: index, onPointerMove: onMove, onPointerLeave: onLeave };
}
