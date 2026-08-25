/**
 * Trains and evaluates the fraud-spike detector against PaySim (Kaggle:
 * ealaxi/paysim1) — a real, publicly available, labeled synthetic
 * mobile-money dataset. This is the Track 02 module's actual evidence:
 * everything reported by this script is measured, not asserted.
 *
 * Methodology (stated here so the report is self-explaining, not just a
 * number):
 *   1. Stream the CSV (it's ~470MB / 6.3M rows — never held fully in
 *      memory). Filter to TRANSFER/CASH_OUT rows only — PaySim's fraud
 *      label never appears on the other three transaction types, so
 *      including them would just dilute the problem with rows that are
 *      definitionally never fraud.
 *   2. Split into train/test (80/20) BEFORE any sampling, by a random draw
 *      per row — so no row can leak between the two.
 *   3. Fraud (~0.1-1% of qualifying rows) is rare enough to keep in full on
 *      both sides. Non-fraud is reservoir-sampled to a fixed cap per split
 *      (memory-safe regardless of file size, and a uniform random sample
 *      of everything seen — see reservoirAdd below), NOT truncated to
 *      "however many rows fit," which would bias toward whatever's early
 *      in the file.
 *   4. Train on the (capped, still heavily imbalanced) train split with
 *      positive-class weighting in the loss. Evaluate ONLY on the held-out
 *      test split, which the model never saw during training.
 *   5. Report precision, recall, F1, the confusion matrix, and an explicit
 *      false-positive cost estimate under a stated assumption — see
 *      REVIEW_COST_PER_FALSE_POSITIVE below.
 *
 * Usage: npx tsx scripts/risk/trainModel.ts [path-to-csv]
 * Writes src/lib/risk/model.json (weights) and src/lib/risk/report.json
 * (the evaluation report the dashboard's Risk tab reads).
 */
import * as fs from "node:fs";
import * as readline from "node:readline";
import * as path from "node:path";
import { extractFeatures, FEATURE_NAMES, FRAUD_PRONE_TYPES, type PaysimRow } from "../../src/lib/risk/features";
import { standardize, trainLogisticRegression, predictProbability, type TrainedModel } from "../../src/lib/risk/logisticRegression";

const CSV_PATH = process.argv[2] ?? path.resolve(process.cwd(), "data/paysim.csv");
const TRAIN_FRACTION = 0.8;
const TRAIN_NEGATIVE_CAP = 100_000;
const TEST_NEGATIVE_CAP = 300_000;
const EPOCHS = 400;
const LEARNING_RATE = 0.3;
const L2 = 0.001;
const POSITIVE_WEIGHT = 25;
const DECISION_THRESHOLD = 0.5;

// Purely illustrative, stated explicitly rather than hidden — the review
// cost of one false positive (a human checking a transaction that turns out
// to be legitimate). Track 02's bar asks for false-positive cost to be
// reported; there's no real operating cost data available to this project,
// so this is a labeled assumption, not a claimed fact.
const REVIEW_COST_PER_FALSE_POSITIVE_INR = 50;

interface LabeledExample {
  features: number[];
  label: number;
  amount: number;
}

/** Reservoir sampling (Algorithm R): a uniform random sample of size `cap`
 *  from a stream of unknown total length, using O(cap) memory. */
function reservoirAdd<T>(reservoir: T[], item: T, seenCount: number, cap: number) {
  if (reservoir.length < cap) {
    reservoir.push(item);
    return;
  }
  const r = Math.floor(Math.random() * seenCount);
  if (r < cap) reservoir[r] = item;
}

async function loadAndSplit(): Promise<{ train: LabeledExample[]; test: LabeledExample[]; totalQualifyingRows: number; totalFraudRows: number }> {
  if (!fs.existsSync(CSV_PATH)) {
    throw new Error(`PaySim CSV not found at ${CSV_PATH}. Download it first (see scripts/risk/downloadPaysim.ts).`);
  }

  const trainFraud: LabeledExample[] = [];
  const testFraud: LabeledExample[] = [];
  const trainNonFraud: LabeledExample[] = [];
  const testNonFraud: LabeledExample[] = [];
  let trainNonFraudSeen = 0;
  let testNonFraudSeen = 0;
  let totalQualifyingRows = 0;
  let totalFraudRows = 0;

  const rl = readline.createInterface({ input: fs.createReadStream(CSV_PATH), crlfDelay: Infinity });
  let colIndex: Record<string, number> | null = null;
  let lineNo = 0;

  for await (const line of rl) {
    lineNo++;
    if (lineNo === 1) {
      const headers = line.split(",").map((h) => h.trim());
      colIndex = Object.fromEntries(headers.map((h, i) => [h, i]));
      for (const required of ["type", "amount", "oldbalanceOrg", "newbalanceOrig", "oldbalanceDest", "newbalanceDest", "isFraud"]) {
        if (!(required in colIndex)) throw new Error(`PaySim CSV missing expected column "${required}". Found: ${headers.join(", ")}`);
      }
      continue;
    }
    if (!colIndex) continue;

    const cols = line.split(",");
    const type = cols[colIndex.type];
    if (!FRAUD_PRONE_TYPES.includes(type as never)) continue;

    const row: PaysimRow = {
      type,
      amount: Number(cols[colIndex.amount]),
      oldbalanceOrg: Number(cols[colIndex.oldbalanceOrg]),
      newbalanceOrig: Number(cols[colIndex.newbalanceOrig]),
      oldbalanceDest: Number(cols[colIndex.oldbalanceDest]),
      newbalanceDest: Number(cols[colIndex.newbalanceDest]),
    };
    const label = Number(cols[colIndex.isFraud]) === 1 ? 1 : 0;

    totalQualifyingRows++;
    if (label === 1) totalFraudRows++;

    const example: LabeledExample = { features: extractFeatures(row), label, amount: row.amount };
    const isTrain = Math.random() < TRAIN_FRACTION;

    if (label === 1) {
      (isTrain ? trainFraud : testFraud).push(example);
    } else if (isTrain) {
      trainNonFraudSeen++;
      reservoirAdd(trainNonFraud, example, trainNonFraudSeen, TRAIN_NEGATIVE_CAP);
    } else {
      testNonFraudSeen++;
      reservoirAdd(testNonFraud, example, testNonFraudSeen, TEST_NEGATIVE_CAP);
    }

    if (lineNo % 1_000_000 === 0) console.log(`  ...${lineNo.toLocaleString()} lines read`);
  }

  return {
    train: [...trainFraud, ...trainNonFraud],
    test: [...testFraud, ...testNonFraud],
    totalQualifyingRows,
    totalFraudRows,
  };
}

function evaluate(model: TrainedModel, test: LabeledExample[], threshold: number) {
  let tp = 0,
    fp = 0,
    tn = 0,
    fn = 0;
  let falsePositiveReviewCost = 0;
  let fraudAmountCaught = 0;
  let fraudAmountMissed = 0;

  for (const ex of test) {
    const prob = predictProbability(model, ex.features);
    const predicted = prob >= threshold ? 1 : 0;

    if (predicted === 1 && ex.label === 1) {
      tp++;
      fraudAmountCaught += ex.amount;
    } else if (predicted === 1 && ex.label === 0) {
      fp++;
      falsePositiveReviewCost += REVIEW_COST_PER_FALSE_POSITIVE_INR;
    } else if (predicted === 0 && ex.label === 0) {
      tn++;
    } else {
      fn++;
      fraudAmountMissed += ex.amount;
    }
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return {
    confusionMatrix: { truePositive: tp, falsePositive: fp, trueNegative: tn, falseNegative: fn },
    precision,
    recall,
    f1,
    falsePositiveCost: {
      assumptionInr: REVIEW_COST_PER_FALSE_POSITIVE_INR,
      totalInr: falsePositiveReviewCost,
      note: "Illustrative assumption (₹50/manual review) — no real operating cost data available to this project. Stated explicitly, not presented as measured.",
    },
    fraudAmountCaughtInPaise: Math.round(fraudAmountCaught * 100),
    fraudAmountMissedInPaise: Math.round(fraudAmountMissed * 100),
    testSetSize: test.length,
    testSetFraudCount: test.filter((e) => e.label === 1).length,
  };
}

async function main() {
  console.log(`Reading ${CSV_PATH} (streaming — memory-safe regardless of file size)...`);
  const { train, test, totalQualifyingRows, totalFraudRows } = await loadAndSplit();
  console.log(`Qualifying rows (TRANSFER/CASH_OUT only): ${totalQualifyingRows.toLocaleString()}, of which fraud: ${totalFraudRows.toLocaleString()}`);
  console.log(`Train set: ${train.length.toLocaleString()} (${train.filter((e) => e.label === 1).length} fraud). Test set: ${test.length.toLocaleString()} (${test.filter((e) => e.label === 1).length} fraud).`);

  const { normalized, means, stds } = standardize(train.map((e) => e.features));
  console.log(`Training logistic regression (${EPOCHS} epochs)...`);
  const { weights, bias } = trainLogisticRegression(
    normalized,
    train.map((e) => e.label),
    { epochs: EPOCHS, learningRate: LEARNING_RATE, l2: L2, positiveWeight: POSITIVE_WEIGHT }
  );

  const model: TrainedModel = { weights, bias, featureMeans: means, featureStds: stds, featureNames: FEATURE_NAMES };

  console.log("Evaluating on the held-out test set (never seen during training)...");
  const evaluation = evaluate(model, test, DECISION_THRESHOLD);

  const report = {
    trainedAt: new Date().toISOString(),
    dataset: {
      source: "PaySim (Kaggle: ealaxi/paysim1)",
      totalQualifyingRows,
      totalFraudRows,
      note: "Filtered to TRANSFER/CASH_OUT transactions — the only two types PaySim ever labels as fraud.",
    },
    methodology: {
      trainFraction: TRAIN_FRACTION,
      trainNegativeCap: TRAIN_NEGATIVE_CAP,
      testNegativeCap: TEST_NEGATIVE_CAP,
      note: "Fraud rows kept in full on both sides (rare enough to be memory-safe); non-fraud reservoir-sampled to the caps above — a uniform random sample, not a truncation. Test set never used in training.",
    },
    model: { type: "logistic regression, trained from scratch (src/lib/risk/logisticRegression.ts)", features: FEATURE_NAMES, epochs: EPOCHS, positiveClassWeight: POSITIVE_WEIGHT, decisionThreshold: DECISION_THRESHOLD },
    evaluation,
    featureWeights: FEATURE_NAMES.map((name, i) => ({ name, weight: weights[i] })),
  };

  const modelPath = path.resolve(process.cwd(), "src/lib/risk/model.json");
  const reportPath = path.resolve(process.cwd(), "src/lib/risk/report.json");
  fs.writeFileSync(modelPath, JSON.stringify(model, null, 2));
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log("\n=== Held-out test set results ===");
  console.log(`Precision: ${(evaluation.precision * 100).toFixed(1)}%`);
  console.log(`Recall:    ${(evaluation.recall * 100).toFixed(1)}%`);
  console.log(`F1:        ${(evaluation.f1 * 100).toFixed(1)}%`);
  console.log(`Confusion matrix:`, evaluation.confusionMatrix);
  console.log(`\nWrote ${modelPath}`);
  console.log(`Wrote ${reportPath}`);
}

main().catch((err) => {
  console.error("Training failed:", err);
  process.exit(1);
});
