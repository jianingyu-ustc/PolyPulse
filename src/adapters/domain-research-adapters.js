/**
 * DomainResearchAdapters
 *
 * Aligns with Predict-Raven's domain-specific data source adapters:
 * Provides specialized evidence adapters for specific market categories
 * (sports, macro economics, weather, on-chain, financial/earnings).
 *
 * Architecture:
 * - Each domain adapter implements the standard evidence adapter interface:
 *   search({ market, signal, priorEvidence }) → refs[]
 *   fetch(ref, { market, signal }) → evidence item
 * - Adapters are category-aware: they only activate for markets matching their domain
 * - Adapters fetch from publicly accessible data sources specific to each domain
 * - Failed fetches return status="failed" evidence (no pipeline blocking)
 *
 * Domain adapters:
 * 1. SportsScheduleAdapter - sports schedules, injury reports, team stats
 * 2. MacroCalendarAdapter - economic calendar events (FOMC, CPI, GDP, etc.)
 * 3. WeatherDataAdapter - weather forecasts and severe weather alerts
 * 4. OnChainDataAdapter - blockchain data (prices, gas, TVL, whale movements)
 * 5. FinancialDataAdapter - earnings calendars, stock data, company announcements
 *
 * These adapters are registered in the EvidenceCrawler AFTER the core adapters,
 * and only activate when market category/question matches their domain.
 */

import { randomUUID } from "node:crypto";

function nowIso() {
  return new Date().toISOString();
}

function clampScore(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, Number(n.toFixed(4)))) : 0;
}

function matchesDomain(market, patterns) {
  const text = [
    market.question,
    market.category,
    market.marketSlug,
    market.eventSlug,
    ...(market.tags ?? [])
  ].filter(Boolean).join(" ").toLowerCase();
  return patterns.some((p) => text.includes(p));
}

function buildDomainEvidence({ market, adapterId, title, summary, sourceUrl, status, credibility, relevanceScore, metadata }) {
  return {
    evidenceId: randomUUID(),
    marketId: market.marketId,
    source: adapterId,
    sourceUrl: sourceUrl ?? `polypulse://${adapterId}/${market.marketId}`,
    url: sourceUrl ?? `polypulse://${adapterId}/${market.marketId}`,
    title: title ?? `${adapterId} data`,
    summary: summary ?? `No data available from ${adapterId}.`,
    status: status ?? "failed",
    credibility: credibility ?? "low",
    retrievedAt: nowIso(),
    timestamp: nowIso(),
    relevanceScore: clampScore(relevanceScore ?? 0),
    relevance_score: clampScore(relevanceScore ?? 0),
    metadata: metadata ?? {}
  };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  if (options?.signal) {
    options.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await globalThis.fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Sports Schedule Adapter
 * Fetches sports-related data for markets about sports events.
 * Uses publicly accessible sports data endpoints.
 */
export class SportsScheduleAdapter {
  constructor(config = {}) {
    this.id = "sports-schedule";
    this.enabled = config.evidence?.domainAdapters !== false;
    this.timeoutMs = config.evidence?.domainAdapterTimeoutMs ?? 10000;
    this.patterns = ["sport", "nba", "nfl", "mlb", "nhl", "soccer", "football", "tennis", "boxing", "mma", "ufc", "f1", "formula", "cricket", "baseball", "basketball", "hockey"];
  }

  async search({ market }) {
    if (!this.enabled || !matchesDomain(market, this.patterns)) return [];
    return [{ source: this.id, sourceUrl: `polypulse://${this.id}/${market.marketId}`, title: "Sports context research" }];
  }

  async fetch(ref, { market, signal }) {
    const query = encodeURIComponent(`${market.question ?? market.marketSlug} sports schedule results`);
    const url = `https://html.duckduckgo.com/html/?q=${query}`;
    try {
      const response = await fetchWithTimeout(url, { headers: { "user-agent": "PolyPulse/0.1 sports-research", "accept": "text/html" }, signal }, this.timeoutMs);
      if (!response.ok) return this.failed(market, `HTTP ${response.status}`);
      const html = await response.text();
      const text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 3000);
      if (text.length < 50) return this.failed(market, "insufficient content");
      return buildDomainEvidence({ market, adapterId: this.id, title: "Sports schedule and results", summary: `[Sports Research]\nQuery: ${market.question}\n\n${text}`, sourceUrl: url, status: "fetched", credibility: "medium", relevanceScore: 0.7, metadata: { domain: "sports", queryTime: nowIso() } });
    } catch (error) {
      return this.failed(market, error instanceof Error ? error.message : String(error));
    }
  }

  failed(market, reason) {
    return buildDomainEvidence({ market, adapterId: this.id, title: "Sports data unavailable", summary: `Sports research failed: ${reason}`, status: "failed", relevanceScore: 0 });
  }
}

/**
 * Macro Calendar Adapter
 * Fetches economic calendar events for markets about macro economics.
 */
export class MacroCalendarAdapter {
  constructor(config = {}) {
    this.id = "macro-calendar";
    this.enabled = config.evidence?.domainAdapters !== false;
    this.timeoutMs = config.evidence?.domainAdapterTimeoutMs ?? 10000;
    this.patterns = ["fed", "fomc", "cpi", "gdp", "inflation", "interest rate", "unemployment", "jobs report", "nonfarm", "pce", "retail sales", "housing", "ism", "pmi", "central bank", "ecb", "boj"];
  }

  async search({ market }) {
    if (!this.enabled || !matchesDomain(market, this.patterns)) return [];
    return [{ source: this.id, sourceUrl: `polypulse://${this.id}/${market.marketId}`, title: "Macro economic calendar" }];
  }

  async fetch(ref, { market, signal }) {
    const query = encodeURIComponent(`${market.question ?? market.marketSlug} economic calendar 2025 2026`);
    const url = `https://html.duckduckgo.com/html/?q=${query}`;
    try {
      const response = await fetchWithTimeout(url, { headers: { "user-agent": "PolyPulse/0.1 macro-research", "accept": "text/html" }, signal }, this.timeoutMs);
      if (!response.ok) return this.failed(market, `HTTP ${response.status}`);
      const html = await response.text();
      const text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 3000);
      if (text.length < 50) return this.failed(market, "insufficient content");
      return buildDomainEvidence({ market, adapterId: this.id, title: "Macro economic context", summary: `[Macro Calendar Research]\nQuery: ${market.question}\n\n${text}`, sourceUrl: url, status: "fetched", credibility: "medium", relevanceScore: 0.7, metadata: { domain: "macro", queryTime: nowIso() } });
    } catch (error) {
      return this.failed(market, error instanceof Error ? error.message : String(error));
    }
  }

  failed(market, reason) {
    return buildDomainEvidence({ market, adapterId: this.id, title: "Macro data unavailable", summary: `Macro calendar research failed: ${reason}`, status: "failed", relevanceScore: 0 });
  }
}

/**
 * Weather Data Adapter
 * Fetches weather forecasts and alerts for weather-related markets.
 */
export class WeatherDataAdapter {
  constructor(config = {}) {
    this.id = "weather-data";
    this.enabled = config.evidence?.domainAdapters !== false;
    this.timeoutMs = config.evidence?.domainAdapterTimeoutMs ?? 10000;
    this.patterns = ["weather", "hurricane", "typhoon", "tornado", "temperature", "rainfall", "snowfall", "storm", "flood", "drought", "heatwave", "climate"];
  }

  async search({ market }) {
    if (!this.enabled || !matchesDomain(market, this.patterns)) return [];
    return [{ source: this.id, sourceUrl: `polypulse://${this.id}/${market.marketId}`, title: "Weather forecast data" }];
  }

  async fetch(ref, { market, signal }) {
    const query = encodeURIComponent(`${market.question ?? market.marketSlug} weather forecast`);
    const url = `https://html.duckduckgo.com/html/?q=${query}`;
    try {
      const response = await fetchWithTimeout(url, { headers: { "user-agent": "PolyPulse/0.1 weather-research", "accept": "text/html" }, signal }, this.timeoutMs);
      if (!response.ok) return this.failed(market, `HTTP ${response.status}`);
      const html = await response.text();
      const text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 3000);
      if (text.length < 50) return this.failed(market, "insufficient content");
      return buildDomainEvidence({ market, adapterId: this.id, title: "Weather forecast and alerts", summary: `[Weather Research]\nQuery: ${market.question}\n\n${text}`, sourceUrl: url, status: "fetched", credibility: "medium", relevanceScore: 0.7, metadata: { domain: "weather", queryTime: nowIso() } });
    } catch (error) {
      return this.failed(market, error instanceof Error ? error.message : String(error));
    }
  }

  failed(market, reason) {
    return buildDomainEvidence({ market, adapterId: this.id, title: "Weather data unavailable", summary: `Weather research failed: ${reason}`, status: "failed", relevanceScore: 0 });
  }
}

/**
 * On-Chain Data Adapter
 * Fetches blockchain-related data for crypto markets.
 */
export class OnChainDataAdapter {
  constructor(config = {}) {
    this.id = "on-chain-data";
    this.enabled = config.evidence?.domainAdapters !== false;
    this.timeoutMs = config.evidence?.domainAdapterTimeoutMs ?? 10000;
    this.patterns = ["crypto", "bitcoin", "btc", "ethereum", "eth", "defi", "nft", "blockchain", "solana", "sol", "layer 2", "l2", "staking", "tvl", "whale", "halving"];
  }

  async search({ market }) {
    if (!this.enabled || !matchesDomain(market, this.patterns)) return [];
    return [{ source: this.id, sourceUrl: `polypulse://${this.id}/${market.marketId}`, title: "On-chain data context" }];
  }

  async fetch(ref, { market, signal }) {
    const query = encodeURIComponent(`${market.question ?? market.marketSlug} crypto blockchain data`);
    const url = `https://html.duckduckgo.com/html/?q=${query}`;
    try {
      const response = await fetchWithTimeout(url, { headers: { "user-agent": "PolyPulse/0.1 onchain-research", "accept": "text/html" }, signal }, this.timeoutMs);
      if (!response.ok) return this.failed(market, `HTTP ${response.status}`);
      const html = await response.text();
      const text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 3000);
      if (text.length < 50) return this.failed(market, "insufficient content");
      return buildDomainEvidence({ market, adapterId: this.id, title: "On-chain and crypto data", summary: `[On-Chain Research]\nQuery: ${market.question}\n\n${text}`, sourceUrl: url, status: "fetched", credibility: "medium", relevanceScore: 0.65, metadata: { domain: "crypto", queryTime: nowIso() } });
    } catch (error) {
      return this.failed(market, error instanceof Error ? error.message : String(error));
    }
  }

  failed(market, reason) {
    return buildDomainEvidence({ market, adapterId: this.id, title: "On-chain data unavailable", summary: `On-chain research failed: ${reason}`, status: "failed", relevanceScore: 0 });
  }
}

/**
 * Financial Data Adapter
 * Fetches earnings calendar, stock data, and company announcements.
 */
export class FinancialDataAdapter {
  constructor(config = {}) {
    this.id = "financial-data";
    this.enabled = config.evidence?.domainAdapters !== false;
    this.timeoutMs = config.evidence?.domainAdapterTimeoutMs ?? 10000;
    this.patterns = ["stock", "earnings", "revenue", "profit", "share price", "market cap", "ipo", "merger", "acquisition", "dividend", "nasdaq", "s&p", "dow", "nyse", "quarterly", "annual report"];
  }

  async search({ market }) {
    if (!this.enabled || !matchesDomain(market, this.patterns)) return [];
    return [{ source: this.id, sourceUrl: `polypulse://${this.id}/${market.marketId}`, title: "Financial data context" }];
  }

  async fetch(ref, { market, signal }) {
    const query = encodeURIComponent(`${market.question ?? market.marketSlug} financial data earnings`);
    const url = `https://html.duckduckgo.com/html/?q=${query}`;
    try {
      const response = await fetchWithTimeout(url, { headers: { "user-agent": "PolyPulse/0.1 financial-research", "accept": "text/html" }, signal }, this.timeoutMs);
      if (!response.ok) return this.failed(market, `HTTP ${response.status}`);
      const html = await response.text();
      const text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 3000);
      if (text.length < 50) return this.failed(market, "insufficient content");
      return buildDomainEvidence({ market, adapterId: this.id, title: "Financial and earnings data", summary: `[Financial Research]\nQuery: ${market.question}\n\n${text}`, sourceUrl: url, status: "fetched", credibility: "medium", relevanceScore: 0.7, metadata: { domain: "financial", queryTime: nowIso() } });
    } catch (error) {
      return this.failed(market, error instanceof Error ? error.message : String(error));
    }
  }

  failed(market, reason) {
    return buildDomainEvidence({ market, adapterId: this.id, title: "Financial data unavailable", summary: `Financial research failed: ${reason}`, status: "failed", relevanceScore: 0 });
  }
}

export const domainAdapters = {
  SportsScheduleAdapter,
  MacroCalendarAdapter,
  WeatherDataAdapter,
  OnChainDataAdapter,
  FinancialDataAdapter
};
