// Mirrors the CSS custom properties in globals.css. Duplicated deliberately —
// three.js needs raw hex values (it can't resolve var(--x) at render time), so
// these two files are the single pair of places encoding entity/decision color.
// Keep them in sync if either changes (they drifted once already when the
// theme was reworked — check both files together next time).

import type { Escalation, Trace } from "@/types/db";

export const ENTITY_COLORS = {
  agent: "#ffffff",
  mandate: "#7c5cff",
  // Neutral on purpose: a transaction node is just an event. Its RING carries
  // the verdict, and when the sphere was bright too there was nothing for the
  // verdict to contrast against.
  transaction: "#6e6a85",
  rule: "#ff9ffc",
  customer: "#b8b3d9",
} as const;

export const DECISION_COLORS = {
  allow: "#ffffff",
  block: "#ff3b5c",
  escalate: "#ff9ffc",
  protocol_reject: "#c4b5fd",
} as const;

/**
 * The two states an escalation reaches once a human has answered it.
 *
 * `trace.decision` is frozen at "escalate" forever — correctly, because the
 * trace records that a human WAS ASKED, and that never stops being true.
 * Whether anyone has since answered is a separate fact living on the escalation
 * row. The hover label already accounted for that; the color did not, so an
 * escalation approved hours ago still rendered in the same pending amber. On a
 * board with forty answered escalations that made a cleared queue look like a
 * wall of outstanding work, and flatly contradicted the Escalations panel
 * beside it reporting nothing pending.
 *
 * Denied is the quietest color in the set by design. It is settled, nobody has
 * to do anything about it, and it should recede rather than compete with the
 * pending ones that still want a person.
 */
export const ESCALATION_OUTCOME_COLORS = {
  approved: "#6ee7c7",
  denied: "#565270",
} as const;

/**
 * What color a trace node's ring should actually be.
 *
 * The single place that answers it, so the scene, the legend and the hover card
 * cannot disagree about what a node means — which is the failure mode that
 * produced the bug above.
 */
export function traceColor(
  decision: Trace["decision"],
  escalationStatus?: Escalation["status"] | null
): string {
  if (decision === "escalate" && escalationStatus && escalationStatus !== "pending") {
    return ESCALATION_OUTCOME_COLORS[escalationStatus];
  }
  return DECISION_COLORS[decision];
}
