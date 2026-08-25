import "server-only";
import fs from "node:fs";
import path from "node:path";
import { FEATURE_NAMES } from "./features";
import { predictProbability, type TrainedModel } from "./logisticRegression";

/**
 * An illustrative, amount-only risk score for a *live* Mandate transaction —
 * folded into simulate_action/enforce_action's MCP response as an extra
 * field, never a decision input. Read this whole comment before trusting the
 * number it returns; it's real math, but on very little real information.
 *
 * The trained model (scripts/risk/trainModel.ts) needs 7 features, 6 of
 * which are PaySim-specific account-balance deltas that a Razorpay Order
 * simply doesn't have. Feeding it literal zeros for those would be
 * dishonest — zero happens to BE the "no discrepancy" value for two of
 * them, which is also the strongest "not fraud" signal in the training
 * data, so every live transaction would score artificially low no matter
 * what.
 *
 * Instead, every unavailable feature is imputed at its TRAINING-SET MEAN.
 * After the model's own standardization step ((x - mean) / std), a
 * mean-imputed feature becomes exactly 0 in standardized space — which
 * contributes NOTHING to the score in either direction. That's a real,
 * standard statistical technique (mean imputation), not a workaround: the
 * model is honestly saying "no information" for those features instead of
 * quietly asserting "definitely not fraud."
 *
 * Net effect: only the amount actually moves this number. The 83.6%/45.4%
 * precision/recall reported in the Risk tab does NOT apply here — that
 * number describes the model with all 7 real features present. This
 * function's actual accuracy on live Mandate traffic has never been
 * measured (there's no ground truth for it), and every caller must present
 * it as illustrative, not validated.
 */

let cachedModel: TrainedModel | null | undefined;

function loadModel(): TrainedModel | null {
  if (cachedModel !== undefined) return cachedModel;
  const modelPath = path.resolve(process.cwd(), "src/lib/risk/model.json");
  if (!fs.existsSync(modelPath)) {
    cachedModel = null;
    return null;
  }
  try {
    cachedModel = JSON.parse(fs.readFileSync(modelPath, "utf8"));
  } catch {
    cachedModel = null;
  }
  return cachedModel ?? null;
}

export interface LiveRiskScore {
  score: number;
  basis: "amount-only";
  caveat: string;
}

const CAVEAT =
  "Illustrative only — based on a model trained on external Kaggle data (PaySim), most of whose inputs aren't available for this transaction. Reduces to an amount-based signal; its accuracy on live Mandate traffic has never been measured. Never used by the policy engine.";

/** `amountPaise` is the only real input; everything else the model needs is
 *  mean-imputed (see module doc). Returns null if training hasn't been run
 *  (no model.json) or scoring fails for any reason — never throws, since a
 *  scoring problem must never interrupt the real decision it's attached to. */
export function scoreLiveTransaction(amountPaise: number): LiveRiskScore | null {
  try {
    const model = loadModel();
    if (!model) return null;

    const logAmountIndex = FEATURE_NAMES.indexOf("logAmount");
    const rawFeatures = model.featureMeans.slice();
    rawFeatures[logAmountIndex] = Math.log1p(amountPaise / 100);

    const score = predictProbability(model, rawFeatures);
    return { score, basis: "amount-only", caveat: CAVEAT };
  } catch (err) {
    console.error("[scoreLiveTransaction] scoring failed, treating as unavailable:", err);
    return null;
  }
}
