// Mirrors the CSS custom properties in globals.css. Duplicated deliberately —
// three.js needs raw hex values (it can't resolve var(--x) at render time), so
// these two files are the single pair of places encoding entity/decision color.
// Keep them in sync if either changes (they drifted once already when the
// theme was reworked — check both files together next time).

import type { Escalation, Trace } from "@/types/db";

/**
 * Semantic colour is NOT the brand accent.
 *
 * These were briefly folded into the violet-and-pink brand palette, and the
 * graph went monochrome: every node kind rendered as a shade of the same hue,
 * so the one thing the scene exists to do -- let you tell an agent from a rule
 * from an action at a glance -- stopped working. Worse, painting agents white
 * turned their aura into a grey wash that bloom then blew out into pale blobs.
 *
 * Brand identity (violet on black) and status vocabulary (green/amber/red) are
 * different jobs and get different palettes. These are the status one: six hues
 * spread far enough around the wheel to survive a small ring at a distance,
 * saturated harder than the originals so they hold up against bloom.
 */
export const ENTITY_COLORS = {
  agent: "#4d9fff",
  mandate: "#a78bfa",
  // Bright: this is the node body, and the decision ring around it is what
  // carries the verdict. A dark body left the ring nothing to sit against.
  transaction: "#e8ebf7",
  rule: "#fbbf24",
  customer: "#34d399",
} as const;

export const DECISION_COLORS = {
  allow: "#3ddc84",
  block: "#ff4d5e",
  escalate: "#fbbf24",
  protocol_reject: "#c084fc",
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
  // Cyan rather than another green. It has to be legible NEXT TO `allow`,
  // because the distinction it draws -- cleared automatically vs cleared by a
  // person -- is the one the revenue panel is built on. Two greens would have
  // collapsed exactly the difference this colour exists to show.
  approved: "#22d3ee",
  denied: "#6f6880",
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
