/**
 * Feature engineering for the fraud-spike detector (Track 02 module) — shared
 * between the training pipeline (scripts/risk/trainModel.ts) and runtime
 * scoring (src/lib/risk/model.ts) so training and inference can never drift
 * apart from computing features differently.
 *
 * Trained and evaluated against PaySim (Kaggle: ealaxi/paysim1) — a
 * synthetic mobile-money dataset with real fraud labels, generated from
 * real transaction log statistics. PaySim's own documentation and every
 * published analysis of it note fraud occurs *only* in TRANSFER and
 * CASH_OUT transactions — training is restricted to those two types
 * accordingly (see trainModel.ts), not a cherry-pick: PAYMENT/CASH_IN/DEBIT
 * literally never carry a fraud label in this dataset.
 */

export const FRAUD_PRONE_TYPES = ["TRANSFER", "CASH_OUT"] as const;
export type FraudProneType = (typeof FRAUD_PRONE_TYPES)[number];

export interface PaysimRow {
  type: string;
  amount: number;
  oldbalanceOrg: number;
  newbalanceOrig: number;
  oldbalanceDest: number;
  newbalanceDest: number;
}

export const FEATURE_NAMES = [
  "logAmount",
  "isTransfer",
  "errorBalanceOrig",
  "errorBalanceDest",
  "origEmptiedOut",
  "destWasZeroBefore",
  "amountToOrigBalanceRatio",
] as const;

/**
 * The two "error balance" features are the strongest known signal in this
 * dataset: a legitimate transfer's origin balance should decrease by
 * exactly `amount` and the destination's should increase by exactly
 * `amount`. A mismatch (money appearing or vanishing across the ledger)
 * is a real, explainable fraud signature — not a black-box feature.
 */
export function extractFeatures(row: PaysimRow): number[] {
  const logAmount = Math.log1p(row.amount);
  const isTransfer = row.type === "TRANSFER" ? 1 : 0;
  const errorBalanceOrig = (row.oldbalanceOrg - row.amount - row.newbalanceOrig) / 1000;
  const errorBalanceDest = (row.oldbalanceDest + row.amount - row.newbalanceDest) / 1000;
  const origEmptiedOut = row.oldbalanceOrg > 0 && row.newbalanceOrig === 0 ? 1 : 0;
  const destWasZeroBefore = row.oldbalanceDest === 0 ? 1 : 0;
  const amountToOrigBalanceRatio = row.oldbalanceOrg > 0 ? Math.min(row.amount / row.oldbalanceOrg, 10) : row.amount > 0 ? 10 : 0;

  return [logAmount, isTransfer, errorBalanceOrig, errorBalanceDest, origEmptiedOut, destWasZeroBefore, amountToOrigBalanceRatio];
}
