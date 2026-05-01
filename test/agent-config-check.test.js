import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "scripts", "check-agent-config.js");
const agentEnvKeys = [
  "AI_PROVIDER",
  "AGENT_RUNTIME_PROVIDER",
  "CODEX_MODEL",
  "CODEX_SKILL_ROOT_DIR",
  "CODEX_SKILLS",
  "PROVIDER_TIMEOUT_SECONDS"
];

function childEnv() {
  const env = { ...process.env };
  for (const key of agentEnvKeys) {
    delete env[key];
  }
  return env;
}

function runAgentCheck(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [scriptPath, ...args], { cwd: repoRoot, env: childEnv() }, (error, stdout, stderr) => {
      resolve({ error, stdout, stderr, status: error?.code ?? 0 });
    });
  });
}

test("agent config check passes for the real codex CLI path", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "polypulse-agent-config-"));
  const envPath = path.join(dir, "codex.env");
  await writeFile(envPath, [
    "AI_PROVIDER=codex",
    "AGENT_RUNTIME_PROVIDER=codex",
    "PROVIDER_TIMEOUT_SECONDS=60",
    "CODEX_SKILL_ROOT_DIR=skills",
    "CODEX_SKILLS=polypulse-market-agent"
  ].join("\n"), "utf8");

  const result = await runAgentCheck(["--env-file", envPath, "--expect", "codex"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.effectiveProvider, "codex");
  assert.equal(output.codex.commandMode, "codex-cli");
  assert.equal(output.codex.skills[0].id, "polypulse-market-agent");
});

test("agent config check fails when codex is expected but claude-code is selected", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "polypulse-agent-config-"));
  const envPath = path.join(dir, "claude.env");
  await writeFile(envPath, [
    "AI_PROVIDER=claude-code",
    "AGENT_RUNTIME_PROVIDER=claude-code"
  ].join("\n"), "utf8");

  const result = await runAgentCheck(["--env-file", envPath, "--expect", "codex"]);
  assert.notEqual(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.effectiveProvider, "claude-code");
  assert.ok(output.checks.some((item) => item.key === "expected-provider" && !item.ok));
});
