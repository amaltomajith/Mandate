// Mirrors the CSS custom properties in globals.css. Duplicated deliberately —
// three.js needs raw hex values (it can't resolve var(--x) at render time), so
// these two files are the single pair of places encoding entity/decision color.
// Keep them in sync if either changes.

export const ENTITY_COLORS = {
  agent: "#5b8def",
  mandate: "#a475f5",
  transaction: "#c7cbd6",
  rule: "#e0a941",
  customer: "#4fbf7f",
} as const;

export const DECISION_COLORS = {
  allow: "#3ecf7e",
  block: "#f0555a",
  escalate: "#e0a941",
  protocol_reject: "#b25be0",
} as const;
