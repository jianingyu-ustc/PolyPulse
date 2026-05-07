/**
 * PolymarketPageEvidenceAdapter
 *
 * Scrapes Polymarket event pages (__NEXT_DATA__ SSR payload) to extract:
 * - Detailed resolution rules and resolution source URL
 * - Market annotations (announcements/context updates)
 * - Community top comments (sorted by likes)
 *
 * This aligns with Predict-Raven's scrape-market.ts deep research step.
 */

function truncate(text, maxLength) {
  if (!text || text.length <= maxLength) return text ?? "";
  return text.slice(0, maxLength) + "…";
}

function extractNextData(html) {
  const marker = '<script id="__NEXT_DATA__" type="application/json">';
  const start = html.indexOf(marker);
  if (start < 0) return null;
  const jsonStart = start + marker.length;
  const end = html.indexOf("</script>", jsonStart);
  if (end < 0) return null;
  try {
    return JSON.parse(html.slice(jsonStart, end));
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

export class PolymarketPageEvidenceAdapter {
  constructor(config = {}) {
    this.id = "polymarket-page-scrape";
    this.commentLimit = config.evidence?.pageCommentLimit ?? 10;
    this.timeoutMs = config.evidence?.pageTimeoutMs ?? 15000;
    this.enabled = config.evidence?.pageScrape !== false;
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
          headers: { "user-agent": "PolyPulse/0.1 evidence-scrape" }
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
        commentCount: comments.length
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
