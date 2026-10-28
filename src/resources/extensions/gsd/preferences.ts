/**
 * GSD Preferences -- loading, merging, and rendering.
 *
 * This module is the primary entry point for preference operations.
 * Type definitions live in ./preferences-types.js, validation in
 * ./preferences-validation.js, skill logic in ./preferences-skills.js,
 * and model logic in ./preferences-models.js.
 *
 * All symbols are re-exported here so that existing `import { ... } from "./preferences.js"`
 * statements continue to work without modification.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { gsdRoot } from "./paths.js";
import { parse as parseYaml, parseDocument } from "yaml";
import type { PostUnitHookConfig, PreDispatchHookConfig, TokenProfile } from "./types.js";
import type { DynamicRoutingConfig } from "./model-router.js";
import { normalizeStringArray } from "../shared/format-utils.js";
import { logWarning } from "./workflow-logger.js";
import {
  DEFAULT_TOKEN_PROFILE,
  resolveProfileDefaults as _resolveProfileDefaults,
  VALID_TOKEN_PROFILES,
  resolveDisabledModelProvidersFromPreferences,
} from "./preferences-models.js";
import { nativeHasCommittedHead, nativeIsRepo } from "./native-git-bridge.js";

import {
  KNOWN_PREFERENCE_KEYS,
  MODE_DEFAULTS,
  type WorkflowMode,
  type GSDPreferences,
  type LoadedGSDPreferences,
  type PreferenceDiagnostic,
  type SkillResolution,
  type SkillDiscoveryMode,
  formatSkillRef,
} from "./preferences-types.js";
import { crossAxisPreferenceWarnings, validatePreferences } from "./preferences-validation.js";
import { gsdHome } from "./gsd-home.js";

// ─── Re-exports: types ──────────────────────────────────────────────────────
// Every type/interface that was previously exported from this file is
// re-exported so that downstream `import { Foo } from "./preferences.js"`
// statements keep compiling.

export type {
  WorkflowMode,
  GSDSkillRule,
  GSDPhaseModelConfig,
  GSDModelConfig,
  GSDModelConfigV2,
  ResolvedModelConfig,
  SkillDiscoveryMode,
  AutoSupervisorConfig,
  RemoteQuestionsConfig,
  CmuxPreferences,
  UokTurnActionMode,
  UokPreferences,
  CodebaseMapPreferences,
  ClaudeCodeMcpPerModelEntry,
  ClaudeCodeMcpConfig,
  GSDPreferences,
  LoadedGSDPreferences,
  PreferenceDiagnostic,
  SkillResolution,
  SkillResolutionReport,
} from "./preferences-types.js";

// ─── Re-exports: validation ─────────────────────────────────────────────────
export { validatePreferences } from "./preferences-validation.js";

// ─── Re-exports: skills ─────────────────────────────────────────────────────
export { resolveAllSkillReferences } from "./preferences-skills.js";

// These lived in preferences-skills.ts but imported loadEffectiveGSDPreferences
// back from this file, creating a circular dependency. Moved here since they
// are trivial wrappers over loadEffectiveGSDPreferences.
export function resolveSkillDiscoveryMode(basePath?: string): SkillDiscoveryMode {
  const prefs = loadEffectiveGSDPreferences(basePath);
  return prefs?.preferences.skill_discovery ?? "suggest";
}

export function resolveSkillStalenessDays(basePath?: string): number {
  const prefs = loadEffectiveGSDPreferences(basePath);
  return prefs?.preferences.skill_staleness_days ?? 60;
}

// ─── Re-exports: models ─────────────────────────────────────────────────────
export {
  resolveModelForUnit,
  resolveModelWithFallbacksForUnit,
  resolveThinkingLevelForUnit,
  phaseChainForUnit,
  getNextFallbackModel,
  isTransientNetworkError,
  validateModelId,
  updatePreferencesModels,
  resolveDynamicRoutingConfig,
  resolveAutoSupervisorConfig,
  resolveProfileDefaults,
  getProfileTierMap,
  resolveEffectiveProfile,
  resolveInlineLevel,
  resolveContextSelection,
  resolveSearchProviderFromPreferences,
  resolveDisabledModelProvidersFromPreferences,
} from "./preferences-models.js";

// ─── Re-exports: MCP ────────────────────────────────────────────────────────
export { resolveModelMcpConfig } from "./preferences-mcp.js";

// ─── Path Constants & Getters ───────────────────────────────────────────────

function globalPreferencesPath(): string {
  return join(gsdHome(), "PREFERENCES.md");
}

function legacyGlobalPreferencesPath(): string {
  return join(homedir(), ".pi", "agent", "gsd-preferences.md");
}

function projectPreferencesPath(basePath: string = process.cwd()): string {
  return join(gsdRoot(basePath), "PREFERENCES.md");
}
// Legacy lowercase files can still exist in older projects. Keep them as a
// compatibility-only fallback, but route new reads/writes through PREFERENCES.md.
function legacyGlobalPreferencesPathLowercase(): string {
  return join(gsdHome(), "preferences.md");
}
function legacyProjectPreferencesPathLowercase(basePath: string = process.cwd()): string {
  return join(gsdRoot(basePath), "preferences.md");
}

export function getGlobalGSDPreferencesPath(): string {
  return globalPreferencesPath();
}

export function getLegacyGlobalGSDPreferencesPath(): string {
  return legacyGlobalPreferencesPath();
}

export function getProjectGSDPreferencesPath(basePath?: string): string {
  return projectPreferencesPath(basePath);
}

/** Minimal model-registry surface for provider-aware preference resolution. */
export type PreferencesModelRegistry = {
  getAvailable: () => ReadonlyArray<{ provider: string; id: string }>;
};

/** Format registry models the same way tier resolution and prefs persistence use. */
export function availableModelIdsFromRegistry(registry: PreferencesModelRegistry): string[] {
  return registry.getAvailable().map((m) => `${m.provider}/${m.id}`);
}

/**
 * Keep only provider-qualified model IDs for a single provider (case-insensitive).
 * Bare IDs are excluded — tier resolution requires provider/model form.
 */
export function restrictModelIdsToProvider(modelIds: string[], provider: string): string[] {
  const normalized = provider.trim().toLowerCase();
  if (!normalized) return modelIds;
  return modelIds.filter((id) => {
    const slash = id.indexOf("/");
    if (slash <= 0) return false;
    return id.slice(0, slash).toLowerCase() === normalized;
  });
}

/**
 * Model IDs for token-profile tier resolution. When an anchor provider is known
 * (session model / auto-start snapshot), stay on that provider instead of picking
 * the globally cheapest tier match across every logged-in provider (e.g. Gemini
 * Flash beating GPT mini on cost).
 */
export function modelIdsForProfileResolution(
  registry: PreferencesModelRegistry,
  anchorProvider?: string,
  disabledProviders?: string[],
): string[] | undefined {
  let all = availableModelIdsFromRegistry(registry);
  if (disabledProviders?.length) {
    const blocked = new Set(
      disabledProviders.map((p) => p.trim().toLowerCase()).filter((p) => p.length > 0),
    );
    all = all.filter((id) => {
      const slash = id.indexOf("/");
      if (slash <= 0) return true;
      return !blocked.has(id.slice(0, slash).toLowerCase());
    });
  }
  if (all.length === 0) return undefined;
  if (!anchorProvider?.trim()) return all;
  // Stay on the anchor provider — do not fall back to the full registry when the
  // scoped list is empty (that reintroduces cross-provider cost picks like Gemini).
  return restrictModelIdsToProvider(all, anchorProvider);
}

/** Provider anchor for token-profile tier resolution (auto-start model wins). */
export function resolveProfileAnchorProvider(
  sessionProvider?: string,
  autoModeStartProvider?: string | null,
): string | undefined {
  const start = autoModeStartProvider?.trim();
  if (start) return start;
  const session = sessionProvider?.trim();
  return session || undefined;
}

/**
 * Load effective preferences with token-profile tiers resolved against models
 * the user can actually call (from the live registry), not canonical Anthropic
 * fallbacks.
 */
export function loadEffectiveGSDPreferencesWithRegistry(
  registry: PreferencesModelRegistry | undefined,
  basePath?: string,
  anchorProvider?: string,
  preferredModelId?: string,
): LoadedGSDPreferences | null {
  const preferenceOpts = preferredModelId !== undefined
    ? { preferredModelId }
    : undefined;
  if (!registry) {
    return loadEffectiveGSDPreferences(basePath, preferenceOpts);
  }
  const disabledProviders = resolveDisabledModelProvidersFromPreferences();
  const availableModelIds = modelIdsForProfileResolution(registry, anchorProvider, disabledProviders);
  if (!availableModelIds) {
    return loadEffectiveGSDPreferences(basePath, preferenceOpts);
  }
  return loadEffectiveGSDPreferences(basePath, { availableModelIds, preferredModelId });
}

/**
 * Normalize a value loaded from disk (or passed from another component) into
 * a plain, mutable bare preferences object.
 *
 * Accepts:
 *   - a `LoadedGSDPreferences` wrapper (`{ path, scope, preferences, ... }`)
 *   - a bare `GSDPreferences` object
 *   - `null` / `undefined` / any malformed value
 *
 * Returns a fresh `Record<string, unknown>` so callers may spread additional
 * values without mutating the input. This is the single boundary the
 * preferences wizard funnels existing-on-disk data through, so missing or
 * partially-formed preference shapes can no longer reach code that assumes
 * a fully-populated wrapper.
 */
export function normalizePreferencesShape(
  loaded: unknown,
): Record<string, unknown> {
  if (!loaded || typeof loaded !== "object") return {};
  const obj = loaded as Record<string, unknown>;
  // Wrapper shape (`LoadedGSDPreferences`) carries the nested preferences
  // under a `.preferences` key. Bare `GSDPreferences` never declares one
  // (see preferences-types.ts), so the presence of that key is a reliable
  // discriminator. Tolerate `preferences: undefined` by falling through to
  // the empty-object return below.
  const candidate = "preferences" in obj ? obj.preferences : obj;
  if (!candidate || typeof candidate !== "object") return {};
  return { ...(candidate as Record<string, unknown>) };
}
// ─── Loading ────────────────────────────────────────────────────────────────

const EFFECTIVE_PREFERENCES_CACHE_MAX = 64;
const effectivePreferencesCache = new Map<string, LoadedGSDPreferences | null>();

type EffectivePreferencesLoadOptions = {
  availableModelIds?: string[];
  preferredModelId?: string;
  skipProfileDefaults?: boolean;
};

export function clearGSDPreferencesCache(): void {
  effectivePreferencesCache.clear();
}

function globalPreferencesCandidatePaths(): string[] {
  return [
    globalPreferencesPath(),
    legacyGlobalPreferencesPathLowercase(),
    legacyGlobalPreferencesPath(),
  ];
}

function projectPreferencesCandidatePaths(basePath?: string): string[] {
  return [
    projectPreferencesPath(basePath),
    legacyProjectPreferencesPathLowercase(basePath),
  ];
}

function preferencesFileSignature(path: string): string {
  try {
    const stats = statSync(path);
    return `${path}:${stats.size}:${stats.mtimeMs}`;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unknown";
    return `${path}:missing:${code}`;
  }
}

function effectivePreferencesCacheKey(
  basePath?: string,
  opts?: EffectivePreferencesLoadOptions,
): string {
  return JSON.stringify({
    basePath: basePath ?? null,
    global: globalPreferencesCandidatePaths().map(preferencesFileSignature),
    project: projectPreferencesCandidatePaths(basePath).map(preferencesFileSignature),
    availableModelIds: opts?.availableModelIds ?? null,
    preferredModelId: opts?.preferredModelId ?? null,
    skipProfileDefaults: opts?.skipProfileDefaults === true,
  });
}

function cloneLoadedPreferences(
  loaded: LoadedGSDPreferences | null,
): LoadedGSDPreferences | null {
  return loaded ? structuredClone(loaded) : null;
}

function cacheEffectivePreferences(
  key: string,
  loaded: LoadedGSDPreferences | null,
): void {
  if (!effectivePreferencesCache.has(key) && effectivePreferencesCache.size >= EFFECTIVE_PREFERENCES_CACHE_MAX) {
    effectivePreferencesCache.clear();
  }
  effectivePreferencesCache.set(key, cloneLoadedPreferences(loaded));
}

export function loadGlobalGSDPreferences(): LoadedGSDPreferences | null {
  return loadFirstUsablePreferencesFile(globalPreferencesCandidatePaths(), "global");
}

export function loadProjectGSDPreferences(basePath?: string): LoadedGSDPreferences | null {
  return loadFirstUsablePreferencesFile(projectPreferencesCandidatePaths(basePath), "project");
}

export function _loadProjectPreferencesCandidatesForTest(
  paths: string[],
): LoadedGSDPreferences | null {
  return loadFirstUsablePreferencesFile(paths, "project");
}

export function loadEffectiveGSDPreferences(
  basePath?: string,
  opts?: EffectivePreferencesLoadOptions,
): LoadedGSDPreferences | null {
  const cacheKey = effectivePreferencesCacheKey(basePath, opts);
  if (effectivePreferencesCache.has(cacheKey)) {
    return cloneLoadedPreferences(effectivePreferencesCache.get(cacheKey)!);
  }

  const globalPreferences = loadGlobalGSDPreferences();
  const projectPreferences = loadProjectGSDPreferences(basePath);
  const effectiveGlobalPreferences = globalPreferences?.ignored ? null : globalPreferences;
  const effectiveProjectPreferences = projectPreferences?.ignored ? null : projectPreferences;
  const projectHasPlanningDepth = effectiveProjectPreferences?.preferences.planning_depth !== undefined;
  const projectHasRuntimeContract = effectiveProjectPreferences?.preferences.runtime?.contract !== undefined;

  if (!effectiveGlobalPreferences && !effectiveProjectPreferences) {
    if (projectPreferences?.projectRuntimeContract === "invalid") {
      const result = { ...projectPreferences, preferences: {} };
      cacheEffectivePreferences(cacheKey, result);
      return result;
    }
    cacheEffectivePreferences(cacheKey, null);
    return null;
  }

  let result: LoadedGSDPreferences;
  if (!effectiveGlobalPreferences) {
    result = effectiveProjectPreferences!;
  } else if (!effectiveProjectPreferences) {
    result = mergePreferenceMetadata(effectiveGlobalPreferences, projectPreferences);
  } else {
    const metadata = mergePreferenceMetadata(effectiveGlobalPreferences, effectiveProjectPreferences);
    result = {
      path: effectiveProjectPreferences.path,
      scope: "project",
      preferences: mergePreferences(effectiveGlobalPreferences.preferences, effectiveProjectPreferences.preferences),
      ...(metadata.projectRuntimeContract ? { projectRuntimeContract: metadata.projectRuntimeContract } : {}),
      ...(metadata.warnings ? { warnings: metadata.warnings } : {}),
      ...(metadata.diagnostics ? { diagnostics: metadata.diagnostics } : {}),
    };
  }

  // Apply token-profile defaults as the lowest-priority layer so that
  // `token_profile: budget` sets models and phase-skips automatically.
  // Explicit user preferences always override profile defaults.
  const explicitProfile = result.preferences.token_profile as TokenProfile | undefined;
  let profileForDefaults: TokenProfile | undefined;
  if (explicitProfile) {
    if (VALID_TOKEN_PROFILES.has(explicitProfile)) {
      profileForDefaults = explicitProfile;
    }
  } else {
    profileForDefaults = DEFAULT_TOKEN_PROFILE;
  }
  if (profileForDefaults && !opts?.skipProfileDefaults) {
    const profileDefaults = _resolveProfileDefaults(
      profileForDefaults,
      opts?.availableModelIds,
      result.preferences.dynamic_routing,
      opts?.preferredModelId,
    );
    const defaultsToApply = explicitProfile
      ? profileDefaults
      : withoutProfilePhaseDefaults(profileDefaults);
    result = {
      ...result,
      preferences: mergePreferences(defaultsToApply as GSDPreferences, result.preferences),
    };
  }

  // Apply mode defaults as the lowest-priority layer
  if (result.preferences.mode) {
    result = {
      ...result,
      preferences: applyModeDefaults(result.preferences.mode, result.preferences),
    };
  }

  result = stripInheritedPlanningDepth(result, projectHasPlanningDepth);
  result = stripInheritedRuntimeContract(result, projectHasRuntimeContract);
  result = appendCrossAxisPreferenceWarnings(result);

  cacheEffectivePreferences(cacheKey, result);
  return result;
}

function appendCrossAxisPreferenceWarnings(loaded: LoadedGSDPreferences): LoadedGSDPreferences {
  const crossWarnings = crossAxisPreferenceWarnings(loaded.preferences);
  const existingMessages = new Set([
    ...(loaded.warnings ?? []),
    ...(loaded.diagnostics ?? []).map((diagnostic) => diagnostic.message),
  ]);
  const newWarnings = crossWarnings.filter((message) => !existingMessages.has(message));
  if (newWarnings.length === 0) return loaded;

  return {
    ...loaded,
    warnings: [...(loaded.warnings ?? []), ...newWarnings],
    diagnostics: [
      ...(loaded.diagnostics ?? []),
      ...newWarnings.map((message): PreferenceDiagnostic => ({
        path: loaded.path,
        scope: loaded.scope,
        severity: "warning",
        kind: "validation",
        message,
        sanitized: true,
      })),
    ],
  };
}

function withoutProfilePhaseDefaults(defaults: Partial<GSDPreferences>): Partial<GSDPreferences> {
  if (defaults.phases === undefined) return defaults;
  const { phases: _phases, ...rest } = defaults;
  return rest;
}

function mergePreferenceMetadata(
  primary: LoadedGSDPreferences,
  secondary: LoadedGSDPreferences | null,
): LoadedGSDPreferences {
  const mergedWarnings = [
    ...(primary.warnings ?? []),
    ...(secondary?.warnings ?? []),
  ];
  const mergedDiagnostics = [
    ...(primary.diagnostics ?? []),
    ...(secondary?.diagnostics ?? []),
  ];
  const projectRuntimeContract = secondary?.projectRuntimeContract === "invalid"
    ? "invalid"
    : primary.projectRuntimeContract ?? secondary?.projectRuntimeContract;
  return {
    ...primary,
    ...(projectRuntimeContract ? { projectRuntimeContract } : {}),
    ...(mergedWarnings.length > 0 ? { warnings: mergedWarnings } : {}),
    ...(mergedDiagnostics.length > 0 ? { diagnostics: mergedDiagnostics } : {}),
  };
}

function loadFirstUsablePreferencesFile(
  paths: string[],
  scope: "global" | "project",
): LoadedGSDPreferences | null {
  let ignoredPreferences: LoadedGSDPreferences | null = null;

  for (const path of paths) {
    const loaded = loadPreferencesFile(path, scope);
    if (!loaded) continue;
    if (!loaded.ignored) return mergePreferenceMetadata(loaded, ignoredPreferences);
    ignoredPreferences = ignoredPreferences
      ? mergePreferenceMetadata(ignoredPreferences, loaded)
      : loaded;
  }

  return ignoredPreferences;
}

function stripInheritedPlanningDepth(
  loaded: LoadedGSDPreferences,
  projectHasPlanningDepth: boolean,
): LoadedGSDPreferences {
  if (projectHasPlanningDepth || loaded.preferences.planning_depth === undefined) {
    return loaded;
  }

  // planning_depth is a project bootstrap routing flag, not a user-global
  // preference. A global ~/.gsd/PREFERENCES.md value should not make every
  // fresh repo behave like `/gsd new-project --deep`.
  const preferences: GSDPreferences = { ...loaded.preferences };
  delete preferences.planning_depth;
  return { ...loaded, preferences };
}

function stripInheritedRuntimeContract(
  loaded: LoadedGSDPreferences,
  projectHasRuntimeContract: boolean,
): LoadedGSDPreferences {
  if (projectHasRuntimeContract || loaded.preferences.runtime?.contract === undefined) {
    return loaded;
  }

  const preferences: GSDPreferences = { ...loaded.preferences };
  delete preferences.runtime;
  return { ...loaded, preferences };
}

function loadPreferencesFile(path: string, scope: "global" | "project"): LoadedGSDPreferences | null {
  if (!existsSync(path)) return null;

  const raw = readFileSync(path, "utf-8");
  const parsed = parsePreferencesMarkdownWithDiagnostics(raw);
  if (!parsed.preferences && parsed.diagnostics.length === 0) return null;

  const ignored = parsed.diagnostics.some((diagnostic) => diagnostic.ignored === true);
  const preferences = parsed.preferences ?? {};
  const validation = validatePreferences(preferences);
  const rawRuntime = (preferences as Record<string, unknown>).runtime;
  const hasParsedRuntimeContract = hasRuntimeContractProperty(rawRuntime);
  const hasConfiguredRuntimeContract = scope === "project"
    && (
      hasParsedRuntimeContract
      || parsed.runtimeContractParseFailed
      || (ignored && containsRuntimeContractSetting(raw))
    );
  let projectRuntimeContract: LoadedGSDPreferences["projectRuntimeContract"];
  if (hasConfiguredRuntimeContract) {
    projectRuntimeContract = validation.preferences.runtime?.contract ? "valid" : "invalid";
  }
  const allWarnings = [...validation.warnings, ...validation.errors];
  const diagnostics: PreferenceDiagnostic[] = [
    ...parsed.diagnostics.map((diagnostic) => ({ ...diagnostic, path, scope })),
    ...validation.errors.map((message): PreferenceDiagnostic => ({
      path,
      scope,
      severity: "error",
      kind: "validation",
      message,
      sanitized: true,
    })),
    ...validation.warnings.map((message): PreferenceDiagnostic => ({
      path,
      scope,
      severity: "warning",
      kind: "validation",
      message,
      sanitized: true,
    })),
  ];

  return {
    path,
    scope,
    preferences: validation.preferences,
    ...(projectRuntimeContract ? { projectRuntimeContract } : {}),
    ...(ignored ? { ignored: true } : {}),
    ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  };
}

function containsRuntimeContractSetting(content: string): boolean {
  let start = 0;
  if (content.startsWith("---\r\n")) {
    start = 5;
  } else if (content.startsWith("---\n")) {
    start = 4;
  } else {
    return false;
  }
  const end = content.indexOf("\n---", start);
  const frontmatter = content.slice(start, end === -1 ? undefined : end);
  return parseDocument(frontmatter).hasIn(["runtime", "contract"]);
}

function hasRuntimeContractProperty(runtime: unknown): boolean {
  if (Array.isArray(runtime)) return runtime.some(hasRuntimeContractProperty);
  return typeof runtime === "object" && runtime !== null && Object.hasOwn(runtime, "contract");
}

function arrayRootHasRuntimeContract(preferences: unknown[]): boolean {
  return preferences.some((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
    return hasRuntimeContractProperty((item as Record<string, unknown>).runtime);
  });
}

let _warnedUnrecognizedFormat = false;
let _warnedSectionParse = false;

/** @internal Reset the warn-once flags — exported for testing only. */
export function _resetParseWarningFlag(): void {
  _warnedUnrecognizedFormat = false;
  _warnedFrontmatterParse = false;
  _warnedSectionParse = false;
}

/** @internal Exported for testing only */
export function parsePreferencesMarkdown(content: string): GSDPreferences | null {
  return parsePreferencesMarkdownWithDiagnostics(content).preferences;
}

type PreferenceParseDiagnostic = Omit<PreferenceDiagnostic, "path" | "scope">;

interface PreferenceParseResult {
  preferences: GSDPreferences | null;
  diagnostics: PreferenceParseDiagnostic[];
  runtimeContractParseFailed?: boolean;
}

function parsePreferencesMarkdownWithDiagnostics(content: string): PreferenceParseResult {
  // Use indexOf instead of [\s\S]*? regex to avoid backtracking (#468)
  const startMarker = content.startsWith('---\r\n') ? '---\r\n' : '---\n';
  if (content.startsWith(startMarker)) {
    const searchStart = startMarker.length;
    const endIdx = content.indexOf('\n---', searchStart);
    if (endIdx === -1) {
      return {
        preferences: null,
        diagnostics: [{
          severity: "error",
          kind: "parse",
          message: "preferences frontmatter is missing a closing --- delimiter",
          ignored: true,
        }],
      };
    }
    const block = content.slice(searchStart, endIdx);
    return parseFrontmatterBlockWithDiagnostics(block.replace(/\r/g, ''), 1);
  }

  // Fallback: heading+list format (e.g. "## Git\n- isolation: none") (#2036)
  // GSD agents may write preferences files without frontmatter delimiters.
  if (/^##\s+\w/m.test(content)) {
    return parseHeadingListFormat(content);
  }

  // Warn when a non-empty file exists but lacks frontmatter delimiters (#2036).
  if (content.trim().length > 0 && !_warnedUnrecognizedFormat) {
    _warnedUnrecognizedFormat = true;
    console.warn(
      "[GSD] Warning: preferences file has unrecognized format — content does not use YAML frontmatter delimiters (---). " +
      "Wrap your preferences in --- fences. See https://github.com/open-gsd/gsd-pi/issues/2036",
    );
  }
  return {
    preferences: null,
    diagnostics: content.trim().length > 0
      ? [{
          severity: "error",
          kind: "parse",
          message: "preferences file has unrecognized format; expected YAML frontmatter delimiters (---) or markdown preference sections",
          ignored: true,
        }]
      : [],
  };
}

let _warnedFrontmatterParse = false;
function parseFrontmatterBlockWithDiagnostics(
  frontmatter: string,
  lineOffset: number,
): PreferenceParseResult {
  try {
    const parsed = parseYaml(frontmatter);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {
        preferences: {} as GSDPreferences,
        diagnostics: [{
          severity: "error",
          kind: "validation",
          message: "preferences frontmatter must be a YAML object",
          ignored: true,
        }],
        ...(Array.isArray(parsed) && arrayRootHasRuntimeContract(parsed)
          ? { runtimeContractParseFailed: true }
          : {}),
      };
    }
    return {
      preferences: normalizeParsedPreferences(parsed as GSDPreferences),
      diagnostics: [],
    };
  } catch (e) {
    // Warn at most once per session to avoid flooding TUI (#3376)
    if (!_warnedFrontmatterParse) {
      _warnedFrontmatterParse = true;
      logWarning("guided", `YAML parse error in preferences frontmatter (suppressing further): ${(e as Error).message}`);
    }
    const location = extractYamlErrorLocation(e, lineOffset);
    return {
      preferences: {} as GSDPreferences,
      diagnostics: [{
        severity: "error",
        kind: "parse",
        message: cleanYamlErrorMessage(e),
        ...(location.line !== undefined ? { line: location.line } : {}),
        ...(location.column !== undefined ? { column: location.column } : {}),
        ignored: true,
      }],
    };
  }
}

function cleanYamlErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split("\n")[0]?.trim() ?? "unknown YAML parse error";
  return firstLine.replace(/\s+at line \d+, column \d+:?$/, "");
}

function extractYamlErrorLocation(
  error: unknown,
  lineOffset: number,
): { line?: number; column?: number } {
  const linePos = (error as { linePos?: Array<{ line?: unknown; col?: unknown }> })?.linePos;
  const first = Array.isArray(linePos) ? linePos[0] : undefined;
  const line = typeof first?.line === "number" ? first.line + lineOffset : undefined;
  const column = typeof first?.col === "number" ? first.col : undefined;
  return {
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
  };
}

function normalizeParsedPreferences(preferences: GSDPreferences): GSDPreferences {
  const remoteQuestions = preferences.remote_questions;
  if (remoteQuestions && typeof remoteQuestions === "object" && typeof remoteQuestions.channel_id === "number") {
    const rawChannelId = remoteQuestions.channel_id;
    const normalizedChannelId =
      Number.isSafeInteger(rawChannelId) ? String(rawChannelId) : rawChannelId;
    return {
      ...preferences,
      remote_questions: {
        ...remoteQuestions,
        channel_id: normalizedChannelId,
      },
    };
  }
  return preferences;
}

/**
 * Detect whether a heading+list section whose YAML failed to parse was trying
 * to configure a runtime contract, so discovery fails closed instead of
 * silently proceeding. A runtime contract can appear either as a top-level
 * `contract` under a `## Runtime` heading, or nested as `runtime: { contract }`
 * under any other supported heading (e.g. `## Settings`) — the successful parse
 * path re-homes that nested form onto the `runtime` key, so a malformed variant
 * must be treated the same. `parseDocument` never throws, so `hasIn` still sees
 * the keys captured before the syntax error.
 */
function brokenSectionReferencesRuntimeContract(section: string, yamlBlock: string): boolean {
  const doc = parseDocument(yamlBlock);
  if (section === "runtime" && doc.hasIn(["contract"])) return true;
  return doc.hasIn(["runtime", "contract"]);
}

/**
 * Parse heading+list format into a nested object, then cast to GSDPreferences.
 * Handles markdown like:
 *   ## Git
 *   - isolation: none
 *   - commit_docs: true
 *   ## Models
 *   - planner: sonnet
 */
function parseHeadingListFormat(content: string): PreferenceParseResult {
  const result: Record<string, string[]> = {};
  const diagnostics: PreferenceParseDiagnostic[] = [];
  let runtimeContractParseFailed = false;
  let currentSection: string | null = null;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const headingMatch = line.match(/^##\s+(.+)$/);
    if (headingMatch) {
      currentSection = headingMatch[1].trim().toLowerCase().replace(/\s+/g, '_');
      if (!result[currentSection]) result[currentSection] = [];
      continue;
    }
    if (currentSection && line.trim() && !line.trimStart().startsWith('#')) {
      result[currentSection].push(line);
    }
  }

  const typed: Record<string, unknown> = {};
  for (const [section, lines] of Object.entries(result)) {
    if (lines.length === 0) continue;

    const usesLegacyListItems = lines.every((line) => /^\s*-\s+[^:]+:\s*.*$/.test(line));
    const yamlBlock = usesLegacyListItems
      ? lines.map((line) => line.replace(/^\s*-\s+/, '')).join('\n')
      : lines.join('\n');

    try {
      const parsed = parseYaml(yamlBlock);
      if (typeof parsed !== 'object' || parsed === null) continue;

      let targetSection = section;
      let value: unknown = parsed;

      if (!Array.isArray(parsed)) {
        const keys = Object.keys(parsed);
        if (keys.length === 1) {
          const [onlyKey] = keys;
          if (onlyKey === section || (!KNOWN_PREFERENCE_KEYS.has(section) && KNOWN_PREFERENCE_KEYS.has(onlyKey))) {
            targetSection = onlyKey;
            value = (parsed as Record<string, unknown>)[onlyKey];
          }
        }
      }

      typed[targetSection] = value;
    } catch (e) {
      if (brokenSectionReferencesRuntimeContract(section, yamlBlock)) {
        runtimeContractParseFailed = true;
        diagnostics.push({
          severity: "error",
          kind: "parse",
          message: "preferences runtime contract section could not be parsed",
          sanitized: true,
        });
      }
      if (!_warnedSectionParse) {
        _warnedSectionParse = true;
        logWarning("guided", `preferences section parse failed: ${(e as Error).message}`);
      }
    }
  }

  return {
    preferences: normalizeParsedPreferences(typed as GSDPreferences),
    diagnostics,
    ...(runtimeContractParseFailed ? { runtimeContractParseFailed: true } : {}),
  };
}

// ─── Merging ────────────────────────────────────────────────────────────────

/**
 * Apply mode defaults as the lowest-priority layer.
 * Mode defaults fill in undefined fields; any explicit user value wins.
 */
export function applyModeDefaults(mode: WorkflowMode, prefs: GSDPreferences): GSDPreferences {
  const defaults = MODE_DEFAULTS[mode];
  if (!defaults) return prefs;
  return mergePreferences(defaults, prefs);
}

function mergePreferences(base: GSDPreferences, override: GSDPreferences): GSDPreferences {
  return {
    // Preserve validated preference keys that do not need custom merge logic.
    // The explicit fields below still own defaults, arrays, and deep merges.
    ...base,
    ...override,
    version: override.version ?? base.version,
    mode: override.mode ?? base.mode,
    always_use_skills: mergeStringLists(base.always_use_skills, override.always_use_skills),
    prefer_skills: mergeStringLists(base.prefer_skills, override.prefer_skills),
    avoid_skills: mergeStringLists(base.avoid_skills, override.avoid_skills),
    skill_rules: [...(base.skill_rules ?? []), ...(override.skill_rules ?? [])],
    custom_instructions: mergeStringLists(base.custom_instructions, override.custom_instructions),
    models: { ...(base.models ?? {}), ...(override.models ?? {}) },
    thinking: (base.thinking || override.thinking)
      ? { ...(base.thinking ?? {}), ...(override.thinking ?? {}) }
      : undefined,
    skill_discovery: override.skill_discovery ?? base.skill_discovery,
    skill_staleness_days: override.skill_staleness_days ?? base.skill_staleness_days,
    auto_supervisor: { ...(base.auto_supervisor ?? {}), ...(override.auto_supervisor ?? {}) },
    uat_dispatch: override.uat_dispatch ?? base.uat_dispatch,
    unique_milestone_ids: override.unique_milestone_ids ?? base.unique_milestone_ids,
    budget_ceiling: override.budget_ceiling ?? base.budget_ceiling,
    budget_enforcement: override.budget_enforcement ?? base.budget_enforcement,
    context_pause_threshold: override.context_pause_threshold ?? base.context_pause_threshold,
    notifications: (base.notifications || override.notifications)
      ? { ...(base.notifications ?? {}), ...(override.notifications ?? {}) }
      : undefined,
    cmux: (base.cmux || override.cmux)
      ? { ...(base.cmux ?? {}), ...(override.cmux ?? {}) }
      : undefined,
    remote_questions: override.remote_questions
      ? { ...(base.remote_questions ?? {}), ...override.remote_questions }
      : base.remote_questions,
    git: (base.git || override.git)
      ? { ...(base.git ?? {}), ...(override.git ?? {}) }
      : undefined,
    post_unit_hooks: mergePostUnitHooks(base.post_unit_hooks, override.post_unit_hooks),
    pre_dispatch_hooks: mergePreDispatchHooks(base.pre_dispatch_hooks, override.pre_dispatch_hooks),
    planning_subagent_registry: mergePlanningSubagentRegistry(
      base.planning_subagent_registry,
      override.planning_subagent_registry,
    ),
    planning_subagents: mergePlanningSubagents(base.planning_subagents, override.planning_subagents),
    dynamic_routing: (base.dynamic_routing || override.dynamic_routing)
      ? { ...(base.dynamic_routing ?? {}), ...(override.dynamic_routing ?? {}) } as DynamicRoutingConfig
      : undefined,
    disabled_model_providers: mergeStringLists(
      base.disabled_model_providers,
      override.disabled_model_providers,
    ),
    uok: (base.uok || override.uok)
      ? {
          enabled: override.uok?.enabled ?? base.uok?.enabled,
          legacy_fallback: (base.uok?.legacy_fallback || override.uok?.legacy_fallback)
            ? { ...(base.uok?.legacy_fallback ?? {}), ...(override.uok?.legacy_fallback ?? {}) }
            : undefined,
          gates: (base.uok?.gates || override.uok?.gates)
            ? { ...(base.uok?.gates ?? {}), ...(override.uok?.gates ?? {}) }
            : undefined,
          model_policy: (base.uok?.model_policy || override.uok?.model_policy)
            ? { ...(base.uok?.model_policy ?? {}), ...(override.uok?.model_policy ?? {}) }
            : undefined,
          execution_graph: (base.uok?.execution_graph || override.uok?.execution_graph)
            ? { ...(base.uok?.execution_graph ?? {}), ...(override.uok?.execution_graph ?? {}) }
            : undefined,
          gitops: (base.uok?.gitops || override.uok?.gitops)
            ? { ...(base.uok?.gitops ?? {}), ...(override.uok?.gitops ?? {}) }
            : undefined,
          audit_unified: (base.uok?.audit_unified || override.uok?.audit_unified)
            ? { ...(base.uok?.audit_unified ?? {}), ...(override.uok?.audit_unified ?? {}) }
            : undefined,
          plan_v2: (base.uok?.plan_v2 || override.uok?.plan_v2)
            ? { ...(base.uok?.plan_v2 ?? {}), ...(override.uok?.plan_v2 ?? {}) }
            : undefined,
        }
      : undefined,
    token_profile: override.token_profile ?? base.token_profile,
    phases: (base.phases || override.phases)
      ? { ...(base.phases ?? {}), ...(override.phases ?? {}) }
      : undefined,
    parallel: (base.parallel || override.parallel)
      ? { ...(base.parallel ?? {}), ...(override.parallel ?? {}) } as import("./types.js").ParallelConfig
      : undefined,
    verification_commands: mergeStringLists(base.verification_commands, override.verification_commands),
    verification_auto_fix: override.verification_auto_fix ?? base.verification_auto_fix,
    verification_max_retries: override.verification_max_retries ?? base.verification_max_retries,
    verification_timeout_ms: override.verification_timeout_ms ?? base.verification_timeout_ms,
    verification_source_exclude_paths: mergeStringLists(
      base.verification_source_exclude_paths,
      override.verification_source_exclude_paths,
    ),
    enhanced_verification: override.enhanced_verification ?? base.enhanced_verification,
    enhanced_verification_pre: override.enhanced_verification_pre ?? base.enhanced_verification_pre,
    enhanced_verification_post: override.enhanced_verification_post ?? base.enhanced_verification_post,
    enhanced_verification_strict: override.enhanced_verification_strict ?? base.enhanced_verification_strict,
    search_provider: override.search_provider ?? base.search_provider,
    context_selection: override.context_selection ?? base.context_selection,
    auto_visualize: override.auto_visualize ?? base.auto_visualize,
    auto_report: override.auto_report ?? base.auto_report,
    github: (base.github || override.github)
      ? { ...(base.github ?? {}), ...(override.github ?? {}) } as import("../github-sync/types.js").GitHubSyncConfig
      : undefined,
    experimental: (base.experimental || override.experimental)
      ? { ...(base.experimental ?? {}), ...(override.experimental ?? {}) }
      : undefined,
    service_tier: override.service_tier ?? base.service_tier,
    forensics_dedup: override.forensics_dedup ?? base.forensics_dedup,
    show_token_cost: override.show_token_cost ?? base.show_token_cost,
    min_request_interval_ms: override.min_request_interval_ms ?? base.min_request_interval_ms,
    codebase: (base.codebase || override.codebase)
      ? {
          ...(base.codebase ?? {}),
          ...(override.codebase ?? {}),
          // Merge exclude_patterns arrays rather than overriding
          exclude_patterns: [
            ...((base.codebase?.exclude_patterns) ?? []),
            ...((override.codebase?.exclude_patterns) ?? []),
          ].filter(Boolean),
        }
      : undefined,
    slice_parallel: (base.slice_parallel || override.slice_parallel)
      ? { ...(base.slice_parallel ?? {}), ...(override.slice_parallel ?? {}) }
      : undefined,
    language: override.language ?? base.language,
    planning_depth: override.planning_depth ?? base.planning_depth,
    workspace: override.workspace ?? base.workspace,
  };
}

function mergeStringLists(base?: unknown, override?: unknown): string[] | undefined {
  const merged = [
    ...normalizeStringArray(base),
    ...normalizeStringArray(override),
  ]
    .map((item) => item.trim())
    .filter(Boolean);
  return merged.length > 0 ? Array.from(new Set(merged)) : undefined;
}

function mergePostUnitHooks(
  base?: PostUnitHookConfig[],
  override?: PostUnitHookConfig[],
): PostUnitHookConfig[] | undefined {
  if (!base?.length && !override?.length) return undefined;
  const merged = [...(base ?? [])];
  for (const hook of override ?? []) {
    // Override hooks with same name replace base hooks
    const idx = merged.findIndex(h => h.name === hook.name);
    if (idx >= 0) {
      merged[idx] = hook;
    } else {
      merged.push(hook);
    }
  }
  return merged.length > 0 ? merged : undefined;
}

function mergePreDispatchHooks(
  base?: PreDispatchHookConfig[],
  override?: PreDispatchHookConfig[],
): PreDispatchHookConfig[] | undefined {
  if (!base?.length && !override?.length) return undefined;
  const merged = [...(base ?? [])];
  for (const hook of override ?? []) {
    const idx = merged.findIndex(h => h.name === hook.name);
    if (idx >= 0) {
      merged[idx] = hook;
    } else {
      merged.push(hook);
    }
  }
  return merged.length > 0 ? merged : undefined;
}

function mergePlanningSubagents(
  base?: GSDPreferences["planning_subagents"],
  override?: GSDPreferences["planning_subagents"],
): GSDPreferences["planning_subagents"] | undefined {
  if (!base && !override) return undefined;
  const merged: NonNullable<GSDPreferences["planning_subagents"]> = {};
  const unitTypes = new Set([
    ...Object.keys(base ?? {}),
    ...Object.keys(override ?? {}),
  ]);

  for (const unitType of unitTypes) {
    const allowed = mergeStringLists(
      base?.[unitType as keyof NonNullable<GSDPreferences["planning_subagents"]>]?.allowed,
      override?.[unitType as keyof NonNullable<GSDPreferences["planning_subagents"]>]?.allowed,
    );
    if (allowed?.length) {
      merged[unitType as keyof NonNullable<GSDPreferences["planning_subagents"]>] = { allowed };
    }
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergePlanningSubagentRegistry(
  base?: GSDPreferences["planning_subagent_registry"],
  override?: GSDPreferences["planning_subagent_registry"],
): GSDPreferences["planning_subagent_registry"] | undefined {
  if (!base && !override) return undefined;
  const merged = { ...(base ?? {}), ...(override ?? {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

// ─── System Prompt Rendering ──────────────────────────────────────────────────

export function renderPreferencesForSystemPrompt(
  preferences: GSDPreferences,
  resolutions?: Map<string, SkillResolution>,
  options?: { includeResolvedPaths?: boolean },
): string {
  const validated = validatePreferences(preferences);
  const lines: string[] = ["## GSD Skill Preferences"];
  const includeResolvedPaths = options?.includeResolvedPaths ?? true;

  if (validated.errors.length > 0) {
    lines.push("- Validation: some preference values were ignored because they were invalid.");
  }
  for (const warning of validated.warnings) {
    lines.push(`- Deprecation: ${warning}`);
  }

  preferences = validated.preferences;

  lines.push(
    "- Treat these as explicit skill-selection policy for GSD work.",
    "- If a listed skill exists and is relevant, load and follow it instead of treating it as a vague suggestion.",
    "- Current user instructions still override these defaults.",
  );

  const fmt = (ref: string) => {
    if (!resolutions) return ref;
    if (!includeResolvedPaths) {
      const resolution = resolutions.get(ref);
      if (!resolution || resolution.method === "unresolved") {
        return `${ref} (⚠ not found — check skill name or path)`;
      }
      return ref;
    }
    return formatSkillRef(ref, resolutions);
  };

  if (preferences.always_use_skills && preferences.always_use_skills.length > 0) {
    lines.push("- Always use these skills when relevant:");
    for (const skill of preferences.always_use_skills) {
      lines.push(`  - ${fmt(skill)}`);
    }
  }

  if (preferences.prefer_skills && preferences.prefer_skills.length > 0) {
    lines.push("- Prefer these skills when relevant:");
    for (const skill of preferences.prefer_skills) {
      lines.push(`  - ${fmt(skill)}`);
    }
  }

  if (preferences.avoid_skills && preferences.avoid_skills.length > 0) {
    lines.push("- Avoid these skills unless clearly needed:");
    for (const skill of preferences.avoid_skills) {
      lines.push(`  - ${fmt(skill)}`);
    }
  }

  if (preferences.skill_rules && preferences.skill_rules.length > 0) {
    lines.push("- Situational rules:");
    for (const rule of preferences.skill_rules) {
      lines.push(`  - When ${rule.when}:`);
      if (rule.use && rule.use.length > 0) {
        lines.push(`    - use: ${rule.use.map(fmt).join(", ")}`);
      }
      if (rule.prefer && rule.prefer.length > 0) {
        lines.push(`    - prefer: ${rule.prefer.map(fmt).join(", ")}`);
      }
      if (rule.avoid && rule.avoid.length > 0) {
        lines.push(`    - avoid: ${rule.avoid.map(fmt).join(", ")}`);
      }
    }
  }

  if (preferences.custom_instructions && preferences.custom_instructions.length > 0) {
    lines.push("- Additional instructions:");
    for (const instruction of preferences.custom_instructions) {
      lines.push(`  - ${instruction}`);
    }
  }

  if (preferences.language) {
    const safeLang = preferences.language.replace(/[\r\n]/g, " ").slice(0, 50);
    lines.push(`- Language: Always respond in ${safeLang}.`);
  }

  return lines.join("\n");
}

/**
 * Render a compact response-language directive for injection into dispatched
 * prompt *content* (discuss/QA and auto-execution unit prompts).
 *
 * The main session's system prompt already carries the full GSD Skill
 * Preferences block (including language) via `before_agent_start`, but
 * discuss/QA turns and auto-execution units are dispatched as separate
 * turns/sessions whose prompts are assembled here — without that block — so the
 * configured language never reaches them (#1210). Injecting this directive into
 * the dispatched prompt content makes the `language` preference effective across
 * both guided and auto workflows.
 *
 * Returns "" when no language is configured.
 */
export function renderLanguageDirectiveForPrompt(preferences: GSDPreferences | undefined): string {
  if (!preferences?.language) return "";
  const safeLang = preferences.language.replace(/[\r\n]/g, " ").slice(0, 50);
  return `## Response Language\n\nAlways respond in ${safeLang} — questions, explanations, and summaries.`;
}

// ─── Hook Resolution ──────────────────────────────────────────────────────────

/**
 * Resolve enabled post-unit hooks from effective preferences.
 * Returns an empty array when no hooks are configured.
 */
export function resolvePostUnitHooks(basePath?: string): PostUnitHookConfig[] {
  const prefs = loadEffectiveGSDPreferences(basePath);
  return (prefs?.preferences.post_unit_hooks ?? [])
    .filter(h => h.enabled !== false);
}

/**
 * Resolve enabled pre-dispatch hooks from effective preferences.
 * Returns an empty array when no hooks are configured.
 */
export function resolvePreDispatchHooks(basePath?: string): PreDispatchHookConfig[] {
  const prefs = loadEffectiveGSDPreferences(basePath);
  return (prefs?.preferences.pre_dispatch_hooks ?? [])
    .filter(h => h.enabled !== false);
}

// ─── Isolation & Parallel ─────────────────────────────────────────────────────

/**
 * Resolve the discussion question mode from preferences (#2979).
 * Returns "dialog" (default) or "chat".
 *
 * Default is "dialog" so discussion behavior is unchanged unless the user
 * explicitly opts into plain-chat interviews. "chat" only changes what the
 * discuss prompts ask for and how long a discussion stays open — it never
 * touches the tool surface, so the workflow-MCP readiness check keeps passing.
 */
export function getDiscussionQuestionMode(basePath?: string): "dialog" | "chat" {
  return loadEffectiveGSDPreferences(basePath)?.preferences?.discussion?.question_mode === "chat"
    ? "chat"
    : "dialog";
}

/**
 * Resolve the effective git isolation mode from preferences.
 * Returns "none" (default), "worktree", or "branch".
 *
 * Default is "none" so GSD works out of the box without preferences.md.
 * Worktree isolation requires explicit opt-in because it depends on git
 * branch infrastructure that must be set up before use.
 */
export function getIsolationMode(basePath?: string): "none" | "worktree" | "branch" {
  const prefs = loadEffectiveGSDPreferences(basePath)?.preferences?.git;
  if (prefs?.isolation === "worktree") {
    if (basePath && nativeIsRepo(basePath) && !nativeHasCommittedHead(basePath)) return "none";
    return "worktree";
  }
  if (prefs?.isolation === "branch") return "branch";
  return "none"; // default — no isolation, work on current branch
}

/**
 * Resolve the isolation mode a unit actually runs under. A session whose
 * worktree isolation has degraded (worktree creation failed) falls back to
 * the milestone branch in the project root, so configured "worktree" becomes
 * effective "branch". A stranded-work recovery session likewise runs under
 * the adopted mode (`strandedRecoveryIsolationMode`) rather than the
 * configured one until the recovered milestone merges — adopting the
 * milestone branch in the project root is intentional, not degraded.
 */
export function resolveEffectiveUnitIsolationMode(
  configuredMode: ReturnType<typeof getIsolationMode>,
  isolationDegraded: boolean,
  strandedRecoveryIsolationMode: "worktree" | "branch" | null = null,
): ReturnType<typeof getIsolationMode> {
  if (configuredMode === "worktree" && isolationDegraded) return "branch";
  return strandedRecoveryIsolationMode ?? configuredMode;
}

export function resolveParallelConfig(prefs: GSDPreferences | undefined): import("./types.js").ParallelConfig {
  return {
    enabled: prefs?.parallel?.enabled ?? false,
    max_workers: Math.max(1, Math.min(4, prefs?.parallel?.max_workers ?? 2)),
    budget_ceiling: prefs?.parallel?.budget_ceiling,
    merge_strategy: prefs?.parallel?.merge_strategy ?? "per-milestone",
    auto_merge: prefs?.parallel?.auto_merge ?? "confirm",
    worker_model: prefs?.parallel?.worker_model,
  };
}
