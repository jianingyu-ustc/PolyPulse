#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const commands = [
  ["env", "check", "--source", "mock"],
  ["account", "balance", "--source", "mock"],
  ["market", "topics", "--source", "mock", "--limit", "20"],
  ["predict", "--source", "mock", "--market", "market-001"],
  ["trade", "once", "--source", "mock", "--mode", "paper", "--market", "market-001", "--max-amount", "1"],
  ["monitor", "status", "--source", "mock"],
  ["monitor", "run", "--source", "mock", "--mode", "paper", "--rounds", "1", "--limit", "2", "--max-amount", "1"]
];

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

const runId = timestamp();
const artifactDir = path.resolve("runtime-artifacts", "test-runs", `${runId}-smoke`);
mkdirSync(artifactDir, { recursive: true });

const results = [];
let failed = false;
for (const args of commands) {
  const result = spawnSync(process.execPath, ["./bin/polypulse.js", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env
  });
  const name = args.join("-");
  writeFileSync(path.join(artifactDir, `${name}.stdout.log`), result.stdout ?? "", "utf8");
  writeFileSync(path.join(artifactDir, `${name}.stderr.log`), result.stderr ?? "", "utf8");
  results.push({ command: `polypulse ${args.join(" ")}`, ok: result.status === 0, status: result.status });
  if (result.status !== 0) {
    failed = true;
    break;
  }
}

const summary = {
  ok: !failed,
  commands: results.length,
  pass: results.filter((item) => item.ok).length,
  fail: results.filter((item) => !item.ok).length,
  artifactDir: path.relative(process.cwd(), artifactDir)
};
writeFileSync(path.join(artifactDir, "summary.json"), `${JSON.stringify({ ...summary, results }, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  ok: summary.ok,
  commands: summary.commands,
  pass: summary.pass,
  fail: summary.fail,
  artifact: summary.ok ? undefined : summary.artifactDir
}));

if (failed) {
  process.exit(1);
}
