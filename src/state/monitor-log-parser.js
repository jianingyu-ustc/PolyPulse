import { readFile } from "node:fs/promises";

export class MonitorLogParser {
  constructor(logPath, { maxLines = 5000 } = {}) {
    this.logPath = logPath;
    this.maxLines = maxLines;
  }

  async parseRecent() {
    try {
      const content = await readFile(this.logPath, "utf8");
      const lines = content.split("\n");
      const recentLines = lines.slice(-this.maxLines);
      return this.parseLines(recentLines);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { closedTrades: [], skippedCandidates: [] };
      }
      throw error;
    }
  }

  parseLines(lines) {
    const closedTrades = [];
    const skippedCandidates = [];
    const seenClosed = new Set();
    const skippedMap = new Map();

    for (const line of lines) {
      const event = this.parseLine(line);
      if (!event) continue;

      if (event.type === "close.filled" && event.market) {
        const key = event.market;
        if (!seenClosed.has(key)) {
          closedTrades.push(event);
          seenClosed.add(key);
        }
      }

      if (event.type === "candidate" && !event.selected && event.reason && event.market) {
        const key = event.market;
        if (!skippedMap.has(key)) {
          skippedCandidates.push({
            market: event.market,
            category: event.category || null,
            liquidity: event.liquidity || null,
            stage: event.stage || null,
            reason: event.reason,
            timestamp: event.timestamp
          });
          skippedMap.set(key, true);
        }
      }
    }

    return { closedTrades, skippedCandidates: skippedCandidates.slice(-100).reverse() };
  }

  parseLine(line) {
    const match = line.match(/^\[([^\]]+)\]\s+([a-z._]+)\s*\|?\s*(.*)$/);
    if (!match) return null;

    const [, timestamp, eventType, kvString] = match;
    const kv = this.parseKeyValuePairs(kvString);

    switch (eventType) {
      case "close.filled":
        return {
          type: "close.filled",
          timestamp,
          market: kv.market,
          outcome: kv.outcome,
          reason: kv.reason,
          exitPrice: kv.exit_price ? Number(kv.exit_price) : null,
          proceedsUsd: kv.proceeds_usd ? Number(kv.proceeds_usd) : null,
          realizedPnlUsd: kv.realized_pnl_usd ? Number(kv.realized_pnl_usd) : null,
          winRate: kv.win_rate ? Number(kv.win_rate) : null
        };

      case "candidate":
        return {
          type: "candidate",
          timestamp,
          market: kv.market,
          selected: kv.selected === "true",
          reason: kv.reason,
          stage: kv.stage,
          category: kv.category,
          liquidity: kv.liq ? Number(kv.liq) : null
        };

      default:
        return null;
    }
  }

  parseKeyValuePairs(kvString) {
    const result = {};
    if (!kvString) return result;

    let current = kvString.trim();
    while (current.length > 0) {
      const match = current.match(/^(\w+)=(.+?)(?:\s+(\w+)=|$)/);
      if (!match) {
        break;
      }

      const [, key, value, rest] = match;
      result[key] = this.decodeValue(value.trim());
      current = rest || "";
    }

    return result;
  }

  decodeValue(value) {
    if (!value) return value;
    if (value === "none" || value === "n/a") return null;

    if (value.startsWith('"') && value.endsWith('"')) {
      return value.slice(1, -1);
    }

    if (value.startsWith("{") || value.startsWith("[")) {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }

    return value;
  }
}