/**
 * ResolutionSourceLiveAdapter
 *
 * Visits the actual resolution source URL (from market data or page-scrape evidence)
 * to fetch current real-time state from the official data source.
 *
 * This aligns with Predict-Raven SKILL.md's A0 module:
 * "Resolution Source 实时查验 — 必须在 A1 之前执行"
 *
 * Key properties:
 * - Extracts resolution source URL from market.resolutionSourceUrl or from prior
 *   page-scrape evidence metadata
 * - Fetches the page content and extracts readable text (up to configurable limit)
 * - Returns high-credibility evidence that serves as a "hard constraint" for AI estimation
 * - Graceful failure: if source is unreachable, returns status=failed evidence
 *   with note "resolution source 当前状态未确认" so AI can downweight claims
 *
 * The AI receives this evidence BEFORE making probability estimates, ensuring
 * factual grounding against the official data source rather than relying on
 * potentially stale AI memory about in-progress events.
 */

function extractReadableText(html, maxLength = 8000) {
  let text = html;
  // Remove script/style blocks
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ");
  // Remove HTML tags
  text = text.replace(/<[^>]+>/g, " ");
  // Decode common entities
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, " ");
  // Collapse whitespace
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > maxLength) {
    text = text.slice(0, maxLength) + "…";
  }
  return text;
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (match) {
    return match[1].replace(/\s+/g, " ").trim().slice(0, 200);
  }
  return null;
}

function isValidUrl(value) {
  if (!value || typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function findResolutionSourceUrl(market, priorEvidence) {
  // 1. Direct from market data
  if (isValidUrl(market.resolutionSourceUrl)) {
    return market.resolutionSourceUrl;
  }

  // 2. From page-scrape evidence metadata
  if (Array.isArray(priorEvidence)) {
    for (const ev of priorEvidence) {
      if (ev.source === "polymarket-page-scrape" && ev.metadata?.resolutionSource) {
        if (isValidUrl(ev.metadata.resolutionSource)) {
          return ev.metadata.resolutionSource;
        }
      }
    }
  }

  // 3. Extract URL from resolution rules text
  if (market.resolutionRules) {
    const urlMatch = market.resolutionRules.match(/https?:\/\/[^\s<>"')\]]+/);
    if (urlMatch && isValidUrl(urlMatch[0])) {
      return urlMatch[0];
    }
  }

  return null;
}

export class ResolutionSourceLiveAdapter {
  constructor(config = {}) {
    this.id = "resolution-source-live";
    this.enabled = config.evidence?.resolutionSourceLive !== false;
    this.timeoutMs = config.evidence?.resolutionSourceTimeoutMs ?? 15000;
    this.maxContentLength = config.evidence?.resolutionSourceMaxContent ?? 8000;
  }

  async search({ market, priorEvidence }) {
    if (!this.enabled) return [];
    const url = findResolutionSourceUrl(market, priorEvidence);
    if (!url) return [];
    return [{
      source: this.id,
      sourceUrl: url,
      title: "Resolution source live verification"
    }];
  }

  async fetch(ref, { market, signal }) {
    const url = ref.sourceUrl;
    if (!isValidUrl(url)) {
      return this.failedEvidence(ref, "invalid resolution source URL");
    }

    let html;
    try {
      const controller = new AbortController();
      if (signal) {
        signal.addEventListener("abort", () => controller.abort(), { once: true });
      }
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await globalThis.fetch(url, {
          signal: controller.signal,
          headers: {
            "user-agent": "PolyPulse/0.1 resolution-source-check",
            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
          },
          redirect: "follow"
        });
        if (!response.ok) {
          return this.failedEvidence(ref, `HTTP ${response.status} from resolution source`);
        }
        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          const json = await response.json();
          const jsonText = JSON.stringify(json, null, 2);
          return this.buildEvidence(ref, url, jsonText.slice(0, this.maxContentLength), "JSON data from resolution source");
        }
        html = await response.text();
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return this.failedEvidence(ref, `resolution source 当前状态未确认: ${msg}`);
    }

    const pageTitle = extractTitle(html) || "Resolution source page";
    const readableText = extractReadableText(html, this.maxContentLength);

    if (!readableText || readableText.length < 50) {
      return this.failedEvidence(ref, "resolution source page content too short or unreadable");
    }

    return this.buildEvidence(ref, url, readableText, pageTitle);
  }

  buildEvidence(ref, url, content, pageTitle) {
    const queryTime = new Date().toISOString();
    const summary = [
      `[Resolution Source Live Check]`,
      `Source: ${url}`,
      `Query time: ${queryTime}`,
      `Page title: ${pageTitle}`,
      ``,
      `[Content]`,
      content
    ].join("\n");

    return {
      source: this.id,
      sourceUrl: url,
      title: `Resolution source: ${pageTitle}`,
      summary,
      status: "fetched",
      credibility: "high",
      relevanceScore: 0.95,
      metadata: {
        queryTime,
        pageTitle,
        contentLength: content.length,
        resolutionSourceUrl: url
      }
    };
  }

  failedEvidence(ref, reason) {
    return {
      source: this.id,
      sourceUrl: ref.sourceUrl,
      title: ref.title ?? "Resolution source live check failed",
      summary: `Resolution source 当前状态未确认. ${reason}`,
      status: "failed",
      credibility: "low",
      relevanceScore: 0
    };
  }
}

export const resolutionSourceInternals = {
  findResolutionSourceUrl,
  extractReadableText,
  extractTitle,
  isValidUrl
};
