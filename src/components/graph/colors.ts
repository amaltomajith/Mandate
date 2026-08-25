// Mirrors the CSS custom properties in globals.css. Duplicated deliberately —
// three.js needs raw hex values (it can't resolve var(--x) at render time), so
// these two files are the single pair of places encoding entity/decision color.
// Keep them in sync if either changes (they drifted once already when the
// theme was reworked — check both files together next time).

export const ENTITY_COLORS = {
  agent: "#4f9dff",
  mandate: "#a78bfa",
  transaction: "#e4e7f2",
  rule: "#f5b342",
  customer: "#34d399",
} as const;

export const DECISION_COLORS = {
  allow: "#34d399",
  block: "#f87171",
  escalate: "#f5b342",
  protocol_reject: "#c084fc",
} as const;
