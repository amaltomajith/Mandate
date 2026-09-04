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
 * different jobs and get different palettes. These are the status one.
 *
 * THE RULE THE WHOLE SCENE FOLLOWS: it is cool and quiet by default, and
 * warmth plus brightness are reserved for things that want a human. Structure
 * recedes, identity anchors, exceptions pop. Before this, everything competed
 * at once -- six hues at full saturation with nothing receding, so the eye had
 * no entry point and the agents, which are the actual subject, did not read as
 * focal.
 *
 * Two consequences worth spelling out, because both were live bugs:
 *
 * 1. RULES ARE NOT A STATUS. A policy is a constraint, not a state something
 *    is in, so it has no business wearing the status vocabulary. It used to be
 *    #fbbf24 -- byte-identical to `escalate`. Since rule edges are coloured by
 *    the DECISION that fired them, amber escalation edges terminated in amber
 *    rule nodes and the two fused into one gold mass. Rules are now a cool
 *    steel: structural, quiet, unmistakably not a verdict, and amber once
 *    again means exactly one thing.
 *
 * 2. THE COMMON CASE MUST RECEDE. `allow` is most of the traffic, so a bright
 *    ring on every allowed action made the least eventful thing the loudest
 *    thing on screen. The hue stays; its PRESENCE does not -- see
 *    tracePresence below.
 *
 * `protocol_reject` also moved off lavender, which it shared with mandates
 * closely enough to be unreadable, onto a dim slate. It is malformed traffic
 * that never reached policy at all, so it should look like noise rather than
 * like a decision someone made.
 */
export const ENTITY_COLORS = {
  // The one entry that deliberately does NOT mirror its CSS variable.
  // `--entity-agent` is the dashboard's general accent -- it paints panel
  // borders, buttons, badges and chart lines across a dozen components -- so
  // repointing it would repaint half the app. This value is the agent's hue
  // INSIDE THE GRAPH only: node, legend swatch, hover badge and the edges
  // running out to its actions, which all have to agree with each other or the
  // legend starts lying about what a colour means.
  //
  // Worth knowing if this is ever revisited: the note above about the palette
  // going monochrome is about folding EVERY entity into violet-and-pink. This
  // is one entity moving to a hot magenta that stays well clear of the two
  // lavender it shares the scene with (mandate #a78bfa) on both saturation and
  // pinkness, and the shapes differ anyway -- agents are a ring-and-core,
  // mandates a small icosahedron.
  agent: "#ff35d5",
  mandate: "#a78bfa",
  // Bright: this is the node body, and the decision ring around it is what
  // carries the verdict. A dark body left the ring nothing to sit against.
  transaction: "#e8ebf7",
  rule: "#a9c3e0",
  customer: "#34d399",
} as const;

/**
 * Mandate status has its OWN values rather than borrowing DECISION_COLORS.
 * Sharing them meant an active mandate's ring was the exact green of an
 * allowed action's ring, so two unrelated vocabularies rendered identically
 * and a change to one silently moved the other.
 */
export const MANDATE_STATUS_COLORS = {
  active: "#4fd8a8",
  paused: "#f0b429",
  revoked: "#ff6b7a",
  expired: "#5c6478",
} as const;

export const DECISION_COLORS = {
  allow: "#3ddc84",
  block: "#ff4d5e",
  escalate: "#fbbf24",
  protocol_reject: "#6c7691",
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

/**
 * How much VISUAL WEIGHT a trace's ring should carry, 0..1.
 *
 * Colour says what happened; this says how loudly to say it, and the two are
 * answered in one place for the same reason traceColor is: so the scene cannot
 * disagree with itself.
 *
 * The scale is deliberately inverted against frequency. Allowed actions are
 * most of the traffic, and giving each a full-strength ring made a swarm of
 * identical bright rings the dominant feature of the scene — the least
 * eventful thing shouting loudest, and the agents it belongs to lost inside
 * it. A routine allow now sits back; the things that stopped, or that are
 * still waiting on a person, keep their full weight.
 *
 * Resolved escalations recede too. They are settled — the queue already says
 * so, and a wall of bright rings for work someone finished contradicts it.
 */
export function tracePresence(
  decision: Trace["decision"],
  escalationStatus?: Escalation["status"] | null
): number {
  if (decision === "escalate") {
    // Still pending is the one thing on this scale that wants a person NOW.
    if (!escalationStatus || escalationStatus === "pending") return 0.9;
    return escalationStatus === "approved" ? 0.4 : 0.3;
  }
  if (decision === "block") return 0.85;
  // Never reached policy at all; it is noise, and should look like it.
  if (decision === "protocol_reject") return 0.35;
  return 0.2;
}
