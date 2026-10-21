/**
 * Skill activation and discovery prompt blocks for GSD auto-mode units.
 */

import { basename } from "node:path";
import type { Skill } from "@gsd/pi-coding-agent";
import { parseTaskPlanFile } from "./files.js";
import {
  loadEffectiveGSDPreferences,
  resolveAllSkillReferences,
  resolveSkillDiscoveryMode,
} from "./preferences.js";
import type { GSDPreferences } from "./preferences.js";
import { filterSkillsByManifest, resolveSkillManifest, warnIfManifestHasMissingSkills } from "./skill-manifest.js";
import { getInstalledSkills } from "./skills.js";
import { logWarning } from "./workflow-logger.js";

function normalizeSkillReference(ref: string): string {
  const normalized = ref.replace(/\\/g, "/").trim();
  const base = basename(normalized).replace(/\.md$/i, "");
  const name = /^SKILL$/i.test(base)
    ? basename(normalized.replace(/\/SKILL(?:\.md)?$/i, ""))
    : base;
  return name.trim().toLowerCase();
}

function tokenizeSkillContext(...parts: Array<string | null | undefined>): Set<string> {
  const tokens = new Set<string>();
  const addVariants = (raw: string) => {
    const value = raw.trim().toLowerCase();
    if (!value || value.length < 2) return;
    tokens.add(value);
    tokens.add(value.replace(/[-_]+/g, " "));
    tokens.add(value.replace(/\s+/g, "-"));
    tokens.add(value.replace(/\s+/g, ""));
  };

  for (const part of parts) {
    if (!part) continue;
    const text = part.toLowerCase();
    const phraseMatches = text.match(/[a-z0-9][a-z0-9+.#/_-]{1,}/g) ?? [];
    for (const match of phraseMatches) {
      addVariants(match);
      for (const piece of match.split(/[^a-z0-9+.#]+/g)) {
        if (piece.length >= 3) addVariants(piece);
      }
    }
  }

  return tokens;
}

function tokenizeUnitType(unitType: string | undefined): Set<string> {
  const tokens = new Set<string>();
  const value = unitType?.trim().toLowerCase();
  if (!value) return tokens;
  tokens.add(value);
  tokens.add(value.replace(/[-_]+/g, " "));
  tokens.add(value.replace(/[-_\s]+/g, ""));
  return tokens;
}

function skillMatchesContext(skill: Skill, contextTokens: Set<string>): boolean {
  const haystacks = [
    skill.name.toLowerCase(),
    skill.name.toLowerCase().replace(/[-_]+/g, " "),
    skill.description.toLowerCase(),
  ];

  return [...contextTokens].some(token =>
    token.length >= 3 && haystacks.some(haystack => haystack.includes(token)),
  );
}

function resolvePreferenceSkillNames(refs: string[], base: string): string[] {
  if (refs.length === 0) return [];
  const prefs: GSDPreferences = { always_use_skills: refs };
  const report = resolveAllSkillReferences(prefs, base);
  return refs.map(ref => {
    const resolution = report.resolutions.get(ref);
    return normalizeSkillReference(resolution?.resolvedPath ?? ref);
  }).filter(Boolean);
}

function ruleMatchesContext(when: string, contextTokens: Set<string>): boolean {
  const whenTokens = tokenizeSkillContext(when);
  return [...whenTokens].some(token =>
    contextTokens.has(token) || [...contextTokens].some(ctx => ctx.includes(token) || token.includes(ctx)),
  );
}

function ruleMatchesUnitType(when: string, unitType: string | undefined): boolean {
  if (!unitType) return false;
  const whenTokens = tokenizeSkillContext(when);
  const unitTokens = tokenizeUnitType(unitType);
  return [...unitTokens].some(token => whenTokens.has(token));
}

function resolveSkillRuleMatches(
  prefs: GSDPreferences | undefined,
  contextTokens: Set<string>,
  base: string,
  unitType?: string,
): { include: string[]; avoid: string[] } {
  if (!prefs?.skill_rules?.length) return { include: [], avoid: [] };

  const include: string[] = [];
  const avoid: string[] = [];
  for (const rule of prefs.skill_rules) {
    if (!ruleMatchesContext(rule.when, contextTokens) && !ruleMatchesUnitType(rule.when, unitType)) continue;
    include.push(...resolvePreferenceSkillNames([...(rule.use ?? []), ...(rule.prefer ?? [])], base));
    avoid.push(...resolvePreferenceSkillNames(rule.avoid ?? [], base));
  }
  return { include, avoid };
}

function resolvePreferredSkillNames(
  prefs: GSDPreferences | undefined,
  visibleSkills: Skill[],
  contextTokens: Set<string>,
  base: string,
): string[] {
  if (!prefs?.prefer_skills?.length) return [];
  const preferred = new Set(resolvePreferenceSkillNames(prefs.prefer_skills, base));
  return visibleSkills
    .filter(skill => preferred.has(normalizeSkillReference(skill.name)) && skillMatchesContext(skill, contextTokens))
    .map(skill => normalizeSkillReference(skill.name));
}

/** Skill names must be lowercase alphanumeric with hyphens — reject anything else
 *  to prevent prompt injection via crafted directory names. */
const SAFE_SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatSkillActivationBlock(skillNames: string[], skillPaths: Map<string, string>): string {
  const safe = skillNames.filter(name => SAFE_SKILL_NAME.test(name));
  if (safe.length === 0) return "";
  const reads = safe.map(name => {
    const path = skillPaths.get(name);
    if (path) return `Read the skill file at \`${escapeXml(path)}\``;
    return `Find '${name}' in <available_skills>, copy its <location> value, and pass that exact path to read`;
  }).join(". ");
  return `<skill_activation>${reads}.</skill_activation>`;
}

/**
 * Manifest-driven recommendations block — informational only, does NOT
 * auto-invoke. Lists per-unit-type skills that are installed but not already
 * activated by explicit user intent (always_use_skills / prefer_skills /
 * skill_rules / task-plan skills_used). Surfaces relevant skills to the
 * model so they can be invoked when the model judges them useful.
 *
 * This is the additive complement to the existing activation directive:
 * activation force-invokes (explicit intent), recommendations remind
 * (manifest defaults). User intent is preserved as the stronger signal
 * (RFC #4779 design principle); this block only adds visibility.
 */
function formatSkillRecommendationsBlock(unitType: string | undefined, skillNames: string[]): string {
  if (!unitType) return "";
  const safe = skillNames.filter(name => SAFE_SKILL_NAME.test(name));
  if (safe.length === 0) return "";
  return `<skill_recommendations unit="${unitType}">For this unit type, also consider reading these installed skill files from <available_skills>: ${safe.join(", ")}. These are recommendations, not requirements.</skill_recommendations>`;
}

export function buildSkillActivationBlock(params: {
  base: string;
  milestoneId: string;
  milestoneTitle?: string;
  sliceId?: string;
  sliceTitle?: string;
  taskId?: string;
  taskTitle?: string;
  extraContext?: string[];
  taskPlanContent?: string | null;
  preferences?: GSDPreferences;
  /**
   * Unit type dispatching this prompt. When provided, skills are filtered
   * through the per-unit-type manifest (see `skill-manifest.ts`). Unknown
   * or omitted values retain the pre-manifest behavior (all skills eligible).
   */
  unitType?: string;
  /** Installed skills from resourceLoader; defaults to loader cache via skills facade. */
  skills?: Skill[];
}): string {
  const prefs = params.preferences ?? loadEffectiveGSDPreferences(params.base)?.preferences;
  const contextTokens = tokenizeSkillContext(
    params.milestoneId,
    params.milestoneTitle,
    params.sliceId,
    params.sliceTitle,
    params.taskId,
    params.taskTitle,
  );

  const loaded = getInstalledSkills(params.skills).filter(skill => !skill.disableModelInvocation);

  // Skill activation here is driven entirely by explicit sources
  // (always_use_skills, prefer_skills, skill_rules, task-plan skills_used).
  // Every match is an explicit user/project intent and must not be dropped
  // by the unit-type manifest — user intent is stronger signal than
  // defaults. The manifest's real home is the skill catalog rendering
  // layer (pi-coding-agent `formatSkillsForPrompt`); that wiring is tracked
  // as the "load-time short-circuit" follow-up to RFC #4779.
  //
  // `unitType` stays plumbed so the strict-mode warning can surface
  // manifest entries that reference uninstalled skills, and so the
  // activation-block site is ready to opt in once PR B lands.
  const visibleSkills = loaded;
  const manifestScopedSkills = filterSkillsByManifest(visibleSkills, params.unitType);
  const installedNames = new Set(visibleSkills.map(skill => normalizeSkillReference(skill.name)));
  const installedSkillPaths = new Map(visibleSkills.map(skill => [normalizeSkillReference(skill.name), skill.filePath]));
  warnIfManifestHasMissingSkills(params.unitType, installedNames);
  const avoided = new Set(resolvePreferenceSkillNames(prefs?.avoid_skills ?? [], params.base));
  const matched = new Set<string>();

  for (const name of resolvePreferenceSkillNames(prefs?.always_use_skills ?? [], params.base)) {
    matched.add(name);
  }

  const ruleMatches = resolveSkillRuleMatches(prefs, contextTokens, params.base, params.unitType);
  for (const name of ruleMatches.include) matched.add(name);
  for (const name of ruleMatches.avoid) avoided.add(name);

  for (const name of resolvePreferredSkillNames(prefs, visibleSkills, contextTokens, params.base)) {
    matched.add(name);
  }

  if (params.taskPlanContent) {
    try {
      const taskPlan = parseTaskPlanFile(params.taskPlanContent);
      for (const skillName of taskPlan.frontmatter.skills_used) {
        matched.add(normalizeSkillReference(skillName));
      }
    } catch (err) {
      logWarning("prompt", `parseTaskPlanFile failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Heuristic auto-match (gated on skill_discovery: "auto").
  // For each installed skill, check if its name or description appears in the
  // unit's context tokens (milestone/slice/task titles). Only consider skills
  // already on the unit-type manifest allowlist — this keeps the heuristic
  // narrow and avoids wildly off-topic activations.
  // Users who set `skill_discovery: "off"` or "suggest" do not get
  // auto-matched skills (the recommendations block still surfaces manifest
  // skills passively); only "auto" actually adds them to the activation
  // directive set. Default `skill_discovery` is "suggest", so this is opt-in.
  if ((prefs?.skill_discovery ?? "suggest") === "auto") {
    for (const skill of manifestScopedSkills) {
      const normalized = normalizeSkillReference(skill.name);
      if (matched.has(normalized) || avoided.has(normalized)) continue;
      if (skillMatchesContext(skill, contextTokens)) {
        matched.add(normalized);
      }
    }
  }

  const ordered = [...matched]
    .filter(name => installedNames.has(name) && !avoided.has(name))
    .sort();
  const activationBlock = formatSkillActivationBlock(ordered, installedSkillPaths);

  // Omit recommendations when the system catalog is manifest-scoped for this
  // unit — skill names are already listed in <available_skills>.
  let recommendationsBlock = "";
  if (resolveSkillManifest(params.unitType) === null) {
    const matchedSet = new Set(ordered);
    const recommendations = (resolveSkillManifest(params.unitType) ?? [])
      .filter(name => installedNames.has(name) && !avoided.has(name) && !matchedSet.has(name))
      .sort();
    recommendationsBlock = formatSkillRecommendationsBlock(params.unitType, recommendations);
  }

  if (!activationBlock && !recommendationsBlock) return "";
  if (!activationBlock) return recommendationsBlock;
  if (!recommendationsBlock) return activationBlock;
  return `${activationBlock}\n${recommendationsBlock}`;
}

/**
 * Build the skill discovery template variables for research prompts.
 * Returns { skillDiscoveryMode, skillDiscoveryInstructions } for template substitution.
 */
export function buildSkillDiscoveryVars(): { skillDiscoveryMode: string; skillDiscoveryInstructions: string } {
  const mode = resolveSkillDiscoveryMode();

  if (mode === "off") {
    return {
      skillDiscoveryMode: "off",
      skillDiscoveryInstructions: " Skill discovery is disabled. Skip this step.",
    };
  }

  if (mode === "suggest") {
    return {
      skillDiscoveryMode: mode,
      skillDiscoveryInstructions: `
   Check \`<available_skills>\` for installed skills matching core technologies. For gaps, run \`npx skills find "<technology>"\` and note promising install commands in your research output — do NOT install.`,
    };
  }

  const autoInstall = mode === "auto";
  const instructions = autoInstall
    ? `
   Check \`<available_skills>\` first. For missing core-technology skills, run \`npx skills find "<technology>"\`, install relevant matches with \`npx skills add <owner/repo@skill> -g -y\`, and record them in "Skills Discovered".`
    : `
   Check \`<available_skills>\` first. For missing core-technology skills, run \`npx skills find "<technology>"\` and note install commands in your research output — do NOT install.`;

  return {
    skillDiscoveryMode: mode,
    skillDiscoveryInstructions: instructions,
  };
}
