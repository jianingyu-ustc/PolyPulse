import { existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { lookupCategoryFeeParams, inferCategorySlug, calculateFeePct } from "./pulse-strategy.js";

const DYNAMIC_FEE_TIMEOUT_MS = 5000;

const dynamicFeeCache = new Map();

export function feeDetailsToFeeParams(fd) {
  if (!fd) {
    return { feeRate: 0, exponent: 0 };
  }
  return {
    feeRate: typeof fd.r === "number" ? fd.r : 0,
    exponent: typeof fd.e === "number" ? fd.e : 0
  };
}

export function verifyFeeEstimate({ staticFeeParams, dynamicFeeParams, entryPrice, threshold = 0 }) {
  const staticFeePct = calculateFeePct(entryPrice, staticFeeParams);
  const dynamicFeePct = calculateFeePct(entryPrice, dynamicFeeParams);
  const deviation = Math.abs(staticFeePct - dynamicFeePct);
  return {
    staticFeePct,
    dynamicFeePct,
    deviation,
    mismatch: deviation > threshold
  };
}

export function clearDynamicFeeCache() {
  dynamicFeeCache.clear();
}

export class DynamicFeeService {
  constructor(config) {
    this.polymarketHost = (config.polymarketHost || "https://clob.polymarket.com").replace(/\/+$/, "");
    this.enabled = config.dynamicFee?.enabled !== false;
    this.ttlMs = Math.max(0, Number(config.dynamicFee?.ttlMs ?? 3600000));
    this.verifyEnabled = config.dynamicFee?.verifyEnabled !== false;
    this.verifyThreshold = Math.max(0, Number(config.dynamicFee?.verifyThreshold ?? 0));
    this.artifactDir = config.artifactDir || "runtime-artifacts";
  }

  async fetchDynamicFeeParams(conditionId) {
    if (!this.enabled || !conditionId) {
      return null;
    }
    const now = Date.now();
    const cached = dynamicFeeCache.get(conditionId);
    if (cached && (now - cached.fetchedAt) < this.ttlMs) {
      return cached.params;
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DYNAMIC_FEE_TIMEOUT_MS);
      try {
        const url = `${this.polymarketHost}/markets/${encodeURIComponent(conditionId)}`;
        const response = await globalThis.fetch(url, {
          signal: controller.signal,
          headers: { "user-agent": "PolyPulse/0.1 dynamic-fee" }
        });
        if (!response.ok) {
          return null;
        }
        const data = await response.json();
        const params = feeDetailsToFeeParams(data?.fd);
        dynamicFeeCache.set(conditionId, { params, fetchedAt: now });
        return params;
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      return null;
    }
  }

  async fetchFeeRateBps(tokenId) {
    if (!tokenId) {
      return null;
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DYNAMIC_FEE_TIMEOUT_MS);
      try {
        const url = `${this.polymarketHost}/fee-rate?token_id=${encodeURIComponent(tokenId)}`;
        const response = await globalThis.fetch(url, {
          signal: controller.signal,
          headers: { "user-agent": "PolyPulse/0.1 fee-verify" }
        });
        if (!response.ok) {
          return null;
        }
        const data = await response.json();
        const baseFee = Number(data?.base_fee ?? data?.fee_rate ?? data?.feeRate);
        return Number.isFinite(baseFee) ? baseFee : null;
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      return null;
    }
  }

  async verifyAndLog({ tokenId, conditionId, marketSlug, categorySlug, market }) {
    if (!this.verifyEnabled) {
      return null;
    }
    const dynamicParams = await this.fetchDynamicFeeParams(conditionId);
    if (!dynamicParams) {
      return null;
    }
    const staticParams = lookupCategoryFeeParams(
      categorySlug ?? inferCategorySlug(market),
      {
        negRisk: Boolean(market?.negRisk),
        feesEnabled: market?.feesEnabled,
        feeSchedule: market?.feeSchedule
      }
    );
    const estimatedHasFee = staticParams.feeRate > 0;
    const actualHasFee = dynamicParams.feeRate > 0;
    const mismatch = estimatedHasFee !== actualHasFee
      || Math.abs(staticParams.feeRate - dynamicParams.feeRate) > this.verifyThreshold
      || staticParams.exponent !== dynamicParams.exponent;

    const discrepancy = {
      tokenId: tokenId ?? null,
      conditionId: conditionId ?? null,
      marketSlug: marketSlug ?? null,
      categorySlug: categorySlug ?? inferCategorySlug(market) ?? null,
      estimatedFeeRate: staticParams.feeRate,
      estimatedExponent: staticParams.exponent,
      actualFeeRate: dynamicParams.feeRate,
      actualExponent: dynamicParams.exponent,
      mismatch,
      timestamp: new Date().toISOString()
    };

    if (mismatch) {
      await this.logDiscrepancy(discrepancy);
    }
    return discrepancy;
  }

  async logDiscrepancy(discrepancy) {
    try {
      const dir = this.artifactDir;
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }
      const logPath = path.join(dir, "fee-discrepancies.jsonl");
      await appendFile(logPath, JSON.stringify(discrepancy) + "\n");
    } catch {
      // logging failure must not block execution
    }
  }
}
