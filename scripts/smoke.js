#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0) {
    return fallback;
  }
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : fallback;
}

function commandName(args) {
  return args.map((item) => item.replace(/[^a-zA-Z0-9_.-]+/g, "_")).join("-");
}

const envFile = option(process.argv.slice(2), "--env-file", ".env");
const runId = timestamp();
const artifactDir = path.resolve("runtime-artifacts", "test-runs", `${runId}-smoke`);
mkdirSync(artifactDir, { recursive: true });

const results = [];

function run(args) {
  const fullArgs = ["./bin/polypulse.js", ...args];
  const result = spawnSync(process.execPath, fullArgs, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env
  });
  const name = commandName(args);
  writeFileSync(path.join(artifactDir, `${name}.stdout.log`), result.stdout ?? "", "utf8");
  writeFileSync(path.join(artifactDir, `${name}.stderr.log`), result.stderr ?? "", "utf8");
  const entry = { command: `polypulse ${args.join(" ")}`, ok: result.status === 0, status: result.status };
  results.push(entry);
  if (result.status !== 0) {
    throw new Error(`smoke_command_failed: ${entry.command}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

let failed = false;
let skippedLiveExecution = false;
try {
  const envCheck = run(["env", "check", "--env-file", envFile]);
  run(["account", "balance", "--env-file", envFile]);
  run(["account", "audit", "--env-file", envFile]);
  const topics = run(["market", "topics", "--env-file", envFile, "--limit", "20", "--quick"]);
  const market = topics?.topics?.[0];
  const marketId = market?.marketId ?? market?.marketSlug;
  if (!marketId) {
    throw new Error("smoke_no_polymarket_topic_returned");
  }
  run(["predict", "--env-file", envFile, "--market", marketId]);
  run(["monitor", "status", "--env-file", envFile]);
  if (envCheck?.report?.liveWalletMode === "simulated") {
    run(["trade", "once", "--env-file", envFile, "--market", marketId, "--max-amount", "1", "--confirm", "LIVE"]);
    run(["monitor", "run", "--env-file", envFile, "--rounds", "1", "--limit", "1", "--max-amount", "1", "--confirm", "LIVE"]);
  } else {
    skippedLiveExecution = true;
  }
} catch (error) {
  failed = true;
  results.push({ command: "smoke", ok: false, status: 1, error: error instanceof Error ? error.message : String(error) });
}

const summary = {
  ok: !failed,
  commands: results.length,
  pass: results.filter((item) => item.ok).length,
  fail: results.filter((item) => !item.ok).length,
  skippedLiveExecution,
  artifactDir: path.relative(process.cwd(), artifactDir)
};
writeFileSync(path.join(artifactDir, "summary.json"), `${JSON.stringify({ ...summary, results }, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  ok: summary.ok,
  commands: summary.commands,
  pass: summary.pass,
  fail: summary.fail,
  skippedLiveExecution,
  artifact: summary.ok ? undefined : summary.artifactDir
}));

if (failed) {
  process.exit(1);
}
