import { FEATURE_KEYS } from "../telemetry/features";
import type { Features, Kind } from "../types";

/**
 * The learned half of the behaviour judge: a regularised logistic regression
 * over the entry feature vector, trained on labelled cohort entries. Small on
 * purpose: it trains in milliseconds on a few dozen examples and its weights
 * can be read to see what it has learned.
 */
export interface BehaviorModel {
  version: 1;
  trainedAt: number;
  keys: string[];
  /** Per-feature mean, also used to fill in missing values. */
  mean: number[];
  std: number[];
  weights: number[];
  bias: number;
  examples: { human: number; agent: number };
  /** Leave-one-out accuracy on the training set. */
  looAccuracy: number | null;
}

export interface LabelledFeatures {
  features: Features;
  label: Kind;
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

function fit(rows: (number | null)[][], labels: number[], l2: number, epochs: number) {
  const d = rows[0].length;
  const mean = new Array<number>(d).fill(0);
  const std = new Array<number>(d).fill(1);
  for (let j = 0; j < d; j++) {
    const col = rows.map((r) => r[j]).filter((x): x is number => x !== null);
    if (col.length === 0) continue;
    mean[j] = col.reduce((a, b) => a + b, 0) / col.length;
    const variance = col.reduce((a, b) => a + (b - mean[j]) ** 2, 0) / col.length;
    std[j] = Math.sqrt(variance) || 1;
  }
  const x = rows.map((r) => r.map((val, j) => (val === null ? 0 : (val - mean[j]) / std[j])));

  // Weight classes so a lopsided training set doesn't just learn the majority.
  const pos = labels.filter((y) => y === 1).length;
  const neg = labels.length - pos;
  const wPos = labels.length / (2 * Math.max(1, pos));
  const wNeg = labels.length / (2 * Math.max(1, neg));

  const weights = new Array<number>(d).fill(0);
  let bias = 0;
  const lr = 0.1;
  for (let e = 0; e < epochs; e++) {
    const grad = new Array<number>(d).fill(0);
    let gradB = 0;
    for (let i = 0; i < x.length; i++) {
      let z = bias;
      for (let j = 0; j < d; j++) z += weights[j] * x[i][j];
      const err = (sigmoid(z) - labels[i]) * (labels[i] === 1 ? wPos : wNeg);
      for (let j = 0; j < d; j++) grad[j] += err * x[i][j];
      gradB += err;
    }
    for (let j = 0; j < d; j++) weights[j] -= lr * (grad[j] / x.length + l2 * weights[j]);
    bias -= lr * (gradB / x.length);
  }
  return { mean, std, weights, bias };
}

const toRow = (f: Features, keys: readonly string[]) => keys.map((k) => f[k] ?? null);

function probability(m: Pick<BehaviorModel, "keys" | "mean" | "std" | "weights" | "bias">, f: Features): number {
  let z = m.bias;
  m.keys.forEach((k, j) => {
    const val = f[k];
    if (val === null || val === undefined) return;
    z += m.weights[j] * ((val - m.mean[j]) / m.std[j]);
  });
  return sigmoid(z);
}

export const MIN_EXAMPLES_PER_CLASS = 5;

export function trainModel(data: LabelledFeatures[], opts: { l2?: number; epochs?: number } = {}): BehaviorModel {
  const human = data.filter((d) => d.label === "human").length;
  const agent = data.length - human;
  if (human < MIN_EXAMPLES_PER_CLASS || agent < MIN_EXAMPLES_PER_CLASS) {
    throw new Error(
      `Need at least ${MIN_EXAMPLES_PER_CLASS} labelled humans and ${MIN_EXAMPLES_PER_CLASS} labelled agents to train; have ${human} and ${agent}.`,
    );
  }
  const l2 = opts.l2 ?? 0.05;
  const epochs = opts.epochs ?? 600;
  const keys = [...FEATURE_KEYS];
  const rows = data.map((d) => toRow(d.features, keys));
  const labels = data.map((d) => (d.label === "human" ? 1 : 0));

  // Leave-one-out: an honest accuracy estimate when examples are scarce.
  let looAccuracy: number | null = null;
  if (data.length <= 400) {
    let correct = 0;
    for (let i = 0; i < data.length; i++) {
      const params = fit(
        rows.filter((_, k) => k !== i),
        labels.filter((_, k) => k !== i),
        l2,
        Math.min(epochs, 200),
      );
      if (probability({ keys, ...params }, data[i].features) >= 0.5 === (labels[i] === 1)) correct++;
    }
    looAccuracy = correct / data.length;
  }

  return {
    version: 1,
    trainedAt: Date.now(),
    keys,
    ...fit(rows, labels, l2, epochs),
    examples: { human, agent },
    looAccuracy,
  };
}

/** P(human) for an entry, 0..1. */
export function predictHuman(model: BehaviorModel, features: Features): number {
  return probability(model, features);
}

/** The features pulling hardest in each direction, for inspection. */
export function topWeights(model: BehaviorModel, n = 8): { key: string; weight: number }[] {
  return model.keys
    .map((key, j) => ({ key, weight: Number(model.weights[j].toFixed(3)) }))
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
    .slice(0, n);
}
