#!/usr/bin/env node
/**
 * Standalone dashboard — runs as a separate process, reads monitor log + live-state.json.
 * Does NOT require the monitor process to be restarted.
 *
 * Usage:
 *   node bin/dashboard-standalone.js [--port 3847] [--log path] [--state path]
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { renderDashboardHtml } from "../src/dashboard/dashboard-html.js";

const args = process.argv.slice(2);
function opt(name, fallback) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

const PORT = Number(opt("--port", "3847"));
const LOG_PATH = path.resolve(opt("--log", "logs/polypulse-monitor.log"));
const STATE_PATH = path.resolve(opt("--state", "runtime-artifacts/state/live-state.json"));

function parseLogLine(line) {
  const match = line.match(/^\[([^\]]+)\]\s+(\S+)\s*\|?\s*(.*)$/);
  if (!match) return null;
  const [, timestamp, event, rest] = match;
  const fields = {};
  for (const pair of rest.matchAll(/(\w+)=("(?:[^"\\]|\\.)*"|(?:[^\s](?:(?!\s\w+=).)*)?\S)/g)) {
    let val = pair[2];
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    fields[pair[1]] = val;
  }
  return { timestamp, event, fields };
}

function parseLog(content) {
  const lines = content.split("\n");
  let sessionStart = null;
  let initialCash = 0;
  let currentCash = 0;
  let equity = 0;
  const openPositions = new Map();
  const closedTrades = [];
  let wins = 0, losses = 0;
  let realizedPnl = 0;
  let maxDrawdown = 0;
  let highWaterMark = 0;
  const predictionCache = new Map();

  for (const line of lines) {
    const parsed = parseLogLine(line);
    if (!parsed) {
      if (line.includes("monitor session started")) {
        sessionStart = lines[lines.indexOf(line) - 1]?.match(/^\[([^\]]+)\]/)?.[1] ?? null;
      }
      if (line.startsWith("initial_cash_usd=")) {
        initialCash = Number(line.split("=")[1]) || 0;
      }
      continue;
    }
    const { timestamp, event, fields } = parsed;

    if (event === "round.start" && !sessionStart) {
      sessionStart = timestamp;
    }

    if (event === "prediction" && fields.phase === "open-scan") {
      const slug = fields.market;
      predictionCache.set(slug, {
        aiProbability: Number(fields.ai_probability) || null,
        marketProbability: Number(fields.market_probability) || null,
        side: fields.side || null,
        edge: Number(fields.edge) || null,
        netEdge: Number(fields.net_edge) || null,
        quarterKellyPct: Number(fields.quarter_kelly_pct) || null,
        monthlyReturn: Number(fields.monthly_return) || null
      });
      if (openPositions.has(slug)) {
        const pos = openPositions.get(slug);
        pos.aiProbability = Number(fields.ai_probability) || null;
        pos.marketProbability = Number(fields.market_probability) || null;
        pos.side = fields.side || pos.side;
        pos.edge = Number(fields.edge) || null;
        pos.netEdge = Number(fields.net_edge) || null;
        pos.quarterKellyPct = Number(fields.quarter_kelly_pct) || null;
        pos.monthlyReturn = Number(fields.monthly_return) || null;
      }
    }

    if (event === "open.filled") {
      const slug = fields.market;
      const cached = predictionCache.get(slug);
      const pos = {
        marketId: slug,
        question: slug,
        outcome: fields.outcome || "",
        side: cached?.side || "",
        openedAt: timestamp,
        endDate: null,
        costUsd: Number(fields.cost_usd) || 0,
        avgPrice: Number(fields.price) || 0,
        size: Number(fields.size) || 0,
        currentPrice: Number(fields.price) || 0,
        currentValueUsd: Number(fields.cost_usd) || 0,
        unrealizedPnlUsd: 0,
        aiProbability: cached?.aiProbability ?? null,
        marketProbability: cached?.marketProbability ?? null,
        edge: cached?.edge ?? null,
        netEdge: cached?.netEdge ?? null,
        quarterKellyPct: cached?.quarterKellyPct ?? null,
        monthlyReturn: cached?.monthlyReturn ?? null,
        orderId: fields.order_id || ""
      };
      openPositions.set(slug, pos);
      currentCash = Number(fields.cash_usd) || currentCash;
    }

    if (event === "close.filled") {
      const slug = fields.market;
      const pos = openPositions.get(slug);
      const pnl = Number(fields.realized_pnl_usd) || 0;
      const closed = {
        marketId: slug,
        question: slug,
        outcome: pos?.outcome ?? fields.outcome ?? "",
        side: pos?.side ?? "",
        openedAt: pos?.openedAt ?? null,
        closedAt: timestamp,
        costUsd: pos?.costUsd ?? 0,
        realizedPnlUsd: pnl,
        returnPct: pos?.costUsd > 0 ? pnl / pos.costUsd : null,
        closeReason: fields.reason || "",
        aiProbability: pos?.aiProbability ?? null,
        marketProbability: pos?.marketProbability ?? null,
        edge: pos?.edge ?? null,
        netEdge: pos?.netEdge ?? null
      };
      closedTrades.push(closed);
      openPositions.delete(slug);
      currentCash = Number(fields.cash_usd) || currentCash;
      realizedPnl += pnl;
      if (pnl > 0) wins++;
      else if (pnl < 0) losses++;
    }

    if (event === "mark_to_market") {
      equity = Number(fields.total_equity_usd) || equity;
    }

    if (event === "round.end") {
      currentCash = Number(fields.cash_usd) || currentCash;
      equity = Number(fields.equity_usd) || equity;
      const w = Number(fields.wins);
      const l = Number(fields.losses);
      if (Number.isFinite(w)) wins = w;
      if (Number.isFinite(l)) losses = l;
      const rpnl = Number(fields.realized_pnl_usd);
      if (Number.isFinite(rpnl)) realizedPnl = rpnl;
      const md = Number(fields.max_drawdown_usd);
      if (Number.isFinite(md)) maxDrawdown = md;
    }

    if (event === "positions.reviewed" || event === "mark_to_market") {
      if (equity > highWaterMark) highWaterMark = equity;
      if (highWaterMark - equity > maxDrawdown) maxDrawdown = highWaterMark - equity;
    }
  }

  if (!equity && initialCash) {
    const openValue = [...openPositions.values()].reduce((s, p) => s + p.currentValueUsd, 0);
    equity = currentCash + openValue;
  }

  return { sessionStart, initialCash, currentCash, equity, openPositions, closedTrades, wins, losses, realizedPnl, maxDrawdown };
}

async function readLiveState() {
  try {
    const content = await readFile(STATE_PATH, "utf8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function getData() {
  let logContent = "";
  try {
    logContent = await readFile(LOG_PATH, "utf8");
  } catch {
    return { error: "log_not_found", startedAt: null, executionMode: "unknown", summary: {}, openPositions: [], closedPositions: [] };
  }

  const log = parseLog(logContent);
  const liveState = await readLiveState();

  const startedAt = log.sessionStart ?? liveState?.monitorState?.lastStartedAt ?? null;
  const initialCash = log.initialCash || 0;
  const totalEquity = log.equity || initialCash;
  const elapsedMs = startedAt ? Date.now() - new Date(startedAt).getTime() : 0;
  const elapsedDays = Math.max(1, elapsedMs / 86_400_000);
  const totalReturnPct = initialCash > 0 ? (totalEquity - initialCash) / initialCash : 0;
  const dailyReturn = totalReturnPct / elapsedDays;
  const winRate = (log.wins + log.losses) > 0 ? log.wins / (log.wins + log.losses) : null;
  const unrealizedPnl = [...log.openPositions.values()].reduce((s, p) => s + p.unrealizedPnlUsd, 0);

  return {
    startedAt,
    executionMode: liveState ? "live" : "paper",
    summary: {
      initialCashUsd: Number(initialCash.toFixed(2)),
      cashUsd: Number(log.currentCash.toFixed(2)),
      totalEquityUsd: Number(totalEquity.toFixed(2)),
      unrealizedPnlUsd: Number(unrealizedPnl.toFixed(2)),
      realizedPnlUsd: Number(log.realizedPnl.toFixed(2)),
      winRate,
      closedTrades: log.closedTrades.length,
      wins: log.wins,
      losses: log.losses,
      maxDrawdownUsd: Number(log.maxDrawdown.toFixed(2)),
      monthlyReturnPct: Number((dailyReturn * 30).toFixed(4)),
      annualReturnPct: Number((dailyReturn * 365).toFixed(4)),
      totalReturnPct: Number(totalReturnPct.toFixed(4)),
      elapsedDays: Number(elapsedDays.toFixed(1))
    },
    openPositions: [...log.openPositions.values()].map(p => ({
      positionId: p.orderId || p.marketId,
      marketId: p.marketId,
      question: p.question,
      outcome: p.outcome,
      side: p.side || "",
      openedAt: p.openedAt,
      endDate: p.endDate,
      costUsd: p.costUsd,
      currentValueUsd: p.currentValueUsd,
      unrealizedPnlUsd: p.unrealizedPnlUsd,
      aiProbability: p.aiProbability,
      marketProbability: p.marketProbability,
      edge: p.edge,
      netEdge: p.netEdge,
      feeImpact: p.edge != null && p.netEdge != null ? p.edge - p.netEdge : null,
      quarterKellyPct: p.quarterKellyPct,
      monthlyReturn: p.monthlyReturn
    })),
    closedPositions: log.closedTrades.slice(-100).reverse().map(t => ({
      positionId: t.marketId,
      marketId: t.marketId,
      question: t.question,
      outcome: t.outcome,
      side: t.side || "",
      openedAt: t.openedAt,
      closedAt: t.closedAt,
      costUsd: t.costUsd,
      realizedPnlUsd: t.realizedPnlUsd,
      returnPct: t.returnPct,
      closeReason: t.closeReason,
      aiProbability: t.aiProbability,
      marketProbability: t.marketProbability,
      edge: t.edge,
      netEdge: t.netEdge,
      feeImpact: t.edge != null && t.netEdge != null ? t.edge - t.netEdge : null
    }))
  };
}

const html = renderDashboardHtml();
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/data") {
      const data = await getData();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(JSON.stringify(data));
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  } catch (err) {
    console.error(`[dashboard] error: ${err.message}`);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal Server Error");
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[dashboard] http://0.0.0.0:${PORT}`);
  console.log(`[dashboard] log: ${LOG_PATH}`);
  console.log(`[dashboard] state: ${STATE_PATH}`);
});
