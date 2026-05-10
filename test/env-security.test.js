import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, loadEnvConfig, validateEnvConfig } from "../src/config/env.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "bin", "polypulse.js");

function allKeysOverride(extra = {}) {
  const base = {};
  for (const key of Object.keys(DEFAULTS)) {
    base[key] = "";
  }
  return { ...base, ...extra };
}

async function readTreeText(root) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const chunks = [];
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      chunks.push(await readTreeText(absolute));
    } else {
      chunks.push(await readFile(absolute, "utf8"));
    }
  }
  return chunks.join("\n");
}

function execCli(args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cliPath, ...args], { cwd: repoRoot, ...options }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

test("DEFAULTS contains the required configuration fields (all null)", async () => {
  const required = [
    "POLYPULSE_EXECUTION_MODE",
    "PRIVATE_KEY",
    "FUNDER_ADDRESS",
    "SIGNATURE_TYPE",
    "CHAIN_ID",
    "POLYMARKET_HOST",
    "STATE_DIR",
    "ARTIFACT_DIR",
    "MAX_TRADE_PCT",
    "MAX_TOTAL_EXPOSURE_PCT",
    "MAX_EVENT_EXPOSURE_PCT",
    "MIN_TRADE_USD",
    "MARKET_SCAN_LIMIT",
    "PULSE_STRATEGY",
    "PULSE_MIN_LIQUIDITY_USD",
    "PULSE_MAX_CANDIDATES",
    "PULSE_REPORT_CANDIDATES",
    "PULSE_BATCH_CAP_PCT",
    "PULSE_FETCH_DIMENSIONS",
    "PULSE_REQUIRE_EVIDENCE_GUARD",
    "MONITOR_INTERVAL_SECONDS",
    "MONITOR_MAX_TRADES_PER_ROUND",
    "MONITOR_MAX_DAILY_TRADE_USD",
    "MONITOR_MAX_AMOUNT_USD",
    "MONITOR_CONCURRENCY",
    "MONITOR_RUN_TIMEOUT_MS",
    "MONITOR_BACKOFF_MS",
    "MONITOR_WATCHLIST",
    "MONITOR_BLOCKLIST",
    "ARTIFACT_RETENTION_DAYS",
    "ARTIFACT_MAX_RUNS",
    "AI_PROVIDER",
    "AI_MODEL",
    "PROVIDER_TIMEOUT_SECONDS",
    "CODEX_MODEL",
    "CODEX_SKILL_ROOT_DIR",
    "CODEX_SKILL_LOCALE",
    "CODEX_SKILLS"
  ];

  for (const key of required) {
    assert.ok(Object.hasOwn(DEFAULTS, key), `${key} missing from DEFAULTS in src/config/env.js`);
  }
  for (const value of Object.values(DEFAULTS)) {
    assert.equal(value, null, "All DEFAULTS values must be null (no defaults allowed)");
  }
});

test("live preflight fails when PRIVATE_KEY is missing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "polypulse-live-"));
  const envPath = path.join(dir, "live.env");
  await writeFile(envPath, "POLYPULSE_EXECUTION_MODE=live\n", "utf8");
  const config = await loadEnvConfig({
    envFile: envPath,
    skipValidation: true,
    overrides: allKeysOverride({
      POLYPULSE_EXECUTION_MODE: "live",
      PRIVATE_KEY: "",
      FUNDER_ADDRESS: "0x1111111111111111111111111111111111111111",
      SIGNATURE_TYPE: "1",
      CHAIN_ID: "137",
      POLYMARKET_HOST: "https://clob.polymarket.com",
      MONITOR_LOG_PATH: "logs/test.log",
      STATE_DIR: dir,
      ARTIFACT_DIR: dir
    })
  });
  const report = validateEnvConfig(config, { mode: "live" });
  assert.equal(report.ok, false);
  assert.ok(report.checks.some((item) => item.key === "PRIVATE_KEY" && !item.ok));
});

test("paper mode passes preflight with real wallet credentials", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "polypulse-paper-"));
  const config = await loadEnvConfig({
    envFile: "/tmp/polypulse-paper.env",
    skipValidation: true,
    overrides: allKeysOverride({
      POLYPULSE_EXECUTION_MODE: "paper",
      PRIVATE_KEY: "0xdeadbeef",
      FUNDER_ADDRESS: "0x1111111111111111111111111111111111111111",
      SIGNATURE_TYPE: "EOA",
      CHAIN_ID: "137",
      POLYMARKET_HOST: "https://clob.polymarket.com",
      POLYMARKET_GAMMA_HOST: "https://gamma-api.polymarket.com",
      POLYPULSE_MARKET_SOURCE: "polymarket",
      MONITOR_LOG_PATH: "logs/test.log",
      STATE_DIR: dir,
      ARTIFACT_DIR: dir,
      AI_PROVIDER: "codex",
      MAX_TRADE_PCT: "0.05",
      MAX_TOTAL_EXPOSURE_PCT: "0.5",
      MAX_EVENT_EXPOSURE_PCT: "0.2",
      MAX_POSITION_LOSS_PCT: "0.5",
      DRAWDOWN_HALT_PCT: "0.2",
      LIQUIDITY_TRADE_CAP_PCT: "0.01",
      PULSE_STRATEGY: "pulse-direct",
      PULSE_BATCH_CAP_PCT: "0.2"
    })
  });
  const report = validateEnvConfig(config, { mode: "live" });
  assert.equal(report.ok, true);
  assert.equal(report.executionMode, "paper");
});

test("private key value is excluded from stdout, artifacts, and memory", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "polypulse-secret-scan-"));
  const artifactDir = path.join(dir, "artifacts");
  const stateDir = path.join(dir, "state");
  const secret = ["stage10", "private", "redaction", "value"].join("-");
  const envPath = path.join(dir, "live.env");
  const keyName = "PRIVATE" + "_KEY";

  const lines = [];
  for (const key of Object.keys(DEFAULTS)) {
    if (key === "PRIVATE_KEY") {
      lines.push(`${keyName}=${secret}`);
    } else if (key === "STATE_DIR") {
      lines.push(`STATE_DIR=${stateDir}`);
    } else if (key === "ARTIFACT_DIR") {
      lines.push(`ARTIFACT_DIR=${artifactDir}`);
    } else if (key === "FUNDER_ADDRESS") {
      lines.push("FUNDER_ADDRESS=0x1111111111111111111111111111111111111111");
    } else if (key === "SIGNATURE_TYPE") {
      lines.push("SIGNATURE_TYPE=1");
    } else if (key === "CHAIN_ID") {
      lines.push("CHAIN_ID=137");
    } else if (key === "POLYMARKET_HOST") {
      lines.push("POLYMARKET_HOST=https://clob.polymarket.com");
    } else if (key === "POLYPULSE_MARKET_SOURCE") {
      lines.push("POLYPULSE_MARKET_SOURCE=polymarket");
    } else {
      lines.push(`${key}=`);
    }
  }
  await writeFile(envPath, lines.join("\n") + "\n", "utf8");

  const result = await execCli(["env", "check", "--env-file", envPath]);
  const artifacts = await readTreeText(artifactDir);
  const memory = await readFile(path.join(repoRoot, "docs", "memory", "POLYPULSE_MEMORY.md"), "utf8");

  assert.equal(result.stdout.includes(secret), false);
  assert.equal(result.stderr.includes(secret), false);
  assert.equal(artifacts.includes(secret), false);
  assert.equal(memory.includes(secret), false);
});
