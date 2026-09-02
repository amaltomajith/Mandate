"use client";

import { useRef, useEffect, useState, useMemo, useId } from "react";

/**
 * Text running along a curved path, looping forever, draggable.
 *
 * Adapted from the React Bits CurvedLoop. Three changes:
 *
 *   - The original stylesheet puts `min-height: 100vh` on the wrapper, which is
 *     right for a full-page showpiece and wrong for the band this is used as.
 *     Height comes from the SVG aspect ratio instead.
 *   - It fills with `currentColor` rather than hard white, so the band can be
 *     tinted by whatever section it sits in.
 *   - Under `prefers-reduced-motion` the text is placed once and left alone.
 *     Dragging still works — that motion is the reader's own doing.
 *
 * The CSS lives inline because it is nine declarations; a stylesheet import for
 * that is more moving parts than it is worth.
 */

export interface CurvedLoopProps {
  marqueeText?: string;
  speed?: number;
  className?: string;
  curveAmount?: number;
  direction?: "left" | "right";
  interactive?: boolean;
}

export default function CurvedLoop({
  marqueeText = "",
  speed = 2,
  className,
  curveAmount = 400,
  direction = "left",
  interactive = true,
}: CurvedLoopProps) {
  const text = useMemo(() => {
    const hasTrailing = /\s| $/.test(marqueeText);
    return (hasTrailing ? marqueeText.replace(/\s+$/, "") : marqueeText) + " ";
  }, [marqueeText]);

  const measureRef = useRef<SVGTextElement>(null);
  const textPathRef = useRef<SVGTextPathElement>(null);
  const [spacing, setSpacing] = useState(0);
  const uid = useId();
  // useId emits colons, which are not valid in a fragment identifier used by
  // href="#..." — strip them or the textPath silently binds to nothing.
  const pathId = `curve-${uid.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const pathD = `M-100,40 Q500,${40 + curveAmount} 1540,40`;

  /**
   * The scroll position lives in a ref, not in state.
   *
   * The original stores it in both: it writes `startOffset` imperatively AND
   * calls setState with the same number, every animation frame. The state is
   * never read for anything but the initial attribute, so the second half is
   * sixty React renders a second that change nothing -- enough, on a page that
   * is also running a WebGL hero, to stall rendering outright. Only the
   * attribute write survives here.
   */
  const offsetRef = useRef(0);
  const dragRef = useRef(false);
  const lastXRef = useRef(0);
  const dirRef = useRef(direction);
  const velRef = useRef(0);

  const ready = spacing > 0;
  const totalText = ready
    ? Array(Math.ceil(1800 / spacing) + 2)
        .fill(text)
        .join("")
    : text;

  useEffect(() => {
    if (measureRef.current) setSpacing(measureRef.current.getComputedTextLength());
  }, [text, className]);

  useEffect(() => {
    if (!spacing || !textPathRef.current) return;
    offsetRef.current = -spacing;
    textPathRef.current.setAttribute("startOffset", `${offsetRef.current}px`);
  }, [spacing]);

  useEffect(() => {
    if (!ready) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let frame = 0;
    const step = () => {
      if (!dragRef.current && textPathRef.current) {
        const delta = dirRef.current === "right" ? speed : -speed;
        let next = offsetRef.current + delta;
        if (next <= -spacing) next += spacing;
        if (next > 0) next -= spacing;
        offsetRef.current = next;
        textPathRef.current.setAttribute("startOffset", `${next}px`);
      }
      frame = requestAnimationFrame(step);
    };

    // Only animates while on screen. Without this the band keeps running the
    // whole time someone is reading a section four screens away.
    let observing = false;
    const start = () => {
      if (!observing) {
        observing = true;
        frame = requestAnimationFrame(step);
      }
    };
    const stop = () => {
      observing = false;
      cancelAnimationFrame(frame);
    };
    const host = textPathRef.current?.ownerSVGElement;
    const io = host
      ? new IntersectionObserver(([e]) => (e.isIntersecting ? start() : stop()), { threshold: 0 })
      : null;
    if (io && host) io.observe(host);
    else start();

    return () => {
      stop();
      io?.disconnect();
    };
  }, [spacing, speed, ready]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!interactive) return;
    dragRef.current = true;
    lastXRef.current = e.clientX;
    velRef.current = 0;
    (e.target as Element).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!interactive || !dragRef.current || !textPathRef.current) return;
    const dx = e.clientX - lastXRef.current;
    lastXRef.current = e.clientX;
    velRef.current = dx;

    let next = offsetRef.current + dx;
    if (next <= -spacing) next += spacing;
    if (next > 0) next -= spacing;
    offsetRef.current = next;
    textPathRef.current.setAttribute("startOffset", `${next}px`);
  };

  const endDrag = () => {
    if (!interactive) return;
    dragRef.current = false;
    dirRef.current = velRef.current > 0 ? "right" : "left";
  };

  return (
    <div
      style={{
        visibility: ready ? "visible" : "hidden",
        cursor: interactive ? "grab" : "auto",
        width: "100%",
        display: "flex",
        alignItems: "center",
        touchAction: "pan-y",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerLeave={endDrag}
    >
      <svg
        viewBox="0 0 1440 120"
        role="img"
        aria-label={marqueeText}
        style={{
          userSelect: "none",
          width: "100%",
          aspectRatio: "100 / 12",
          overflow: "visible",
          display: "block",
          fill: "currentColor",
          lineHeight: 1,
        }}
      >
        <text
          ref={measureRef}
          xmlSpace="preserve"
          className={className}
          style={{ visibility: "hidden", opacity: 0, pointerEvents: "none" }}
        >
          {text}
        </text>
        <defs>
          <path id={pathId} d={pathD} fill="none" stroke="transparent" />
        </defs>
        {ready && (
          <text xmlSpace="preserve" className={className}>
            {/* No startOffset here on purpose: the effect above places it and
                the loop drives it. Binding it to a React value would mean every
                unrelated re-render snapped the band back to a stale position. */}
            <textPath ref={textPathRef} href={`#${pathId}`} xmlSpace="preserve">
              {totalText}
            </textPath>
          </text>
        )}
      </svg>
    </div>
  );
}
