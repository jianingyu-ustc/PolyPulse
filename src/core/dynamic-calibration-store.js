/**
 * DynamicCalibrationStore
 *
 * Aligns with Predict-Raven's dynamic probability calibration:
 * Stores historical prediction outcomes and computes dynamic calibration
 * curves based on Brier score feedback, enabling probability adjustments
 * that improve over time based on actual market settlements.
 *
 * Key properties:
 * - Records each prediction outcome: raw probability, settled outcome (0/1), metadata
 * - Computes Brier score per bucket (by probability range, category, confidence, etc.)
 * - Generates calibration curves: maps raw probability → calibrated probability
 * - Supports multiple calibration dimensions: category, confidence, researchability, etc.
 * - Persistent storage in state directory (JSON file)
 * - Graceful degradation: when insufficient data, falls back to static calibration
 *
 * The calibration curve is computed using isotonic regression approximation:
 * predictions are bucketed by raw probability, and each bucket's calibrated
 * value is the empirical frequency of positive outcomes in that bucket.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_BUCKETS = 10;
const MIN_SAMPLES_PER_BUCKET = 5;

function bucketIndex(probability, numBuckets = DEFAULT_BUCKETS) {
  return Math.min(numBuckets - 1, Math.max(0, Math.floor(probability * numBuckets)));
}

function computeBrierScore(predictions) {
  if (predictions.length === 0) return null;
  const sum = predictions.reduce((acc, p) => {
    const error = (p.rawProbability - p.outcome) ** 2;
    return acc + error;
  }, 0);
  return Number((sum / predictions.length).toFixed(6));
}

function buildCalibrationCurve(predictions, numBuckets = DEFAULT_BUCKETS) {
  const buckets = Array.from({ length: numBuckets }, () => ({ sum: 0, count: 0 }));
  for (const pred of predictions) {
    const idx = bucketIndex(pred.rawProbability, numBuckets);
    buckets[idx].sum += pred.outcome;
    buckets[idx].count += 1;
  }
  return buckets.map((bucket, idx) => {
    const midpoint = (idx + 0.5) / numBuckets;
    if (bucket.count < MIN_SAMPLES_PER_BUCKET) {
      return { midpoint, calibrated: midpoint, count: bucket.count, reliable: false };
    }
    return {
      midpoint,
      calibrated: Number((bucket.sum / bucket.count).toFixed(6)),
      count: bucket.count,
      reliable: true
    };
  });
}

function interpolateCalibration(rawProbability, curve) {
  const numBuckets = curve.length;
  const idx = bucketIndex(rawProbability, numBuckets);
  const bucket = curve[idx];
  if (!bucket.reliable) {
    return { calibrated: rawProbability, interpolated: false, reason: "insufficient_data" };
  }
  return { calibrated: bucket.calibrated, interpolated: true, reason: "empirical" };
}

function dimensionKey(prediction, dimension) {
  switch (dimension) {
    case "category":
      return prediction.category ?? "unknown";
    case "confidence":
      return prediction.confidence ?? "medium";
    case "researchability":
      return prediction.researchability ?? "medium";
    case "informationAdvantage":
      return prediction.informationAdvantage ?? "medium";
    default:
      return "all";
  }
}

export class DynamicCalibrationStore {
  constructor(config = {}) {
    this.config = config;
    this.enabled = config.calibration?.dynamicEnabled !== false;
    this.storePath = config.stateDir
      ? path.join(config.stateDir, "calibration-history.json")
      : null;
    this.predictions = [];
    this.loaded = false;
  }

  async load() {
    if (!this.storePath || !existsSync(this.storePath)) {
      this.predictions = [];
      this.loaded = true;
      return;
    }
    try {
      const content = await readFile(this.storePath, "utf8");
      const data = JSON.parse(content);
      this.predictions = Array.isArray(data?.predictions) ? data.predictions : [];
    } catch {
      this.predictions = [];
    }
    this.loaded = true;
  }

  async save() {
    if (!this.storePath) return;
    await mkdir(path.dirname(this.storePath), { recursive: true });
    const data = {
      version: 1,
      updatedAt: new Date().toISOString(),
      totalPredictions: this.predictions.length,
      predictions: this.predictions.slice(-1000)
    };
    await writeFile(this.storePath, JSON.stringify(data, null, 2), "utf8");
  }

  async recordOutcome({
    marketId,
    rawProbability,
    outcome,
    category = null,
    confidence = null,
    researchability = null,
    informationAdvantage = null,
    settledAt = null
  }) {
    if (!this.loaded) await this.load();
    this.predictions.push({
      marketId,
      rawProbability: Number(rawProbability),
      outcome: outcome ? 1 : 0,
      category,
      confidence,
      researchability,
      informationAdvantage,
      recordedAt: new Date().toISOString(),
      settledAt: settledAt ?? new Date().toISOString()
    });
    await this.save();
  }

  async getCalibration({ rawProbability, category = null, confidence = null, researchability = null }) {
    if (!this.loaded) await this.load();
    if (!this.enabled || this.predictions.length < MIN_SAMPLES_PER_BUCKET * 3) {
      return {
        calibratedProbability: rawProbability,
        dynamic: false,
        reason: "insufficient_history",
        totalSamples: this.predictions.length,
        brierScore: null
      };
    }

    // Try dimension-specific calibration first
    const dimensions = [
      { name: "category", value: category },
      { name: "confidence", value: confidence }
    ].filter((d) => d.value != null);

    for (const dim of dimensions) {
      const filtered = this.predictions.filter(
        (p) => dimensionKey(p, dim.name) === dim.value
      );
      if (filtered.length >= MIN_SAMPLES_PER_BUCKET * 3) {
        const curve = buildCalibrationCurve(filtered);
        const result = interpolateCalibration(rawProbability, curve);
        if (result.interpolated) {
          return {
            calibratedProbability: result.calibrated,
            dynamic: true,
            reason: `${dim.name}=${dim.value}`,
            totalSamples: filtered.length,
            brierScore: computeBrierScore(filtered),
            dimension: dim.name
          };
        }
      }
    }

    // Fall back to global calibration
    const curve = buildCalibrationCurve(this.predictions);
    const result = interpolateCalibration(rawProbability, curve);
    return {
      calibratedProbability: result.interpolated ? result.calibrated : rawProbability,
      dynamic: result.interpolated,
      reason: result.reason,
      totalSamples: this.predictions.length,
      brierScore: computeBrierScore(this.predictions),
      dimension: "global"
    };
  }

  getStatistics() {
    if (this.predictions.length === 0) {
      return { totalPredictions: 0, brierScore: null, byCategory: {}, byConfidence: {} };
    }
    const brierScore = computeBrierScore(this.predictions);
    const byCategory = {};
    const byConfidence = {};

    for (const pred of this.predictions) {
      const cat = pred.category ?? "unknown";
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(pred);

      const conf = pred.confidence ?? "medium";
      if (!byConfidence[conf]) byConfidence[conf] = [];
      byConfidence[conf].push(pred);
    }

    return {
      totalPredictions: this.predictions.length,
      brierScore,
      byCategory: Object.fromEntries(
        Object.entries(byCategory).map(([k, v]) => [k, { count: v.length, brierScore: computeBrierScore(v) }])
      ),
      byConfidence: Object.fromEntries(
        Object.entries(byConfidence).map(([k, v]) => [k, { count: v.length, brierScore: computeBrierScore(v) }])
      )
    };
  }
}

export const dynamicCalibrationInternals = {
  bucketIndex,
  computeBrierScore,
  buildCalibrationCurve,
  interpolateCalibration,
  MIN_SAMPLES_PER_BUCKET
};
