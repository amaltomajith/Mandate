/**
 * A from-scratch logistic regression — deliberately not a black box. Every
 * coefficient is inspectable and maps to a named feature (features.ts),
 * which matters for a project whose entire pitch is explainability: the
 * fraud signal should be as auditable as everything else Mandate does.
 * No ML library dependency; this is genuinely simple enough not to need one.
 */

export interface TrainedModel {
  weights: number[];
  bias: number;
  featureMeans: number[];
  featureStds: number[];
  featureNames: readonly string[];
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function standardize(X: number[][]): { normalized: number[][]; means: number[]; stds: number[] } {
  const n = X.length;
  const d = X[0].length;
  const means = new Array(d).fill(0);
  const stds = new Array(d).fill(0);

  for (const row of X) for (let j = 0; j < d; j++) means[j] += row[j];
  for (let j = 0; j < d; j++) means[j] /= n;

  for (const row of X) for (let j = 0; j < d; j++) stds[j] += (row[j] - means[j]) ** 2;
  for (let j = 0; j < d; j++) stds[j] = Math.sqrt(stds[j] / n) || 1;

  const normalized = X.map((row) => row.map((v, j) => (v - means[j]) / stds[j]));
  return { normalized, means, stds };
}

export function applyStandardization(x: number[], means: number[], stds: number[]): number[] {
  return x.map((v, j) => (v - means[j]) / stds[j]);
}

/** Batch gradient descent with L2 regularization and positive-class
 *  weighting (fraud is ~0.1-1% of transactions even after the type filter —
 *  without weighting, "always predict not-fraud" is a 99%+-accurate local
 *  minimum the optimizer happily settles into). */
export function trainLogisticRegression(
  X: number[][],
  y: number[],
  opts: { epochs: number; learningRate: number; l2: number; positiveWeight: number }
): { weights: number[]; bias: number } {
  const n = X.length;
  const d = X[0].length;
  const weights = new Array(d).fill(0);
  let bias = 0;

  for (let epoch = 0; epoch < opts.epochs; epoch++) {
    const gradW = new Array(d).fill(0);
    let gradB = 0;

    for (let i = 0; i < n; i++) {
      const z = dot(weights, X[i]) + bias;
      const pred = sigmoid(z);
      const sampleWeight = y[i] === 1 ? opts.positiveWeight : 1;
      const err = (pred - y[i]) * sampleWeight;
      for (let j = 0; j < d; j++) gradW[j] += err * X[i][j];
      gradB += err;
    }

    for (let j = 0; j < d; j++) {
      weights[j] -= opts.learningRate * (gradW[j] / n + opts.l2 * weights[j]);
    }
    bias -= opts.learningRate * (gradB / n);
  }

  return { weights, bias };
}

export function predictProbability(model: TrainedModel, rawFeatures: number[]): number {
  const x = applyStandardization(rawFeatures, model.featureMeans, model.featureStds);
  return sigmoid(dot(model.weights, x) + model.bias);
}
