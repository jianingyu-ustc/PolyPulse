import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { assertSchema } from "../domain/schemas.js";
import { PolymarketPageEvidenceAdapter } from "./polymarket-page-evidence-adapter.js";
import { OrderBookEvidenceAdapter } from "./orderbook-evidence-adapter.js";
import { ResolutionSourceLiveAdapter } from "./resolution-source-evidence-adapter.js";
import {
  SportsScheduleAdapter,
  MacroCalendarAdapter,
  WeatherDataAdapter,
  OnChainDataAdapter,
  FinancialDataAdapter
} from "./domain-research-adapters.js";

function nowIso() {
  return new Date().toISOString();
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

function clampScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return Math.max(0, Math.min(1, Number(number.toFixed(4))));
}

function asUrl(value, fallback) {
  const raw = String(value ?? "").trim();
  return raw || fallback;
}

function normalizeEvidence(input, { market, adapterId, statusOverride = null } = {}) {
  const timestamp = input.timestamp ?? input.retrievedAt ?? nowIso();
  const sourceUrl = asUrl(input.sourceUrl ?? input.url, `polypulse://${adapterId}/${market.marketId}`);
  return assertSchema("Evidence", {
    evidenceId: input.evidenceId ?? randomUUID(),
    marketId: input.marketId ?? market.marketId,
    source: input.source ?? adapterId,
    sourceUrl,
    url: input.url ?? sourceUrl,
    title: String(input.title ?? "Untitled evidence"),
    summary: String(input.summary ?? ""),
    status: statusOverride ?? input.status ?? "fetched",
    credibility: input.credibility ?? "medium",
    retrievedAt: timestamp,
    timestamp,
    relevanceScore: clampScore(input.relevanceScore ?? input.relevance_score ?? 0.5),
    relevance_score: clampScore(input.relevance_score ?? input.relevanceScore ?? 0.5)
  });
}

function dedupeEvidence(items) {
  const seen = new Set();
  const deduped = [];
  for (const item of items) {
    const key = `${item.source}:${item.sourceUrl}:${item.title}`.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(item);
    }
  }
  return deduped;
}

async function withTimeout(promiseFactory, timeoutMs, label) {
  const controller = new AbortController();
  let timeout;
  try {
    return await Promise.race([
      promiseFactory(controller.signal),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

class MarketMetadataEvidenceAdapter {
  id = "market-metadata";

  async search({ market }) {
    return [{
      source: this.id,
      sourceUrl: `polypulse://market/${market.marketId}`,
      title: "Market metadata"
    }];
  }

  async fetch(ref, { market }) {
    const prices = market.outcomes
      .map((outcome) => `${outcome.label}=${outcome.impliedProbability ?? outcome.lastPrice ?? "n/a"}`)
      .join(", ");
    return {
      source: this.id,
      sourceUrl: ref.sourceUrl,
      title: ref.title,
      summary: [
        `Question: ${market.question}`,
        `Category: ${market.category ?? "unknown"}`,
        `Liquidity USD: ${market.liquidityUsd}`,
        `24h volume USD: ${market.volume24hUsd}`,
        `Outcome prices: ${prices}`,
        `Market active=${market.active}, closed=${market.closed}, tradable=${market.tradable}`
      ].join("\n"),
      status: "fetched",
      credibility: "medium",
      relevanceScore: 0.7
    };
  }
}

class ResolutionEvidenceAdapter {
  id = "resolution-source";

  async search({ market }) {
    return [{
      source: this.id,
      sourceUrl: market.resolutionSourceUrl ?? market.marketUrl ?? `polypulse://resolution/${market.marketId}`,
      title: "Resolution rules and source"
    }];
  }

  async fetch(ref, { market }) {
    if (!market.resolutionRules) {
      return {
        source: this.id,
        sourceUrl: ref.sourceUrl,
        title: ref.title,
        summary: "Resolution rules are unavailable in the market snapshot.",
        status: "failed",
        credibility: "low",
        relevanceScore: 0
      };
    }
    return {
      source: this.id,
      sourceUrl: ref.sourceUrl,
      title: ref.title,
      summary: market.resolutionRules,
      status: "fetched",
      credibility: market.resolutionSourceUrl ? "high" : "medium",
      relevanceScore: 0.85
    };
  }
}

export class EvidenceCrawler {
  constructor(config = {}) {
    this.config = config;
    this.adapters = [
      new MarketMetadataEvidenceAdapter(),
      new ResolutionEvidenceAdapter(),
      new PolymarketPageEvidenceAdapter(config),
      new OrderBookEvidenceAdapter(config),
      new ResolutionSourceLiveAdapter(config),
      new SportsScheduleAdapter(config),
      new MacroCalendarAdapter(config),
      new WeatherDataAdapter(config),
      new OnChainDataAdapter(config),
      new FinancialDataAdapter(config)
    ];
    this.cachePath = config.stateDir ? path.join(config.stateDir, "evidence-cache.json") : null;
    this.cacheTtlSeconds = config.evidence?.cacheTtlSeconds ?? 1800;
    this.timeoutMs = config.evidence?.requestTimeoutMs ?? 10000;
    this.retries = config.evidence?.requestRetries ?? 1;
    this.cacheWrite = Promise.resolve();
  }

  async collect({ market, noCache = false }) {
    const collected = [];
    for (const adapter of this.adapters) {
      const refs = await this.callAdapter({
        adapter,
        label: `${adapter.id}.search`,
        fallback: [],
        fn: (signal) => adapter.search({ market, signal, priorEvidence: collected })
      });
      for (const ref of refs) {
        const cacheKey = hash({ marketId: market.marketId, adapterId: adapter.id, ref });
        const cached = noCache ? null : await this.readCache(cacheKey);
        if (cached?.fresh) {
          collected.push(normalizeEvidence(cached.entry.evidence, { market, adapterId: adapter.id, statusOverride: "cached" }));
          continue;
        }
        const evidence = await this.callAdapter({
          adapter,
          label: `${adapter.id}.fetch`,
          fallback: {
            source: adapter.id,
            sourceUrl: ref.sourceUrl ?? `polypulse://${adapter.id}/${market.marketId}`,
            title: ref.title ?? `${adapter.id} fetch failed`,
            summary: `${adapter.id} did not return usable evidence.`,
            status: "failed",
            credibility: "low",
            relevanceScore: 0
          },
          fn: (signal) => adapter.fetch(ref, { market, signal })
        });
        const normalized = normalizeEvidence(evidence, { market, adapterId: adapter.id });
        collected.push(normalized);
        if (!noCache && normalized.status !== "failed") {
          await this.writeCache(cacheKey, normalized);
        }
      }
    }
    return dedupeEvidence(collected).sort((a, b) => b.relevanceScore - a.relevanceScore);
  }

  async callAdapter({ adapter, label, fallback, fn }) {
    let lastError = null;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        return await withTimeout(fn, this.timeoutMs, label);
      } catch (error) {
        lastError = error;
        if (attempt < this.retries) {
          await sleep(100 * (attempt + 1));
        }
      }
    }
    if (Array.isArray(fallback)) {
      return fallback;
    }
    return {
      ...fallback,
      summary: `${fallback.summary} Error: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    };
  }

  async readCache(key) {
    if (!this.cachePath || this.cacheTtlSeconds <= 0) {
      return null;
    }
    const store = await this.readCacheStore();
    const entry = store.entries?.[key];
    if (!entry) {
      return null;
    }
    const ageMs = Date.now() - Date.parse(entry.cachedAt);
    return {
      entry,
      fresh: ageMs >= 0 && ageMs <= this.cacheTtlSeconds * 1000
    };
  }

  async readCacheStore() {
    if (!this.cachePath || !existsSync(this.cachePath)) {
      return { version: 1, entries: {} };
    }
    const parsed = JSON.parse(await readFile(this.cachePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : { version: 1, entries: {} };
  }

  async writeCache(key, evidence) {
    if (!this.cachePath || this.cacheTtlSeconds <= 0) {
      return;
    }
    const task = this.cacheWrite.catch(() => {}).then(async () => {
      const store = await this.readCacheStore();
      const entries = Object.fromEntries(Object.entries(store.entries ?? {}).slice(-100));
      entries[key] = {
        cachedAt: nowIso(),
        evidence
      };
      await mkdir(path.dirname(this.cachePath), { recursive: true });
      const tempPath = `${this.cachePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tempPath, JSON.stringify({ version: 1, entries }, null, 2), "utf8");
      await rename(tempPath, this.cachePath);
    });
    this.cacheWrite = task;
    return await task;
  }
}

export const defaultEvidenceAdapters = {
  MarketMetadataEvidenceAdapter,
  ResolutionEvidenceAdapter,
  PolymarketPageEvidenceAdapter,
  OrderBookEvidenceAdapter,
  ResolutionSourceLiveAdapter,
  SportsScheduleAdapter,
  MacroCalendarAdapter,
  WeatherDataAdapter,
  OnChainDataAdapter,
  FinancialDataAdapter
};
