import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvConfig, parseEnvContent, validateEnvConfig } from "../src/config/env.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "bin", "polypulse.js");

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

test(".env.example contains the required configuration fields", async () => {
  const env = parseEnvContent(await readFile(path.join(repoRoot, ".env.example"), "utf8"));
  const required = [
    "POLYPULSE_EXECUTION_MODE",
    "POLYPULSE_LIVE_WALLET_MODE",
    "SIMULATED_WALLET_ADDRESS",
    "SIMULATED_WALLET_BALANCE_USD",
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
    "MONITOR_CONCURRENCY",
    "MONITOR_RUN_TIMEOUT_MS",
    "MONITOR_BACKOFF_MS",
    "MONITOR_WATCHLIST",
    "MONITOR_BLOCKLIST",
    "ARTIFACT_RETENTION_DAYS",
    "ARTIFACT_MAX_RUNS",
    "AI_PROVIDER",
    "AI_MODEL",
    "AI_COMMAND",
    "AGENT_RUNTIME_PROVIDER",
    "PROVIDER_TIMEOUT_SECONDS",
    "CODEX_COMMAND",
    "CODEX_MODEL",
    "CODEX_SKILL_ROOT_DIR",
    "CODEX_SKILL_LOCALE",
    "CODEX_SKILLS"
  ];

  for (const key of required) {
    assert.ok(Object.hasOwn(env, key), `${key} missing from .env.example`);
  }
  assert.equal(env.PRIVATE_KEY, "");
});

test("live preflight fails when PRIVATE_KEY is missing", async () => {
  const config = await loadEnvConfig({
    overrides: {
      POLYPULSE_EXECUTION_MODE: "live",
      PRIVATE_KEY: "",
      FUNDER_ADDRESS: "0x1111111111111111111111111111111111111111",
      SIGNATURE_TYPE: "1",
      POLYMARKET_HOST: "https://clob.polymarket.com"
    }
  });
  const report = validateEnvConfig(config, { mode: "live" });
  assert.equal(report.ok, false);
  assert.ok(report.checks.some((item) => item.key === "PRIVATE_KEY" && !item.ok));
});

test("live preflight allows simulated wallet without a private key", async () => {
  const config = await loadEnvConfig({
    envFile: "/tmp/polypulse-simulated-live.env",
    overrides: {
      POLYPULSE_EXECUTION_MODE: "live",
      POLYPULSE_LIVE_WALLET_MODE: "simulated",
      PRIVATE_KEY: "",
      FUNDER_ADDRESS: "",
      SIGNATURE_TYPE: "",
      CHAIN_ID: "137",
      POLYMARKET_HOST: "",
      SIMULATED_WALLET_BALANCE_USD: "100"
    }
  });
  const report = validateEnvConfig(config, { mode: "live" });
  assert.equal(report.ok, true);
  assert.equal(report.liveWalletMode, "simulated");
});

test("private key value is excluded from stdout, artifacts, and memory", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "polypulse-secret-scan-"));
  const artifactDir = path.join(dir, "artifacts");
  const stateDir = path.join(dir, "state");
  const secret = ["stage10", "fake", "private", "value"].join("-");
  const envPath = path.join(dir, "live.env");
  const keyName = "PRIVATE" + "_KEY";
  await writeFile(envPath, [
    "POLYPULSE_EXECUTION_MODE=live",
    `${keyName}=${secret}`,
    "FUNDER_ADDRESS=0x1111111111111111111111111111111111111111",
    "SIGNATURE_TYPE=1",
    "CHAIN_ID=137",
    "POLYMARKET_HOST=https://clob.polymarket.com",
    "POLYPULSE_MARKET_SOURCE=mock",
    `STATE_DIR=${stateDir}`,
    `ARTIFACT_DIR=${artifactDir}`
  ].join("\n"), "utf8");

  const result = await execCli(["env", "check", "--mode", "live", "--env-file", envPath]);
  const artifacts = await readTreeText(artifactDir);
  const memory = await readFile(path.join(repoRoot, "docs", "memory", "POLYPULSE_MEMORY.md"), "utf8");

  assert.equal(result.stdout.includes(secret), false);
  assert.equal(result.stderr.includes(secret), false);
  assert.equal(artifacts.includes(secret), false);
  assert.equal(memory.includes(secret), false);
});
