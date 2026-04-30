import { existsSync } from "node:fs";
import path from "node:path";

const SKILL_LOCALES = new Set(["en", "zh"]);
const VALID_PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "auto",
  "dontAsk"
]);

function parseSkillList(raw) {
  return String(raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseToolList(raw) {
  return String(raw ?? "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseExtraArgs(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    return [];
  }
  const tokens = [];
  let current = "";
  let quote = null;
  for (const ch of trimmed) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

function skillDirectoryCandidates(skill, locale) {
  return locale === "zh"
    ? [`${skill}-zh`, skill]
    : [skill];
}

function resolveSkillDescriptor(config, skill) {
  for (const directoryName of skillDirectoryCandidates(skill, config.skillLocale)) {
    const skillDir = path.resolve(config.skillRootDir, directoryName);
    const skillFile = path.join(skillDir, "SKILL.md");
    if (existsSync(skillFile)) {
      return { id: skill, skillDir, skillFile };
    }
  }
  throw new Error(`Missing skill file for ${skill} under ${config.skillRootDir}`);
}

export function resolveClaudeSkillSettings(config) {
  const providerConfig = config.providers?.claudeCode;
  if (!providerConfig) {
    throw new Error("No claude-code skill configuration found.");
  }
  const skillLocale = SKILL_LOCALES.has(providerConfig.skillLocale) ? providerConfig.skillLocale : "zh";
  const permissionMode = VALID_PERMISSION_MODES.has(providerConfig.permissionMode)
    ? providerConfig.permissionMode
    : "bypassPermissions";
  const allowedTools = parseToolList(providerConfig.allowedTools ?? "Read,Glob,Grep");
  const extraArgs = parseExtraArgs(providerConfig.extraArgs);
  const maxBudgetUsd = providerConfig.maxBudgetUsd ? Number(providerConfig.maxBudgetUsd) : null;
  const normalized = {
    provider: "claude-code",
    command: providerConfig.command ?? "",
    model: providerConfig.model ?? "",
    skillLocale,
    locale: skillLocale,
    skillRootDir: path.resolve(providerConfig.skillRootDir),
    permissionMode,
    allowedTools,
    extraArgs,
    maxBudgetUsd: Number.isFinite(maxBudgetUsd) ? maxBudgetUsd : null,
    skills: []
  };
  const skillIds = parseSkillList(providerConfig.skills || "polypulse-market-agent");
  normalized.skills = skillIds.map((skill) => resolveSkillDescriptor(normalized, skill));
  return normalized;
}

export const claudeSkillSettingsInternals = {
  parseSkillList,
  parseToolList,
  parseExtraArgs,
  resolveSkillDescriptor
};
