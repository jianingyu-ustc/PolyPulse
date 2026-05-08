/**
 * PolymarketPageEvidenceAdapter
 *
 * Fetches Polymarket event data to extract:
 * - Detailed resolution rules and resolution source URL
 * - Market annotations (announcements/context updates)
 * - Community top comments (sorted by likes)
 *
 * Strategy: Gamma API first (reliable), HTML scrape fallback (fragile).
 */

function truncate(text, maxLength) {
  if (!text || text.length <= maxLength) return text ?? "";
  return text.slice(0, maxLength) + "…";
}

function extractNextData(html) {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function findMarketInProps(nextData, eventSlug) {
  const props = nextData?.props?.pageProps;
  if (!props) return null;
  if (props.event) return props;
  if (props.dehydratedState) {
    const queries = props.dehydratedState.queries ?? [];
    for (const query of queries) {
      const data = query?.state?.data;
      if (data && typeof data === "object" && (data.slug === eventSlug || data.markets)) {
        return data;
      }
    }
  }
  return props;
}

function extractResolution(pageProps) {
  const event = pageProps?.event ?? pageProps;
  const markets = event?.markets ?? [];
  const first = markets[0] ?? event;
  const rules = first?.description ?? first?.resolutionRules ?? first?.rules ?? null;
  const source = first?.resolutionSource ?? first?.resolution_source ?? null;
  return { rules, source };
}

function extractAnnotations(pageProps, limit = 5) {
  const event = pageProps?.event ?? pageProps;
  const annotations = event?.annotations ?? event?.context ?? [];
  if (!Array.isArray(annotations)) return [];
  return annotations.slice(0, limit).map((ann) => ({
    title: ann.title ?? ann.headline ?? "",
    summary: truncate(ann.summary ?? ann.body ?? ann.content ?? "", 400),
    date: ann.createdAt ?? ann.created_at ?? ann.date ?? null,
    hidden: Boolean(ann.hidden)
  }));
}

function extractComments(pageProps, limit = 10) {
  const event = pageProps?.event ?? pageProps;
  const comments = event?.comments ?? event?.topComments ?? [];
  if (!Array.isArray(comments)) return [];
  const sorted = [...comments].sort((a, b) => (b.likes ?? b.numLikes ?? 0) - (a.likes ?? a.numLikes ?? 0));
  return sorted.slice(0, limit).map((comment) => ({
    body: truncate(comment.body ?? comment.content ?? comment.text ?? "", 320),
    user: comment.username ?? comment.user?.username ?? comment.author ?? "anonymous",
    likes: comment.likes ?? comment.numLikes ?? 0,
    createdAt: comment.createdAt ?? comment.created_at ?? null,
    isHolder: Boolean(comment.isHolder ?? comment.is_holder),
    positionsCount: comment.positionsCount ?? comment.positions_count ?? 0
  }));
}

function extractFromGammaPayload(payload) {
  if (!payload) return null;
  const event = Array.isArray(payload) ? payload[0] : payload;
  if (!event) return null;
  const markets = event.markets ?? [];
  const first = markets[0] ?? event;
  const rules = first?.description ?? first?.resolutionRules ?? first?.resolution_rules ?? first?.rules ?? null;
  const source = first?.resolutionSource ?? first?.resolution_source ?? first?.resolutionSourceUrl ?? first?.resolution_source_url ?? null;
  const annotations = (event.annotations ?? event.context ?? []);
  const comments = (event.comments ?? event.topComments ?? []);
  return { event, rules, source, annotations, comments };
}

export class PolymarketPageEvidenceAdapter {
  constructor(config = {}) {
    this.id = "polymarket-page-scrape";
    this.commentLimit = config.evidence?.pageCommentLimit ?? 10;
    this.timeoutMs = config.evidence?.pageTimeoutMs ?? 15000;
    this.enabled = config.evidence?.pageScrape !== false;
    this.gammaHost = config.polymarketGammaHost || "https://gamma-api.polymarket.com";
  }

  async search({ market }) {
    if (!this.enabled) return [];
    const slug = market.eventSlug || market.marketSlug;
    if (!slug) return [];
    return [
      { source: this.id, section: "full", sourceUrl: `https://polymarket.com/event/${slug}`, title: "Polymarket page deep research" }
    ];
  }

  async fetch(ref, { market, signal }) {
    const slug = market.eventSlug || market.marketSlug;
    const url = `https://polymarket.com/event/${slug}`;

    const gammaResult = await this.fetchFromGammaApi(slug, market, signal);
    if (gammaResult) return gammaResult;

    return this.fetchFromHtmlScrape(ref, slug, url, signal);
  }

  async fetchFromGammaApi(slug, market, signal) {
    try {
      const controller = new AbortController();
      if (signal) {
        signal.addEventListener("abort", () => controller.abort(), { once: true });
      }
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      let payload;
      try {
        const eventUrl = `${this.gammaHost}/events?slug=${encodeURIComponent(slug)}`;
        const response = await globalThis.fetch(eventUrl, {
          signal: controller.signal,
          headers: { "user-agent": "PolyPulse/0.1 market-scan" }
        });
        if (!response.ok) {
          const marketUrl = `${this.gammaHost}/markets?slug=${encodeURIComponent(market.marketSlug || slug)}`;
          const marketResp = await globalThis.fetch(marketUrl, {
            signal: controller.signal,
            headers: { "user-agent": "PolyPulse/0.1 market-scan" }
          });
          if (!marketResp.ok) return null;
          payload = await marketResp.json();
        } else {
          payload = await response.json();
        }
      } finally {
        clearTimeout(timeout);
      }

      const extracted = extractFromGammaPayload(payload);
      if (!extracted || !extracted.rules) return null;

      const summaryParts = [];
      summaryParts.push(`[Resolution Rules]\n${truncate(extracted.rules, 2500)}`);
      if (extracted.source) {
        summaryParts.push(`[Resolution Source] ${extracted.source}`);
      }

      const annotations = Array.isArray(extracted.annotations) ? extracted.annotations.slice(0, 5) : [];
      if (annotations.length > 0) {
        const annotationLines = annotations.map((a) =>
          `- ${a.title || a.headline || "Untitled"}${a.createdAt || a.created_at || a.date ? ` (${a.createdAt || a.created_at || a.date})` : ""}${a.hidden ? " [hidden]" : ""}: ${truncate(a.summary || a.body || a.content || "", 400)}`
        );
        summaryParts.push(`[Annotations]\n${annotationLines.join("\n")}`);
      }

      const comments = Array.isArray(extracted.comments) ? extracted.comments : [];
      const sortedComments = [...comments].sort((a, b) => (b.likes ?? b.numLikes ?? 0) - (a.likes ?? a.numLikes ?? 0)).slice(0, this.commentLimit);
      if (sortedComments.length > 0) {
        const commentLines = sortedComments.map((c) =>
          `- @${c.username ?? c.author ?? "anonymous"}${c.isHolder || c.is_holder ? " [holder]" : ""} (${c.likes ?? c.numLikes ?? 0} likes): ${truncate(c.body ?? c.content ?? c.text ?? "", 320)}`
        );
        summaryParts.push(`[Top Comments]\n${commentLines.join("\n")}`);
      }

      return {
        source: this.id,
        sourceUrl: `https://polymarket.com/event/${slug}`,
        title: "Polymarket event page: resolution rules, annotations, and community comments",
        summary: summaryParts.join("\n\n"),
        status: "fetched",
        credibility: extracted.source ? "high" : "medium",
        relevanceScore: 0.9,
        metadata: {
          resolutionSource: extracted.source,
          annotationCount: annotations.length,
          commentCount: sortedComments.length,
          dataSource: "gamma-api"
        }
      };
    } catch {
      return null;
    }
  }

  async fetchFromHtmlScrape(ref, slug, url, signal) {
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
            "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "accept-language": "en-US,en;q=0.9"
          }
        });
        if (!response.ok) {
          return this.failedEvidence(ref, `HTTP ${response.status} from ${url}`);
        }
        html = await response.text();
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      return this.failedEvidence(ref, `fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    const nextData = extractNextData(html);
    if (!nextData) {
      return this.failedEvidence(ref, "could not extract __NEXT_DATA__ from page");
    }

    const pageProps = findMarketInProps(nextData, slug);
    if (!pageProps) {
      return this.failedEvidence(ref, "could not locate market data in page props");
    }

    const resolution = extractResolution(pageProps);
    const annotations = extractAnnotations(pageProps, 5);
    const comments = extractComments(pageProps, this.commentLimit);

    const summaryParts = [];

    if (resolution.rules) {
      summaryParts.push(`[Resolution Rules]\n${truncate(resolution.rules, 2500)}`);
    }
    if (resolution.source) {
      summaryParts.push(`[Resolution Source] ${resolution.source}`);
    }
    if (annotations.length > 0) {
      const annotationLines = annotations.map((a) =>
        `- ${a.title || "Untitled"}${a.date ? ` (${a.date})` : ""}${a.hidden ? " [hidden]" : ""}: ${a.summary}`
      );
      summaryParts.push(`[Annotations]\n${annotationLines.join("\n")}`);
    }
    if (comments.length > 0) {
      const commentLines = comments.map((c) =>
        `- @${c.user}${c.isHolder ? " [holder]" : ""} (${c.likes} likes): ${c.body}`
      );
      summaryParts.push(`[Top Comments]\n${commentLines.join("\n")}`);
    }

    if (summaryParts.length === 0) {
      return this.failedEvidence(ref, "page parsed but no resolution/annotations/comments found");
    }

    return {
      source: this.id,
      sourceUrl: url,
      title: "Polymarket event page: resolution rules, annotations, and community comments",
      summary: summaryParts.join("\n\n"),
      status: "fetched",
      credibility: resolution.source ? "high" : "medium",
      relevanceScore: 0.9,
      metadata: {
        resolutionSource: resolution.source,
        annotationCount: annotations.length,
        commentCount: comments.length,
        dataSource: "html-scrape"
      }
    };
  }

  failedEvidence(ref, reason) {
    return {
      source: this.id,
      sourceUrl: ref.sourceUrl,
      title: ref.title ?? "Polymarket page scrape failed",
      summary: `Page scrape did not return usable evidence. ${reason}`,
      status: "failed",
      credibility: "low",
      relevanceScore: 0
    };
  }
}
