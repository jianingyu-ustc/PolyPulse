#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "../src/config/env.js";
import { resolveCodexSkillSettings, resolveEffectiveProvider } from "../src/runtime/codex-skill-settings.js";
import { resolveClaudeSkillSettings } from "../src/runtime/claude-skill-settings.js";

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0) {
    return fallback;
  }
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : fallback;
}

function addCheck(checks, key, ok, summary, level = "error") {
  checks.push({ key, ok, level, summary });
}

function firstLine(value) {
  return String(value ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

function checkCodexCli() {
  const result = spawnSync("codex", ["--version"], {
    encoding: "utf8",
    timeout: 5000
  });
  return {
    checked: true,
    ok: result.status === 0,
    command: "codex",
    version: result.status === 0 ? firstLine(result.stdout || result.stderr) : "",
    error: result.status === 0 ? "" : firstLine(result.stderr || result.error?.message || "codex --version failed")
  };
}

function checkClaudeCli() {
  const result = spawnSync("claude", ["--version"], {
    encoding: "utf8",
    timeout: 5000
  });
  return {
    checked: true,
    ok: result.status === 0,
    command: "claude",
    version: result.status === 0 ? firstLine(result.stdout || result.stderr) : "",
    error: result.status === 0 ? "" : firstLine(result.stderr || result.error?.message || "claude --version failed")
  };
}

async function main(args = process.argv.slice(2)) {
  const envFile = option(args, "--env-file");
  const expectedProvider = option(args, "--expect");
  const config = await loadEnvConfig({ envFile });
  const effectiveProvider = resolveEffectiveProvider(config);
  const checks = [];

  if (envFile) {
    addCheck(
      checks,
      "env-file",
      existsSync(path.resolve(envFile)),
      `envFile=${path.resolve(envFile)}`
    );
  }
  if (expectedProvider) {
    addCheck(
      checks,
      "expected-provider",
      effectiveProvider === expectedProvider,
      `effectiveProvider=${effectiveProvider}, expected=${expectedProvider}`
    );
    if (expectedProvider === "codex") {
      addCheck(checks, "AI_PROVIDER", config.ai.provider === "codex", `AI_PROVIDER=${config.ai.provider}`);
      addCheck(
        checks,
        "AGENT_RUNTIME_PROVIDER",
        config.agentRuntimeProvider === "codex",
        `AGENT_RUNTIME_PROVIDER=${config.agentRuntimeProvider}`
      );
    }
    if (expectedProvider === "claude-code") {
      addCheck(checks, "AI_PROVIDER", config.ai.provider === "claude-code", `AI_PROVIDER=${config.ai.provider}`);
      addCheck(
        checks,
        "AGENT_RUNTIME_PROVIDER",
        config.agentRuntimeProvider === "claude-code",
        `AGENT_RUNTIME_PROVIDER=${config.agentRuntimeProvider}`
      );
    }
  }

  const codexEnabled = effectiveProvider === "codex";
  let codex = {
    enabled: codexEnabled,
    commandMode: "not-used",
    model: "",
    providerTimeoutSeconds: config.providerTimeoutSeconds,
    skillLocale: "",
    skillRootDir: "",
    skills: [],
    cli: { checked: false, ok: null, command: "codex", version: "", error: "" }
  };

  if (codexEnabled) {
    let settings = null;
    try {
      settings = resolveCodexSkillSettings(config);
      codex = {
        ...codex,
        commandMode: "codex-cli",
        model: settings.model,
        skillLocale: settings.skillLocale,
        skillRootDir: settings.skillRootDir,
        skills: settings.skills.map((skill) => ({
          id: skill.id,
          skillFile: path.relative(config.repoRoot, skill.skillFile)
        }))
      };
      addCheck(checks, "codex-skills", settings.skills.length > 0, `skills=${settings.skills.map((item) => item.id).join(",")}`);
    } catch (error) {
      addCheck(checks, "codex-skills", false, error instanceof Error ? error.message : String(error));
    }

    const cli = checkCodexCli();
    codex.cli = cli;
    addCheck(checks, "codex-cli", cli.ok, cli.ok ? `codex=${cli.version}` : cli.error);

    addCheck(
      checks,
      "PROVIDER_TIMEOUT_SECONDS",
      config.providerTimeoutSeconds > 0,
      `PROVIDER_TIMEOUT_SECONDS=${config.providerTimeoutSeconds}; 0 means no provider timeout`,
      "warning"
    );
  }

  const claudeEnabled = effectiveProvider === "claude-code";
  let claudeCode = {
    enabled: claudeEnabled,
    commandMode: "not-used",
    model: "",
    providerTimeoutSeconds: config.providerTimeoutSeconds,
    skillLocale: "",
    skillRootDir: "",
    permissionMode: "",
    allowedTools: [],
    skills: [],
    cli: { checked: false, ok: null, command: "claude", version: "", error: "" }
  };

  if (claudeEnabled) {
    let settings = null;
    try {
      settings = resolveClaudeSkillSettings(config);
      claudeCode = {
        ...claudeCode,
        commandMode: "claude-cli",
        model: settings.model,
        skillLocale: settings.skillLocale,
        skillRootDir: settings.skillRootDir,
        permissionMode: settings.permissionMode,
        allowedTools: settings.allowedTools,
        skills: settings.skills.map((skill) => ({
          id: skill.id,
          skillFile: path.relative(config.repoRoot, skill.skillFile)
        }))
      };
      addCheck(checks, "claude-code-skills", settings.skills.length > 0, `skills=${settings.skills.map((item) => item.id).join(",")}`);
    } catch (error) {
      addCheck(checks, "claude-code-skills", false, error instanceof Error ? error.message : String(error));
    }

    const cli = checkClaudeCli();
    claudeCode.cli = cli;
    addCheck(checks, "claude-code-cli", cli.ok, cli.ok ? `claude=${cli.version}` : cli.error);

    addCheck(
      checks,
      "PROVIDER_TIMEOUT_SECONDS",
      config.providerTimeoutSeconds > 0,
      `PROVIDER_TIMEOUT_SECONDS=${config.providerTimeoutSeconds}; 0 means no provider timeout`,
      "warning"
    );
  }

  const ok = checks.every((item) => item.ok || item.level === "warning");
  const output = {
    ok,
    envFilePath: config.envFilePath,
    aiProvider: config.ai.provider,
    agentRuntimeProvider: config.agentRuntimeProvider,
    effectiveProvider,
    expectedProvider,
    codex,
    claudeCode,
    checks
  };

  console.log(JSON.stringify(output, null, 2));
  if (!ok) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  }, null, 2));
  process.exit(1);
});
