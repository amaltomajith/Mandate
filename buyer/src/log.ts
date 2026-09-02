/**
 * Terminal output, written to be read from across a room.
 *
 * This runs beside the dashboard on a projector, so the constraint is not
 * information density but legibility at a glance: one thought per line, the
 * agent's own voice for decisions, indented detail for the evidence behind
 * them. Deliberately unhurried — a wall of text scrolling past proves nothing
 * to anyone watching.
 */

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

export function say(line: string): void {
  console.log(`\n${BOLD}▸${RESET} ${line}`);
}

export function indent(line: string): void {
  console.log(`  ${DIM}${line}${RESET}`);
}

export function rule(): void {
  console.log(`${DIM}${"─".repeat(64)}${RESET}`);
}

export function money(paise: number): string {
  return `₹${(paise / 100).toLocaleString("en-IN")}`;
}

/** Slow enough to follow. The agent is not in a hurry and neither is anyone
 *  watching it. */
export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
