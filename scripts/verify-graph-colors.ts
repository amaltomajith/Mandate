/**
 * What colour a node in the entity graph is allowed to be.
 *
 * This exists because of a real bug: `trace.decision` freezes at "escalate"
 * forever -- correctly, since the trace records that a human WAS ASKED and that
 * never stops being true -- so colouring from it alone painted every escalation
 * the same pending shade for the rest of time. A board carrying forty answered
 * escalations looked like forty outstanding ones, and directly contradicted the
 * Escalations panel beside it reporting an empty queue.
 *
 * The hover LABEL had already been fixed for exactly this. The colour had not,
 * which is the giveaway: two places deciding the same thing, one of them
 * updated. `traceColor` is now the only answer, and this pins it down.
 */
import { traceColor, DECISION_COLORS, ESCALATION_OUTCOME_COLORS } from "../src/components/graph/colors";

const results: [string, boolean, string][] = [];
const check = (n: string, ok: boolean, d = "") => {
  results.push([n, ok, d]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${n.padEnd(56)} ${d}`);
};

check(
  "a pending escalation still reads as pending",
  traceColor("escalate", "pending") === DECISION_COLORS.escalate,
  traceColor("escalate", "pending")
);
check(
  "an approved escalation does NOT keep the pending colour",
  traceColor("escalate", "approved") !== DECISION_COLORS.escalate,
  traceColor("escalate", "approved")
);
check(
  "an approved escalation gets the approved colour",
  traceColor("escalate", "approved") === ESCALATION_OUTCOME_COLORS.approved,
  traceColor("escalate", "approved")
);
check(
  "a denied escalation gets the denied colour",
  traceColor("escalate", "denied") === ESCALATION_OUTCOME_COLORS.denied,
  traceColor("escalate", "denied")
);
// That approved and denied actually DIFFER is asserted by the palette-uniqueness
// check at the bottom, which compares widened strings. Writing it inline here
// compares two literal types the compiler already knows can never be equal, and
// TypeScript rejects the comparison rather than the intent.
check(
  "an escalation with no row yet reads as pending",
  traceColor("escalate", undefined) === DECISION_COLORS.escalate,
  traceColor("escalate", undefined)
);
// A status on a non-escalate trace should be ignored rather than repainting it:
// an allowed action is not "approved by a human", and conflating the two would
// erase the distinction the whole panel exists to show.
check(
  "an allow is unaffected by a stray escalation status",
  traceColor("allow", "approved") === DECISION_COLORS.allow,
  traceColor("allow", "approved")
);
check(
  "a block is unaffected by a stray escalation status",
  traceColor("block", "denied") === DECISION_COLORS.block,
  traceColor("block", "denied")
);

// Every colour on the board has to be distinguishable from every other, or the
// fix above buys nothing.
const palette = Object.entries({ ...DECISION_COLORS, ...ESCALATION_OUTCOME_COLORS });
const dupes = palette.filter(([, v], i) => palette.findIndex(([, w]) => w === v) !== i);
check("no two decision states share a colour", dupes.length === 0, dupes.map(([k]) => k).join(", "));

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exitCode = failed === 0 ? 0 : 1;
