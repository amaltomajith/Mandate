import "server-only";
import fs from "node:fs";
import path from "node:path";

export interface RiskReport {
  trainedAt: string;
  dataset: { source: string; totalQualifyingRows: number; totalFraudRows: number; note: string };
  methodology: { trainFraction: number; trainNegativeCap: number; testNegativeCap: number; note: string };
  model: { type: string; features: readonly string[]; epochs: number; positiveClassWeight: number; decisionThreshold: number };
  evaluation: {
    confusionMatrix: { truePositive: number; falsePositive: number; trueNegative: number; falseNegative: number };
    precision: number;
    recall: number;
    f1: number;
    falsePositiveCost: { assumptionInr: number; totalInr: number; note: string };
    fraudAmountCaughtInPaise: number;
    fraudAmountMissedInPaise: number;
    testSetSize: number;
    testSetFraudCount: number;
  };
  featureWeights: { name: string; weight: number }[];
}

/** Reads the report scripts/risk/trainModel.ts writes — a static artifact
 *  from a one-time training run, not regenerated per request. Returns null
 *  if training hasn't been run yet, so the dashboard can show an honest
 *  "not trained yet" state instead of crashing. */
export function loadRiskReport(): RiskReport | null {
  const reportPath = path.resolve(process.cwd(), "src/lib/risk/report.json");
  if (!fs.existsSync(reportPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(reportPath, "utf8"));
  } catch {
    return null;
  }
}
