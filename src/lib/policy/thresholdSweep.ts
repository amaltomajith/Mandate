import { evaluatePolicy } from "./engine";
import type { PolicyRule } from "./types";

/**
 * What a different step-up threshold would have done to real traffic.
 *
 * This is the merchant's revenue/friction dial. A low threshold is safe and
 * expensive: more actions stop for a human, so more money waits on someone
 * being available. A high one clears more automatically and asks a human about
 * less. Neither is right in the abstract — it depends on how much of *this
 * merchant's* actual traffic sits in the gap, which is the one thing a generic
 * recommendation can't know and a replay can.
 *
 * Deliberately a replay, not a model. Every number below is "here is what the
 * engine would have decided about actions that genuinely happened", produced
 * by running the same pure `evaluatePolicy` the live path uses. There is no
 * projection, no assumed approval rate, and no claim about revenue that has
 * not already occurred.
 *
 * The honest limit, stated because the UI must not overclaim: this replays the
 * step-up rule *alone*. An action refused by a cap or a category ban would
 * still be refused at any threshold, so it is excluded from the sample rather
 * than counted as "would clear" — otherwise raising the threshold would appear
 * to unlock money that a different rule was always going to stop.
 */

export interface ThresholdOutcome {
  /** Threshold in paise. */
  threshold: number;
  /** Actions that would stop for a human at this threshold. */
  escalatedCount: number;
  /** Their total value — money waiting on a person. */
  escalatedValue: number;
  /** Actions that would clear with no human involved. */
  clearedCount: number;
  /** Their total value. */
  clearedValue: number;
}

export interface ReplayAction {
  amount: number;
  currency: string;
  category?: string;
  actionType: string;
  agentId: string;
}

/** One threshold, replayed over the sample. Uses the real evaluator rather
 *  than an inline `amount >= threshold` comparison, so this can never drift
 *  from what the engine would actually decide. */
export function outcomeAt(threshold: number, currency: string, sample: ReplayAction[]): ThresholdOutcome {
  const candidate: PolicyRule = {
    id: "threshold-candidate",
    type: "step_up",
    name: "Candidate step-up",
    params: { threshold_amount: threshold, currency },
  };

  const outcome: ThresholdOutcome = {
    threshold,
    escalatedCount: 0,
    escalatedValue: 0,
    clearedCount: 0,
    clearedValue: 0,
  };

  for (const action of sample) {
    if (action.currency !== currency) continue;
    const match = evaluatePolicy(action, [candidate], { velocityCounts: {}, dailyAmountSoFar: {} });
    if (match?.decision === "escalate") {
      outcome.escalatedCount += 1;
      outcome.escalatedValue += action.amount;
    } else {
      outcome.clearedCount += 1;
      outcome.clearedValue += action.amount;
    }
  }

  return outcome;
}

/** Evenly spaced candidate thresholds across a sensible range, always
 *  including the one currently in force so the comparison has a fixed point. */
export function sweepThresholds(
  current: number,
  currency: string,
  sample: ReplayAction[],
  steps: number[]
): { current: ThresholdOutcome; options: ThresholdOutcome[] } {
  const unique = Array.from(new Set([current, ...steps])).sort((a, b) => a - b);
  return {
    current: outcomeAt(current, currency, sample),
    options: unique.map((t) => outcomeAt(t, currency, sample)),
  };
}
