import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateSchema } from "../src/domain/schemas.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "bin", "polypulse.js");

async function runCli(args) {
  const dir = await mkdtemp(path.join(tmpdir(), "polypulse-test-"));
  const env = {
    ...process.env,
    POLYPULSE_MARKET_SOURCE: "mock",
    STATE_DIR: path.join(dir, "state"),
    ARTIFACT_DIR: path.join(dir, "artifacts")
  };
  return await new Promise((resolve, reject) => {
    execFile(process.execPath, [cliPath, ...args], { cwd: repoRoot, env }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message));
        return;
      }
      resolve(JSON.parse(stdout));
    });
  });
}

test("domain schema validates a market-like object", () => {
  const result = validateSchema("Market", {
    marketId: "m1",
    eventId: "e1",
    marketSlug: "slug",
    eventSlug: "event",
    question: "Question?",
    outcomes: [],
    endDate: null,
    resolutionRules: null,
    resolutionSourceUrl: null,
    liquidityUsd: 100,
    volumeUsd: 1000,
    volume24hUsd: 10,
    category: null,
    tags: [],
    active: true,
    closed: false,
    tradable: true,
    source: "test",
    riskFlags: [],
    fetchedAt: new Date().toISOString()
  });
  assert.equal(result.ok, true);
});

test("env check runs in default paper mode", async () => {
  const output = await runCli(["env", "check"]);
  assert.equal(output.ok, true);
  assert.equal(output.report.mode, "paper");
});

test("market topics smoke supports --limit 20", async () => {
  const output = await runCli(["market", "topics", "--limit", "20"]);
  assert.equal(output.ok, true);
  assert.equal(output.topics.length, 3);
  assert.match(output.artifacts.markets.path, /markets\/.+\/markets\.json$/);
  assert.match(output.artifacts.summary.path, /markets\/.+\/summary\.md$/);
});

test("account balance writes account artifact", async () => {
  const output = await runCli(["account", "balance"]);
  assert.equal(output.ok, true);
  assert.equal(output.executionMode, "paper");
  assert.equal(typeof output.collateralBalance, "number");
  assert.match(output.artifact.path, /account\/.+\/balance\.json$/);
});

test("predict smoke returns compact probability and artifacts", async () => {
  const output = await runCli(["predict", "--market", "market-001"]);
  assert.equal(output.ok, true);
  assert.equal(typeof output.ai_probability, "number");
  assert.ok(["low", "medium", "high"].includes(output.confidence));
  assert.match(output.artifact, /predictions\/.+\/decision\.md$/);
  assert.equal("evidence" in output, false);
});

test("paper trade once uses RiskEngine and PaperBroker", async () => {
  const output = await runCli(["trade", "once", "--mode", "paper", "--market", "market-001", "--max-amount", "1"]);
  assert.equal(output.ok, true);
  assert.equal(output.action, "paper-order");
  assert.match(output.artifact, /runs\/.+-once\/summary\.md$/);
});

test("live trade without confirmation is blocked before broker submit", async () => {
  const output = await runCli(["trade", "once", "--mode", "live", "--market", "market-001", "--max-amount", "1"]);
  assert.equal(output.ok, true);
  assert.equal(output.action, "no-trade");
  assert.match(output.artifact, /runs\/.+-once\/summary\.md$/);
});
