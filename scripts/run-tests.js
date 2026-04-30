#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function parseCount(output, label) {
  const match = output.match(new RegExp(`\\b${label}\\s+(\\d+)\\b`));
  return match ? Number(match[1]) : null;
}

const startedAt = new Date();
const runId = timestamp();
const artifactDir = path.resolve("runtime-artifacts", "test-runs", runId);
mkdirSync(artifactDir, { recursive: true });

const args = ["--test", ...process.argv.slice(2)];
const result = spawnSync(process.execPath, args, {
  cwd: process.cwd(),
  encoding: "utf8",
  env: process.env
});

const completedAt = new Date();
const stdout = result.stdout ?? "";
const stderr = result.stderr ?? "";
const combined = `${stdout}\n${stderr}`;
const summary = {
  ok: result.status === 0,
  command: `${path.basename(process.execPath)} ${args.join(" ")}`,
  status: result.status,
  signal: result.signal,
  startedAt: startedAt.toISOString(),
  completedAt: completedAt.toISOString(),
  durationMs: completedAt.getTime() - startedAt.getTime(),
  tests: parseCount(combined, "tests"),
  pass: parseCount(combined, "pass"),
  fail: parseCount(combined, "fail"),
  artifactDir: path.relative(process.cwd(), artifactDir)
};

writeFileSync(path.join(artifactDir, "command.txt"), `${process.execPath} ${args.join(" ")}\n`, "utf8");
writeFileSync(path.join(artifactDir, "stdout.log"), stdout, "utf8");
writeFileSync(path.join(artifactDir, "stderr.log"), stderr, "utf8");
writeFileSync(path.join(artifactDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  ok: summary.ok,
  tests: summary.tests,
  pass: summary.pass,
  fail: summary.fail,
  durationMs: summary.durationMs,
  artifact: summary.ok ? undefined : summary.artifactDir
}));

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
