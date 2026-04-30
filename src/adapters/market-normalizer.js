import { createHash } from "node:crypto";
import { assertSchema } from "../domain/schemas.js";

function firstValue(row, names) {
  for (const name of names) {
    if (row?.[name] !== undefined && row?.[name] !== null && row?.[name] !== "") {
      return row[name];
    }
  }
  return null;
}

function asString(value, fallback = "") {
  if (value == null) {
    return fallback;
  }
  return String(value).trim() || fallback;
}

function asNumber(value, fallback = 0) {
  if (value == null || value === "") {
    return fallback;
  }
  const normalized = typeof value === "string" ? value.replace(/,/g, "") : value;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : fallback;
}

function asOptionalNumber(value) {
  if (value == null || value === "") {
    return null;
  }
  const number = asNumber(value, Number.NaN);
  return Number.isFinite(number) ? number : null;
}

function asBoolean(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes"].includes(normalized)) return true;
    if (["false", "0", "no"].includes(normalized)) return false;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  return fallback;
}

export function parseMaybeJsonArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return [];
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return trimmed.includes(",") ? trimmed.split(",").map((item) => item.trim()).filter(Boolean) : [];
  }
}

function probability(value) {
  const number = asOptionalNumber(value);
  return number != null && number >= 0 && number <= 1 ? number : null;
}

function normalizeTags(value) {
  return parseMaybeJsonArray(value)
    .map((tag) => {
      if (tag && typeof tag === "object") {
        return asString(firstValue(tag, ["slug", "label", "name", "title"]));
      }
      return asString(tag);
    })
    .filter(Boolean);
}

function slugify(value) {
  return asString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function shortHash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}

function normalizeEndDate(value) {
  const raw = asString(value);
  if (!raw) {
    return null;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : date.toISOString();
}

function marketUrl(row, eventSlug, marketSlug) {
  const explicit = asString(firstValue(row, ["url", "marketUrl", "market_url"]));
  if (explicit) {
    return explicit.startsWith("http") ? explicit : `https://polymarket.com${explicit.startsWith("/") ? "" : "/"}${explicit}`;
  }
  if (eventSlug) {
    return `https://polymarket.com/event/${eventSlug}`;
  }
  return marketSlug ? `https://polymarket.com/market/${marketSlug}` : null;
}

function eventRecord(row) {
  const events = parseMaybeJsonArray(firstValue(row, ["events"]));
  const first = events.find((item) => item && typeof item === "object");
  return first ?? {};
}

function normalizeOutcomes({ row, marketId, riskFlags }) {
  const labels = parseMaybeJsonArray(firstValue(row, ["outcomes", "outcomeNames", "outcome_names"]))
    .map((item) => asString(item))
    .filter(Boolean);
  const tokenIds = parseMaybeJsonArray(firstValue(row, ["clobTokenIds", "clob_token_ids", "tokenIds", "token_ids"]))
    .map((item) => asString(item))
    .filter(Boolean);
  const prices = parseMaybeJsonArray(firstValue(row, ["outcomePrices", "outcome_prices", "prices"]))
    .map((item) => probability(item));
  const outcomeCount = Math.max(labels.length, tokenIds.length, prices.length);

  if (outcomeCount === 0) {
    riskFlags.push("missing_outcomes");
  }
  if (tokenIds.length === 0) {
    riskFlags.push("missing_clob_token_ids");
  }
  if (prices.length === 0 || prices.every((price) => price == null)) {
    riskFlags.push("missing_prices");
  }
  if (tokenIds.length > 0 && outcomeCount !== tokenIds.length) {
    riskFlags.push("outcome_token_count_mismatch");
  }

  const rowBestBid = asOptionalNumber(firstValue(row, ["bestBid", "best_bid"]));
  const rowBestAsk = asOptionalNumber(firstValue(row, ["bestAsk", "best_ask"]));

  return Array.from({ length: outcomeCount }).map((_, index) => {
    const label = labels[index] || (index === 0 ? "Yes" : index === 1 ? "No" : `Outcome ${index + 1}`);
    const lastPrice = prices[index] ?? null;
    return assertSchema("Outcome", {
      id: `${marketId}-${slugify(label) || index}`,
      label,
      tokenId: tokenIds[index] ?? "",
      bestBid: index === 0 ? rowBestBid : null,
      bestAsk: index === 0 ? rowBestAsk : null,
      lastPrice,
      impliedProbability: lastPrice
    });
  });
}

export function normalizePolymarketMarket(row, options = {}) {
  const now = options.fetchedAt ?? new Date().toISOString();
  const event = eventRecord(row);
  const riskFlags = [];
  const question = asString(firstValue(row, ["question", "title", "name", "description"]));
  const marketSlug = asString(firstValue(row, ["slug", "marketSlug", "market_slug"])) || slugify(question);
  const eventSlug = asString(firstValue(row, ["eventSlug", "event_slug"]) ?? firstValue(event, ["slug"])) || marketSlug;
  const marketId = asString(firstValue(row, ["id", "marketId", "market_id", "conditionId", "condition_id", "questionID", "question_id"]))
    || `unknown-${shortHash(`${marketSlug}:${question}`)}`;
  const eventId = asString(firstValue(row, ["eventId", "event_id"]) ?? firstValue(event, ["id", "ticker"]))
    || `event-${shortHash(eventSlug || marketId)}`;
  const active = asBoolean(firstValue(row, ["active"]), true);
  const closed = asBoolean(firstValue(row, ["closed"]), false);
  const acceptingOrdersRaw = firstValue(row, ["acceptingOrders", "accepting_orders", "enableOrderBook", "enable_order_book"]);
  const acceptingOrders = acceptingOrdersRaw == null ? true : asBoolean(acceptingOrdersRaw, true);
  const outcomes = normalizeOutcomes({ row, marketId, riskFlags });
  const liquidityUsd = asNumber(firstValue(row, ["liquidity", "liquidityNum", "liquidity_num", "liquidityUsd", "liquidity_usd"]), 0);
  const volumeUsd = asNumber(firstValue(row, ["volume", "volumeNum", "volume_num", "volumeUsd", "volume_usd"]), 0);
  const volume24hUsd = asNumber(firstValue(row, ["volume24hr", "volume_24hr", "volume24h", "volume24hUsd", "volume_24h_usd"]), 0);
  const category = asString(
    firstValue(row, ["category", "categorySlug", "category_slug", "categoryLabel", "category_label"])
      ?? firstValue(event, ["category", "categorySlug", "category_slug", "categoryLabel", "category_label"]),
    null
  );
  const tags = [
    ...normalizeTags(firstValue(row, ["tags"])),
    ...normalizeTags(firstValue(event, ["tags"]))
  ];

  if (!firstValue(row, ["id", "marketId", "market_id", "conditionId", "condition_id", "questionID", "question_id"])) {
    riskFlags.push("missing_market_id");
  }
  if (!marketSlug) {
    riskFlags.push("missing_market_slug");
  }
  if (!question) {
    riskFlags.push("missing_question");
  }
  if (liquidityUsd <= 0) {
    riskFlags.push("missing_or_zero_liquidity");
  }
  if (!firstValue(row, ["resolutionRules", "resolution_rules", "rules", "description"])) {
    riskFlags.push("missing_resolution_rules");
  }

  const tradable = active && !closed && outcomes.length > 0 && outcomes.some((outcome) => outcome.tokenId) && acceptingOrders;

  return assertSchema("Market", {
    marketId,
    eventId,
    marketSlug,
    eventSlug,
    question,
    title: asString(firstValue(row, ["title", "name"])) || question || null,
    marketUrl: marketUrl(row, eventSlug, marketSlug),
    outcomes,
    endDate: normalizeEndDate(firstValue(row, ["endDate", "end_date", "endDateIso", "end_date_iso"])),
    resolutionRules: asString(firstValue(row, ["resolutionRules", "resolution_rules", "rules", "description"]), null),
    resolutionSourceUrl: asString(firstValue(row, ["resolutionSourceUrl", "resolution_source_url", "sourceUrl", "source_url"]), null),
    liquidityUsd,
    volumeUsd,
    volume24hUsd,
    category,
    tags: [...new Set(tags)].filter(Boolean),
    active,
    closed,
    tradable,
    source: "polymarket-gamma",
    riskFlags,
    fetchedAt: now
  });
}
