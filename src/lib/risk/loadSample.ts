import "server-only";
import fs from "node:fs";
import path from "node:path";

export type RiskOutcome = "truePositive" | "falsePositive" | "falseNegative" | "trueNegative";

export interface RiskSamplePoint {
  prob: number;
  amount: number;
  outcome: RiskOutcome;
}

export interface RiskSample {
  threshold: number;
  points: RiskSamplePoint[];
}

/** A small, honest sample of the actual held-out test set (real scores, real
 *  outcomes) written by scripts/risk/trainModel.ts — used only for the Risk
 *  tab's 3D visualization. Returns null if training hasn't been run yet. */
export function loadRiskSample(): RiskSample | null {
  const samplePath = path.resolve(process.cwd(), "src/lib/risk/sample.json");
  if (!fs.existsSync(samplePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(samplePath, "utf8"));
  } catch {
    return null;
  }
}
