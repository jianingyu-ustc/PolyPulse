import { existsSync } from "node:fs";
import path from "node:path";

const SKILL_LOCALES = new Set(["en", "zh"]);

function parseSkillList(raw) {
  return String(raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
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

export function resolveEffectiveProvider(config) {
  return String(config.ai?.provider ?? "codex").trim() || "codex";
}

export function resolveCodexSkillSettings(config) {
  const providerConfig = config.providers?.codex;
  if (!providerConfig) {
    throw new Error("No codex skill configuration found.");
  }
  const skillLocale = SKILL_LOCALES.has(providerConfig.skillLocale) ? providerConfig.skillLocale : "zh";
  const normalized = {
    provider: "codex",
    model: providerConfig.model ?? "",
    skillLocale,
    locale: skillLocale,
    skillRootDir: path.resolve(providerConfig.skillRootDir),
    skills: []
  };
  const skillIds = parseSkillList(providerConfig.skills || "polypulse-market-agent");
  normalized.skills = skillIds.map((skill) => resolveSkillDescriptor(normalized, skill));
  return normalized;
}
