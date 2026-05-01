import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { redactSecrets } from "../config/env.js";
import {
  combineTextMetrics,
  formatTextMetrics,
  measureText,
  readTextMetrics
} from "./text-metrics.js";
import { resolveClaudeSkillSettings } from "./claude-skill-settings.js";
import { codexRuntimeInternals } from "./codex-runtime.js";

const RUNTIME_HEARTBEAT_INTERVAL_MS = 5000;
const { buildProbabilityEstimateSchema, buildPrompt, extractJsonPayload } = codexRuntimeInternals;

function timestampId(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function isChineseLocale(locale) {
  return locale === "zh";
}

function truncate(text, maxChars = 24000) {
  const value = String(text ?? "");
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 24))}\n\n... truncated ...\n`;
}

function readOutputSizeBytes(outputPath) {
  if (!outputPath || !existsSync(outputPath)) {
    return 0;
  }
  try {
    return statSync(outputPath).size;
  } catch {
    return 0;
  }
}

function formatRemainingTimeoutMs(startedAt, timeoutMs) {
  if (timeoutMs == null) {
    return "disabled";
  }
  const remainingMs = Math.max(0, timeoutMs - (Date.now() - startedAt));
  return `${Math.ceil(remainingMs / 1000)}s`;
}

function buildRuntimeHeartbeatDetail(input) {
  return [
    `stage ${input.stage}`,
    input.providerDetail,
    `elapsed ${Math.round((Date.now() - input.startedAt) / 1000)}s`,
    `temp ${input.tempDir}`,
    `output ${input.outputPath}`,
    `output bytes ${readOutputSizeBytes(input.outputPath)}`,
    `timeout remaining ${formatRemainingTimeoutMs(input.startedAt, input.timeoutMs)}`
  ].join(" | ");
}

function buildClaudeArgs({ settings, repoRoot, schemaPath }) {
  const args = [
    "--print",
    "--output-format", "json",
    "--input-format", "text",
    "--bare",
    "--permission-mode", settings.permissionMode,
    "--add-dir", repoRoot
  ];

  if (settings.allowedTools.length > 0) {
    args.push("--allowedTools", settings.allowedTools.join(","));
  }

  if (settings.model) {
    args.push("--model", settings.model);
  }

  if (settings.maxBudgetUsd != null) {
    args.push("--max-budget-usd", String(settings.maxBudgetUsd));
  }

  const skillRootOutsideRepo = settings.skillRootDir !== repoRoot
    && !settings.skillRootDir.startsWith(`${repoRoot}${path.sep}`);
  if (skillRootOutsideRepo) {
    args.push("--add-dir", settings.skillRootDir);
  }

  if (schemaPath && existsSync(schemaPath)) {
    args.push("--json-schema", schemaPath);
  }

  if (Array.isArray(settings.extraArgs) && settings.extraArgs.length > 0) {
    args.push(...settings.extraArgs);
  }

  return args;
}

function unwrapClaudePrintEnvelope(rawOutput) {
  const trimmed = String(rawOutput ?? "").trim();
  if (!trimmed) {
    return "";
  }
  try {
    const envelope = JSON.parse(trimmed);
    if (envelope && typeof envelope === "object") {
      if (typeof envelope.result === "string") {
        return envelope.result;
      }
      if (envelope.result && typeof envelope.result === "object") {
        return JSON.stringify(envelope.result);
      }
      if (typeof envelope.response === "string") {
        return envelope.response;
      }
      if (envelope.response && typeof envelope.response === "object") {
        return JSON.stringify(envelope.response);
      }
    }
  } catch {
    // Not envelope JSON, fall through.
  }
  return trimmed;
}

async function runClaude({
  prompt,
  settings,
  repoRoot,
  tempDir,
  outputPath,
  schemaPath,
  timeoutMs
}) {
  const effectiveTimeoutMs = timeoutMs > 0 ? timeoutMs : null;
  const args = buildClaudeArgs({ settings, repoRoot, schemaPath });

  await new Promise((resolve, reject) => {
    const child = spawn("claude", args, {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const startedAt = Date.now();
    const heartbeat = setInterval(() => {}, RUNTIME_HEARTBEAT_INTERVAL_MS);
    const timeout = effectiveTimeoutMs == null
      ? null
      : setTimeout(() => {
        clearInterval(heartbeat);
        child.kill?.("SIGTERM");
        reject(new Error(
          `claude print timed out after ${effectiveTimeoutMs}ms\n` +
          `${buildRuntimeHeartbeatDetail({
            stage: "Probability runtime is running",
            providerDetail: `${settings.provider} provider`,
            startedAt,
            timeoutMs: effectiveTimeoutMs,
            tempDir,
            outputPath
          })}`
        ));
      }, effectiveTimeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearInterval(heartbeat);
      if (timeout) clearTimeout(timeout);
      reject(new Error(
        `${error.message}\n` +
        `${buildRuntimeHeartbeatDetail({
          stage: "Probability runtime is running",
          providerDetail: `${settings.provider} provider`,
          startedAt,
          timeoutMs: effectiveTimeoutMs,
          tempDir,
          outputPath
        })}`,
        { cause: error }
      ));
    });
    child.on("close", async (code) => {
      clearInterval(heartbeat);
      if (timeout) clearTimeout(timeout);
      if (code === 0) {
        try {
          const payload = unwrapClaudePrintEnvelope(stdout);
          await writeFile(outputPath, payload, "utf8");
          resolve();
        } catch (error) {
          reject(error);
        }
        return;
      }
      reject(new Error(
        `${stderr || `claude print exited with code ${code}`}\n` +
        `${buildRuntimeHeartbeatDetail({
          stage: "Probability runtime is running",
          providerDetail: `${settings.provider} provider`,
          startedAt,
          timeoutMs: effectiveTimeoutMs,
          tempDir,
          outputPath
        })}`
      ));
    });
    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}

async function archiveRuntimeLog({ config, settings, rawOutput, promptMetrics, schemaMetrics, inputMetrics, tempDir, outputPath }) {
  const artifactDir = path.join(config.artifactDir, "claude-code-runtime", timestampId());
  await mkdir(artifactDir, { recursive: true });
  const logPath = path.join(artifactDir, "runtime-log.md");
  const zh = isChineseLocale(settings.locale);
  const content = truncate([
    zh ? "# Claude Code 概率运行时日志" : "# Claude Code Probability Runtime Log",
    "",
    zh ? `Provider：${settings.provider}` : `Provider: ${settings.provider}`,
    zh ? `Locale：${settings.locale}` : `Locale: ${settings.locale}`,
    zh ? `Model：${settings.model || "default"}` : `Model: ${settings.model || "default"}`,
    zh ? `Permission：${settings.permissionMode}` : `Permission: ${settings.permissionMode}`,
    zh ? `Allowed tools：${settings.allowedTools.join(",") || "default"}` : `Allowed tools: ${settings.allowedTools.join(",") || "default"}`,
    zh ? `Skills：${settings.skills.map((skill) => skill.id).join(", ")}` : `Skills: ${settings.skills.map((skill) => skill.id).join(", ")}`,
    zh ? `Temp：${tempDir}` : `Temp: ${tempDir}`,
    zh ? `Output：${outputPath}` : `Output: ${outputPath}`,
    zh ? `Prompt：${formatTextMetrics(promptMetrics)}` : `Prompt: ${formatTextMetrics(promptMetrics)}`,
    zh ? `Schema：${formatTextMetrics(schemaMetrics)}` : `Schema: ${formatTextMetrics(schemaMetrics)}`,
    zh ? `Inputs：${formatTextMetrics(inputMetrics)}` : `Inputs: ${formatTextMetrics(inputMetrics)}`,
    "",
    zh ? "## Provider 原始输出" : "## Raw Provider Output",
    "",
    "```json",
    rawOutput.trim(),
    "```"
  ].join("\n"), config.pulse?.maxMarkdownChars ?? 24000);
  await writeFile(logPath, content, "utf8");
  return {
    kind: "claude-code-runtime-log",
    path: path.relative(process.cwd(), logPath),
    publishedAt: new Date().toISOString()
  };
}

export class ClaudeProbabilityProvider {
  constructor(config = {}) {
    this.config = config;
  }

  async estimate({ market, evidence }) {
    const settings = resolveClaudeSkillSettings(this.config);
    const repoRoot = path.resolve(this.config.repoRoot ?? process.cwd());
    const riskDocPath = path.resolve(repoRoot, "docs", "specs", "risk-controls.md");
    const tempDir = await mkdtemp(path.join(tmpdir(), "polypulse-claude-"));
    const outputPath = path.join(tempDir, "provider-output.json");
    const promptPath = path.join(tempDir, "provider-prompt.txt");
    const schemaPath = path.join(tempDir, "probability-estimate.schema.json");
    const marketPath = path.join(tempDir, "market.json");
    const evidencePath = path.join(tempDir, "evidence.json");
    const timeoutMs = (this.config.providerTimeoutSeconds ?? 0) * 1000;
    const effectiveTimeoutMs = timeoutMs > 0 ? timeoutMs : null;
    const runtimeStartedAt = Date.now();
    let preserveTempDir = false;

    try {
      await writeFile(marketPath, JSON.stringify(redactSecrets(market), null, 2), "utf8");
      await writeFile(evidencePath, JSON.stringify(redactSecrets(evidence), null, 2), "utf8");
      const prompt = buildPrompt({ market, evidence, settings, riskDocPath, marketPath, evidencePath });
      const schemaContent = JSON.stringify(buildProbabilityEstimateSchema(), null, 2);
      await writeFile(promptPath, prompt, "utf8");
      await writeFile(schemaPath, schemaContent, "utf8");

      const [
        marketMetrics,
        evidenceMetrics,
        riskDocMetrics,
        ...skillMetrics
      ] = await Promise.all([
        readTextMetrics(marketPath),
        readTextMetrics(evidencePath),
        existsSync(riskDocPath) ? readTextMetrics(riskDocPath) : Promise.resolve(measureText("")),
        ...settings.skills.map((skill) => readTextMetrics(skill.skillFile))
      ]);
      const promptMetrics = measureText(prompt);
      const schemaMetrics = measureText(schemaContent);
      const inputMetrics = combineTextMetrics([marketMetrics, evidenceMetrics, riskDocMetrics, ...skillMetrics]);

      await runClaude({
        prompt,
        settings,
        repoRoot,
        tempDir,
        outputPath,
        schemaPath,
        timeoutMs
      });

      const rawOutput = await readFile(outputPath, "utf8");
      const parsed = extractJsonPayload(rawOutput);
      const runtimeLog = await archiveRuntimeLog({
        config: this.config,
        settings,
        rawOutput,
        promptMetrics,
        schemaMetrics,
        inputMetrics,
        tempDir,
        outputPath
      });
      return {
        ...parsed,
        diagnostics: {
          ...(parsed.diagnostics ?? {}),
          provider: "claude-code",
          runtime: "claude-code-skill-runtime",
          model: settings.model || "default",
          artifact: runtimeLog.path,
          outputMetrics: measureText(rawOutput)
        }
      };
    } catch (error) {
      preserveTempDir = true;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${message}\n` +
        `${buildRuntimeHeartbeatDetail({
          stage: "Probability runtime failure",
          providerDetail: `${settings.provider} provider`,
          startedAt: runtimeStartedAt,
          timeoutMs: effectiveTimeoutMs,
          tempDir,
          outputPath
        })}\n\nProbability runtime temp preserved at ${tempDir}`,
        { cause: error }
      );
    } finally {
      if (!preserveTempDir) {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  }
}

export const claudeRuntimeInternals = {
  buildClaudeArgs,
  unwrapClaudePrintEnvelope,
  runClaude
};
