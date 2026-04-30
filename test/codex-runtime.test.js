import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexProbabilityProvider, codexRuntimeInternals } from "../src/runtime/codex-runtime.js";
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

async function codexConfig(overrides = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "polypulse-codex-test-"));
  return {
    repoRoot,
    artifactDir: path.join(dir, "artifacts"),
    providerTimeoutSeconds: 5,
    ai: { provider: "codex", model: "", command: "" },
    agentRuntimeProvider: "codex",
    providers: {
      codex: {
        command: "",
        model: "gpt-test",
        skillRootDir: path.join(repoRoot, "skills"),
        skillLocale: "zh",
        skills: "polypulse-market-agent"
      }
    },
    ...overrides
  };
}

function fakeCodexSpawn(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    process.nextTick(async () => {
      const outputPath = args[args.indexOf("-o") + 1];
      await writeFile(outputPath, JSON.stringify({
        ai_probability: 0.71,
        confidence: "high",
        reasoning_summary: "Codex fake output for schema test.",
        key_evidence: [evidence({ evidenceId: "e1" })],
        counter_evidence: [],
        uncertainty_factors: [],
        freshness_score: 1
      }), "utf8");
      child.emit("close", 0);
    });
    return child;
  };
}

test("CodexProbabilityProvider mirrors Predict-Raven codex exec flags", async () => {
  const calls = [];
  const provider = new CodexProbabilityProvider(await codexConfig(), {
    spawnImpl: fakeCodexSpawn(calls)
  });
  const result = await provider.estimate({
    market: SAMPLE_MARKETS[0],
    evidence: [evidence({ evidenceId: "e1" })]
  });

  assert.equal(result.ai_probability, 0.71);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "codex");
  assert.deepEqual(calls[0].args.slice(0, 8), [
    "exec",
    "--skip-git-repo-check",
    "-C",
    repoRoot,
    "-s",
    "read-only",
    "--output-schema",
    calls[0].args[7]
  ]);
  assert.ok(calls[0].args.includes("-o"));
  assert.ok(calls[0].args.includes("--color"));
  assert.ok(calls[0].args.includes("never"));
  assert.ok(calls[0].args.includes("-m"));
  assert.equal(calls[0].args.at(-1), "-");
});

test("codex runtime parses wrapper JSON and normalizes source URLs", () => {
  const parsed = codexRuntimeInternals.extractJsonPayload(JSON.stringify({
    probabilityEstimate: {
      ai_probability: 0.6,
      confidence: "medium",
      reasoning_summary: "Wrapped output.",
      key_evidence: [{
        evidenceId: "e1",
        title: "Local evidence",
        summary: "Local file evidence.",
        sourceUrl: "docs/specs/risk-controls.md"
      }],
      counter_evidence: [],
      uncertainty_factors: [],
      freshness_score: 0.8
    }
  }));

  assert.equal(parsed.ai_probability, 0.6);
  assert.match(parsed.key_evidence[0].sourceUrl, /^file:\/\//);
});

test("AGENT_RUNTIME_PROVIDER=codex selects CodexProbabilityProvider", async () => {
  const config = await loadEnvConfig({
    repoRoot,
    overrides: {
      AGENT_RUNTIME_PROVIDER: "codex",
      CODEX_SKILL_ROOT_DIR: "skills",
      ARTIFACT_DIR: path.join(tmpdir(), "polypulse-codex-artifacts")
    }
  });
  const estimator = new ProbabilityEstimator(config);
  assert.equal(estimator.provider instanceof CodexProbabilityProvider, true);
});

test("CodexProbabilityProvider can run CODEX_COMMAND template", async () => {
  const config = await codexConfig({
    providers: {
      codex: {
        command: "node -e \"require('fs').writeFileSync('{{output_file}}', JSON.stringify({ai_probability:0.64,confidence:'medium',reasoning_summary:'template ok',key_evidence:[],counter_evidence:[],uncertainty_factors:['insufficient_evidence'],freshness_score:0.5}))\"",
        model: "",
        skillRootDir: path.join(repoRoot, "skills"),
        skillLocale: "zh",
        skills: "polypulse-market-agent"
      }
    }
  });
  const provider = new CodexProbabilityProvider(config);
  const result = await provider.estimate({
    market: SAMPLE_MARKETS[0],
    evidence: [evidence({ evidenceId: "e1" })]
  });
  assert.equal(result.ai_probability, 0.64);
  assert.equal(result.uncertainty_factors[0], "insufficient_evidence");
  const logPath = path.resolve(result.diagnostics.artifact);
  assert.match(await readFile(logPath, "utf8"), /Codex/);
});
