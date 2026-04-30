import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeProbabilityProvider, claudeRuntimeInternals } from "../src/runtime/claude-runtime.js";
import { resolveClaudeSkillSettings } from "../src/runtime/claude-skill-settings.js";
import { ProbabilityEstimator } from "../src/core/probability-estimator.js";
import { loadEnvConfig } from "../src/config/env.js";
import { SAMPLE_MARKETS } from "../src/adapters/mock-market-source.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function evidence(overrides = {}) {
  const timestamp = new Date().toISOString();
  return {
    evidenceId: overrides.evidenceId ?? "evidence-1",
    marketId: SAMPLE_MARKETS[0].marketId,
    source: "mock",
    sourceUrl: "polypulse://mock/source",
    url: "polypulse://mock/source",
    title: "Official source",
    summary: "Official source confirms the condition remains plausible.",
    status: "fetched",
    credibility: "high",
    retrievedAt: timestamp,
    timestamp,
    relevanceScore: 0.9,
    relevance_score: 0.9
  };
}

async function claudeConfig(overrides = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "polypulse-claude-test-"));
  return {
    repoRoot,
    artifactDir: path.join(dir, "artifacts"),
    providerTimeoutSeconds: 5,
    ai: { provider: "claude-code", model: "", command: "" },
    agentRuntimeProvider: "claude-code",
    providers: {
      claudeCode: {
        command: "",
        model: "sonnet",
        skillRootDir: path.join(repoRoot, "skills"),
        skillLocale: "zh",
        skills: "polypulse-market-agent",
        permissionMode: "bypassPermissions",
        allowedTools: "Read,Glob,Grep",
        extraArgs: "",
        maxBudgetUsd: ""
      }
    },
    ...overrides
  };
}

function fakeClaudeSpawn(calls, payload) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    process.nextTick(() => {
      const envelope = JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: JSON.stringify(payload)
      });
      child.stdout.write(envelope);
      child.stdout.end();
      child.emit("close", 0);
    });
    return child;
  };
}

test("ClaudeProbabilityProvider invokes claude --print with read-only flags", async () => {
  const calls = [];
  const provider = new ClaudeProbabilityProvider(await claudeConfig(), {
    spawnImpl: fakeClaudeSpawn(calls, {
      ai_probability: 0.62,
      confidence: "medium",
      reasoning_summary: "Claude fake output for schema test.",
      key_evidence: [evidence({ evidenceId: "e1" })],
      counter_evidence: [],
      uncertainty_factors: [],
      freshness_score: 0.85
    })
  });
  const result = await provider.estimate({
    market: SAMPLE_MARKETS[0],
    evidence: [evidence({ evidenceId: "e1" })]
  });

  assert.equal(result.ai_probability, 0.62);
  assert.equal(result.diagnostics.provider, "claude-code");
  assert.equal(result.diagnostics.runtime, "claude-code-skill-runtime");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "claude");
  assert.ok(calls[0].args.includes("--print"));
  assert.ok(calls[0].args.includes("--bare"));
  assert.ok(calls[0].args.includes("--permission-mode"));
  assert.ok(calls[0].args.includes("bypassPermissions"));
  assert.ok(calls[0].args.includes("--allowedTools"));
  assert.ok(calls[0].args.includes("Read,Glob,Grep"));
  assert.ok(calls[0].args.includes("--add-dir"));
  assert.ok(calls[0].args.includes("--model"));
  assert.ok(calls[0].args.includes("sonnet"));
});

test("Claude runtime unwraps --output-format json envelope", () => {
  const wrapper = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: '{"ai_probability":0.55}'
  });
  const unwrapped = claudeRuntimeInternals.unwrapClaudePrintEnvelope(wrapper);
  assert.equal(unwrapped, '{"ai_probability":0.55}');
});

test("Claude runtime keeps raw text when output is not envelope JSON", () => {
  const raw = '{"ai_probability":0.42,"confidence":"low"}';
  const unwrapped = claudeRuntimeInternals.unwrapClaudePrintEnvelope(raw);
  assert.equal(unwrapped, raw);
});

test("Claude runtime accepts envelope with structured result object", () => {
  const wrapper = JSON.stringify({
    type: "result",
    result: { ai_probability: 0.33, confidence: "low" }
  });
  const unwrapped = claudeRuntimeInternals.unwrapClaudePrintEnvelope(wrapper);
  assert.equal(unwrapped, '{"ai_probability":0.33,"confidence":"low"}');
});

test("AGENT_RUNTIME_PROVIDER=claude-code selects ClaudeProbabilityProvider", async () => {
  const config = await loadEnvConfig({
    repoRoot,
    overrides: {
      AGENT_RUNTIME_PROVIDER: "claude-code",
      CLAUDE_CODE_SKILL_ROOT_DIR: "skills",
      ARTIFACT_DIR: path.join(tmpdir(), "polypulse-claude-artifacts")
    }
  });
  const estimator = new ProbabilityEstimator(config);
  assert.equal(estimator.provider instanceof ClaudeProbabilityProvider, true);
});

test("AI_PROVIDER=codex still routes to Codex (no regression)", async () => {
  const { CodexProbabilityProvider } = await import("../src/runtime/codex-runtime.js");
  const config = await loadEnvConfig({
    repoRoot,
    overrides: {
      AGENT_RUNTIME_PROVIDER: "codex",
      CODEX_SKILL_ROOT_DIR: "skills",
      ARTIFACT_DIR: path.join(tmpdir(), "polypulse-codex-noregression")
    }
  });
  const estimator = new ProbabilityEstimator(config);
  assert.equal(estimator.provider instanceof CodexProbabilityProvider, true);
});

test("ClaudeProbabilityProvider can run CLAUDE_CODE_COMMAND template", async () => {
  const config = await claudeConfig({
    providers: {
      claudeCode: {
        command: "node -e \"require('fs').writeFileSync('{{output_file}}', JSON.stringify({ai_probability:0.41,confidence:'low',reasoning_summary:'template ok',key_evidence:[],counter_evidence:[],uncertainty_factors:['insufficient_evidence'],freshness_score:0.4}))\"",
        model: "",
        skillRootDir: path.join(repoRoot, "skills"),
        skillLocale: "zh",
        skills: "polypulse-market-agent",
        permissionMode: "bypassPermissions",
        allowedTools: "Read,Glob,Grep",
        extraArgs: "",
        maxBudgetUsd: ""
      }
    }
  });
  const provider = new ClaudeProbabilityProvider(config);
  const result = await provider.estimate({
    market: SAMPLE_MARKETS[0],
    evidence: [evidence({ evidenceId: "e1" })]
  });
  assert.equal(result.ai_probability, 0.41);
  assert.equal(result.uncertainty_factors[0], "insufficient_evidence");
  const logPath = path.resolve(result.diagnostics.artifact);
  const logBody = await readFile(logPath, "utf8");
  assert.match(logBody, /Claude Code/);
});

test("resolveClaudeSkillSettings parses tool list and extra args", async () => {
  const config = await loadEnvConfig({
    repoRoot,
    overrides: {
      AGENT_RUNTIME_PROVIDER: "claude-code",
      CLAUDE_CODE_SKILL_ROOT_DIR: "skills",
      CLAUDE_CODE_ALLOWED_TOOLS: "Read Glob",
      CLAUDE_CODE_EXTRA_ARGS: "--effort medium --append-system-prompt 'be terse'"
    }
  });
  const settings = resolveClaudeSkillSettings(config);
  assert.deepEqual(settings.allowedTools, ["Read", "Glob"]);
  assert.deepEqual(settings.extraArgs, [
    "--effort",
    "medium",
    "--append-system-prompt",
    "be terse"
  ]);
});

test("ClaudeProbabilityProvider passes extra args and budget to claude CLI", async () => {
  const calls = [];
  const config = await claudeConfig({
    providers: {
      claudeCode: {
        command: "",
        model: "opus",
        skillRootDir: path.join(repoRoot, "skills"),
        skillLocale: "zh",
        skills: "polypulse-market-agent",
        permissionMode: "plan",
        allowedTools: "Read",
        extraArgs: "--effort high",
        maxBudgetUsd: "0.5"
      }
    }
  });
  const provider = new ClaudeProbabilityProvider(config, {
    spawnImpl: fakeClaudeSpawn(calls, {
      ai_probability: 0.5,
      confidence: "medium",
      reasoning_summary: "ok",
      key_evidence: [],
      counter_evidence: [],
      uncertainty_factors: [],
      freshness_score: 0.5
    })
  });
  await provider.estimate({
    market: SAMPLE_MARKETS[0],
    evidence: [evidence({ evidenceId: "e1" })]
  });
  const args = calls[0].args;
  assert.ok(args.includes("--max-budget-usd"));
  assert.ok(args.includes("0.5"));
  assert.ok(args.includes("--effort"));
  assert.ok(args.includes("high"));
  assert.ok(args.includes("plan"));
});
