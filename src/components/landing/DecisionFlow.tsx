/**
 * The path one agent request actually takes, drawn as the code runs it.
 *
 * Worth drawing rather than describing because the ORDER is the product: an
 * unsigned request never reaches the mandate gate, and a request outside its
 * mandate never reaches the policy engine. Prose flattens that into a list;
 * the picture keeps it a sequence, and shows that all three outcomes — not
 * just the refusals — end up in the same trace log.
 */

const BOX = { y: 132, h: 52 };

const STAGES = [
  { x: 16, w: 108, label: "Agent", sub: "third party", color: "var(--entity-agent)" },
  { x: 176, w: 132, label: "Protocol", sub: "signature · nonce" },
  { x: 360, w: 132, label: "Mandate", sub: "scope · expiry" },
  { x: 544, w: 148, label: "Policy engine", sub: "first match wins" },
];

const OUTCOMES = [
  { y: 40, label: "allow", sub: "executes on Razorpay", color: "var(--decision-allow)" },
  { y: 132, label: "escalate", sub: "waits for a human", color: "var(--decision-escalate)" },
  { y: 224, label: "block", sub: "refused, with a reason", color: "var(--decision-block)" },
];

const OUT_X = 744;
const OUT_W = 150;
const OUT_H = 52;

export function DecisionFlow() {
  return (
    <figure className="m-0">
      <div className="overflow-x-auto">
        <svg
          viewBox="0 0 1000 316"
          role="img"
          aria-label="An agent request passes a protocol check, then a mandate gate, then the policy engine, which returns allow, escalate, or block. All three outcomes are written to the trace log."
          style={{ minWidth: 760, width: "100%", height: "auto", color: "var(--muted)" }}
        >
          <defs>
            <marker
              id="df-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
            </marker>
          </defs>

          {/* The pipeline. Each stage can only be reached by passing the one
              before it, which is why they sit on a single line. */}
          {STAGES.map((s) => (
            <g key={s.label}>
              <rect
                x={s.x}
                y={BOX.y}
                width={s.w}
                height={BOX.h}
                rx="10"
                fill="var(--panel-2)"
                stroke={s.color ?? "var(--panel-border-strong)"}
                strokeWidth="1"
              />
              <text
                x={s.x + s.w / 2}
                y={BOX.y + 21}
                textAnchor="middle"
                fontSize="13"
                fontWeight="600"
                fill={s.color ?? "var(--foreground)"}
              >
                {s.label}
              </text>
              <text
                x={s.x + s.w / 2}
                y={BOX.y + 38}
                textAnchor="middle"
                fontSize="10.5"
                fill="var(--muted-2)"
              >
                {s.sub}
              </text>
            </g>
          ))}

          {[
            { x1: 124, x2: 176, label: "signed" },
            { x1: 308, x2: 360, label: "verified" },
            { x1: 492, x2: 544, label: "in scope" },
          ].map((a) => (
            <g key={a.label}>
              <line
                x1={a.x1}
                y1={BOX.y + BOX.h / 2}
                x2={a.x2 - 8}
                y2={BOX.y + BOX.h / 2}
                stroke="currentColor"
                strokeWidth="1.25"
                markerEnd="url(#df-arrow)"
              />
              <text
                x={(a.x1 + a.x2) / 2}
                y={BOX.y - 8}
                textAnchor="middle"
                fontSize="10"
                fill="var(--muted-2)"
              >
                {a.label}
              </text>
            </g>
          ))}

          {/* The fan-out. Exactly one of these fires per request. */}
          {OUTCOMES.map((o) => {
            const midY = o.y + OUT_H / 2;
            const startX = 692;
            const startY = BOX.y + BOX.h / 2;
            return (
              <g key={o.label}>
                <path
                  d={`M ${startX} ${startY} C ${startX + 30} ${startY}, ${OUT_X - 38} ${midY}, ${OUT_X - 8} ${midY}`}
                  fill="none"
                  stroke={o.color}
                  strokeWidth="1.25"
                  opacity="0.7"
                  markerEnd="url(#df-arrow)"
                  style={{ color: o.color }}
                />
                <rect
                  x={OUT_X}
                  y={o.y}
                  width={OUT_W}
                  height={OUT_H}
                  rx="10"
                  fill="var(--panel-2)"
                  stroke={o.color}
                  strokeWidth="1"
                />
                <text
                  x={OUT_X + 14}
                  y={o.y + 21}
                  fontSize="12.5"
                  fontWeight="600"
                  fill={o.color}
                  style={{ fontFamily: "var(--font-geist-mono), ui-monospace, monospace" }}
                >
                  {o.label}
                </text>
                <text x={OUT_X + 14} y={o.y + 38} fontSize="10.5" fill="var(--muted-2)">
                  {o.sub}
                </text>
              </g>
            );
          })}

          {/* Every outcome lands here, including the ones that refused. An audit
              log that only records failures cannot answer "why did this go
              through", which is the question a merchant actually asks. */}
          <path
            d={`M ${OUT_X + OUT_W} 66 C 950 66, 952 120, 952 140`}
            fill="none"
            stroke="var(--panel-border-strong)"
            strokeWidth="1.25"
          />
          <path
            d={`M ${OUT_X + OUT_W} 158 L 944 158`}
            fill="none"
            stroke="var(--panel-border-strong)"
            strokeWidth="1.25"
          />
          <path
            d={`M ${OUT_X + OUT_W} 250 C 950 250, 952 196, 952 176`}
            fill="none"
            stroke="var(--panel-border-strong)"
            strokeWidth="1.25"
          />
          <line
            x1="952"
            y1="158"
            x2="952"
            y2="158"
            stroke="var(--panel-border-strong)"
            strokeWidth="1.25"
          />
          <text
            x="972"
            y="152"
            textAnchor="middle"
            fontSize="11"
            fontWeight="600"
            fill="var(--entity-transaction)"
            transform="rotate(90 972 152)"
          >
            trace log
          </text>
        </svg>
      </div>
      <figcaption className="mt-4 text-[12.5px] leading-relaxed" style={{ color: "var(--muted-2)" }}>
        Each stage is a gate on the one after it. An unsigned request never reaches the mandate
        check; a request outside its mandate never reaches the policy engine. All three outcomes are
        written to the same trace log — an audit trail that records only refusals cannot answer why
        something was allowed.
      </figcaption>
    </figure>
  );
}
