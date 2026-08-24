interface Props {
  hasAgents: boolean;
  hasRules: boolean;
  hasTraces: boolean;
}

const STEPS = [
  { key: "rules" as const, cmd: "npm run seed", label: "Seed the starter policy rules" },
  { key: "agents" as const, cmd: "npm run gen-agent-key -- \"Checkout Agent\"", label: "Register a signed agent identity" },
  { key: "traces" as const, cmd: "npm run demo:checkout", label: "Run the demo — a few payouts, one escalation, one blocked forgery attempt" },
];

/**
 * Self-resolving onboarding: shows exactly the setup steps that haven't
 * happened yet, in order, then disappears once real data exists — no dismiss
 * button or localStorage needed, the data itself is the state.
 */
export function GettingStartedBanner({ hasAgents, hasRules, hasTraces }: Props) {
  const done = { rules: hasRules, agents: hasAgents, traces: hasTraces };
  if (done.rules && done.agents && done.traces) return null;

  return (
    <div className="panel-card rounded-2xl border-l-4 p-5" style={{ borderLeftColor: "var(--brand-blue)" }}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold">Get the graph moving</p>
          <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--muted)" }}>
            The panels on the right and the graph on the left are wired to real Supabase
            data — they&apos;re quiet right now because nothing has happened yet. Run these
            from the project root, in order:
          </p>
        </div>
        <span
          className="shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold"
          style={{ background: "color-mix(in srgb, var(--brand-blue) 18%, transparent)", color: "var(--brand-blue)" }}
        >
          {Object.values(done).filter(Boolean).length}/3 done
        </span>
      </div>

      <ol className="mt-4 space-y-2.5">
        {STEPS.map((step, i) => {
          const isDone = done[step.key];
          return (
            <li key={step.key} className="flex items-center gap-3">
              <span
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold"
                style={{
                  background: isDone ? "var(--decision-allow)" : "var(--panel-2)",
                  color: isDone ? "white" : "var(--muted-2)",
                  border: isDone ? "none" : "1px solid var(--panel-border-strong)",
                }}
              >
                {isDone ? "✓" : i + 1}
              </span>
              <code
                className="rounded-md px-2 py-1 font-mono text-[12px]"
                style={{ background: "var(--panel-2)", color: isDone ? "var(--muted-2)" : "var(--foreground)", textDecoration: isDone ? "line-through" : "none" }}
              >
                {step.cmd}
              </code>
              <span className="text-xs" style={{ color: "var(--muted)" }}>
                {step.label}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
