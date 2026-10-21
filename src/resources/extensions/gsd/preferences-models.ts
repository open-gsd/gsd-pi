/**
 * Model-related preferences: resolution, fallbacks, profile defaults, and routing.
 *
 * Contains all logic for resolving model configurations from preferences,
 * including per-phase model selection, fallback chains, token profiles,
 * and dynamic routing configuration.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getProviders } from "@gsd/pi-ai";
import { gsdHome } from "./gsd-home.js";
import type { DynamicRoutingConfig } from "./model-router.js";
import { canonicalModelForTier, defaultRoutingConfig, resolveModelForTier } from "./model-router.js";
import type { ComplexityTier } from "./complexity-classifier.js";
import type { TokenProfile, InlineLevel } from "./types.js";

import type {
  GSDPreferences,
  GSDModelConfigV2,
  GSDPhaseModelConfig,
  GSDThinkingLevel,
  GSDModelPhaseKey,
  GSDThinkingConfig,
  ResolvedModelConfig,
  ResolvedAutoSupervisorConfig,
} from "./preferences-types.js";
import { clearGSDPreferencesCache, loadEffectiveGSDPreferences, getGlobalGSDPreferencesPath } from "./preferences.js";
import { getUnitPhaseChain } from "./unit-registry.js";

// Re-export types so existing consumers of ./preferences-models.js keep working
export type { GSDPhaseModelConfig, GSDModelConfig, GSDModelConfigV2, ResolvedModelConfig } from "./preferences-types.js";

type ProviderModelRegistry = {
  getAll?: () => ReadonlyArray<{ provider: string }>;
  getAvailable?: () => ReadonlyArray<{ provider: string }>;
  getAllWithDiscovered?: () => ReadonlyArray<{ provider: string }>;
};

/**
 * First-party providers shipped as bundled extensions that delegate to a
 * vendor CLI (`authMode: "externalCli"`). They are registered into the live
 * model registry at runtime, so they are absent from the generated `@gsd/pi-ai`
 * catalog (`getProviders()`), but they are NOT custom: `PREFERENCES.md` can
 * route to them, so they must defer to `PREFERENCES.md` like any other built-in
 * provider. Without this exclusion the registry check below would classify the
 * default `claude-code` provider (and the other CLI providers) as custom and
 * silently skip `PREFERENCES.md` in auto-mode (#801, extends #4122).
 *
 * Kept in sync with the `registerProvider(...)` calls in the bundled CLI
 * extensions (claude-code-cli, cursor-cli, google-cli). Names are lowercase for
 * direct comparison against normalized provider ids.
 */
const BUILTIN_EXTENSION_PROVIDERS: ReadonlySet<string> = new Set([
  "claude-code",
  "cursor-agent",
  "google-gemini-cli",
  "google-antigravity",
]);

/**
 * Resolve which model ID to use for a given auto-mode unit type.
 * Returns undefined if no model preference is set for this unit type.
 */
export function resolveModelForUnit(unitType: string): string | undefined {
  const resolved = resolveModelWithFallbacksForUnit(unitType);
  return resolved?.primary;
}

/**
 * Ordered phase-bucket chain a unit type resolves against, most-specific
 * first. The first chain entry with a configured value wins; later entries
 * are siblings the unit falls back to (e.g. `discuss → planning`).
 *
 * Single source of truth for the unit-type → phase mapping, shared by model
 * resolution (`resolveModelWithFallbacksForUnit`) and thinking resolution
 * (`resolveThinkingLevelForUnit`) so the two never drift (ADR-026).
 */
export function phaseChainForUnit(unitType: string): GSDModelPhaseKey[] | undefined {
  // Unit types declare their chain on their Unit Descriptor (ADR-033).
  const declared = getUnitPhaseChain(unitType);
  if (declared) return [...declared];
  // Dispatch types without a Unit Descriptor.
  if (unitType === "worktree-merge") return ["completion"];
  // Subagent unit types (e.g., "subagent", "subagent/scout")
  if (unitType === "subagent" || unitType.startsWith("subagent/")) {
    return ["subagent"];
  }
  return undefined;
}

/**
 * Find the phase bucket whose `models` entry wins the chain for a unit, plus
 * that entry. Returns undefined when no phase in the chain is configured.
 */
function resolveWinningPhase(
  models: GSDModelConfigV2 | undefined,
  chain: GSDModelPhaseKey[],
): { phase: GSDModelPhaseKey; config: string | GSDPhaseModelConfig } | undefined {
  if (!models) return undefined;
  for (const key of chain) {
    const config = models[key];
    // Falsy check (not `!= null`) so an empty-string model is treated as
    // unconfigured and the chain falls through — matches the pre-refactor
    // switch, which bailed via `if (!phaseConfig)`.
    if (!config) continue;
    // An object entry only "wins" if it provides a usable model. A model-less
    // object (e.g. `{ provider: x }`, or `{}` left after stripping an invalid
    // `thinking`) must not shadow sibling fallback or yield `{ primary: undefined }`.
    if (typeof config === "object" && !config.model) continue;
    return { phase: key, config };
  }
  return undefined;
}

/**
 * Normalize a single model field into a {@link ResolvedModelConfig}.
 *
 * Accepts either the legacy bare-string form or the extended object form
 * (`{ model, provider?, fallbacks? }`). This is the shared normalization used
 * for phase buckets so sibling single-model fields — `post_unit_hooks[].model`,
 * `auto_supervisor.model`, and `reactive_execution.subagent_model` — honor
 * `fallbacks[]` identically rather than accepting a bare string only (#1229).
 *
 * Returns undefined for an unset, blank, or model-less field.
 */
export function normalizeModelFieldConfig(
  field: string | GSDPhaseModelConfig | undefined,
): ResolvedModelConfig | undefined {
  if (!field) return undefined;
  if (typeof field === "string") {
    return field.trim() ? { primary: field, fallbacks: [] } : undefined;
  }
  if (!field.model) return undefined;
  // When provider is explicitly set, prepend it to the model ID so the
  // resolution code in auto.ts can do an explicit provider match.
  const primary = field.provider && !field.model.includes("/")
    ? `${field.provider}/${field.model}`
    : field.model;
  // Carry the per-field `thinking` sub-field through so the dispatch site can
  // prefer it over the session/floor level, mirroring phase-inline thinking
  // (#1269). `undefined` is preserved as absent so behavior is unchanged.
  return {
    primary,
    fallbacks: field.fallbacks ?? [],
    ...(field.thinking ? { thinking: field.thinking } : {}),
  };
}

/**
 * Resolve model and fallbacks for a given auto-mode unit type.
 * Returns the primary model and ordered fallbacks, or undefined if not configured.
 *
 * Supports both legacy string format and extended object format:
 * - Legacy: `planning: claude-opus-4-6`
 * - Extended: `planning: { model: claude-opus-4-6, fallbacks: [glm-5, minimax-m2.5] }`
 *
 * Hook unit types (`hook/<name>`) resolve against the matching
 * `post_unit_hooks[]` entry's `model` field so hook sessions honor the same
 * `fallbacks[]` chain as phase buckets — the recovery path can then switch to
 * a fallback provider instead of hard-failing (and potentially pausing) the
 * run on a transient provider trip (#1229).
 *
 * The synthetic `supervisor` unit type resolves against `auto_supervisor.model`
 * for supervisor interventions (wrap-up warnings, timeout recovery).
 */
export function resolveModelWithFallbacksForUnit(
  unitType: string,
  basePath?: string,
  availableModelIds?: string[],
  preferredModelId?: string,
  skipProfileDefaults = false,
): ResolvedModelConfig | undefined {
  const loadOpts = {
    ...(availableModelIds !== undefined ? { availableModelIds } : {}),
    ...(preferredModelId !== undefined ? { preferredModelId } : {}),
    ...(skipProfileDefaults ? { skipProfileDefaults: true } : {}),
  };
  const prefs = loadEffectiveGSDPreferences(basePath, loadOpts);

  // Supervisor interventions resolve against `auto_supervisor.model` (#1229).
  if (unitType === "supervisor") {
    return normalizeModelFieldConfig(prefs?.preferences?.auto_supervisor?.model);
  }

  // Hook sessions resolve against their own `post_unit_hooks[].model` field,
  // which now shares the phase-bucket object form (#1229).
  if (unitType.startsWith("hook/")) {
    const hookName = unitType.slice("hook/".length);
    const hooks = prefs?.preferences?.post_unit_hooks;
    const hook = Array.isArray(hooks) ? hooks.find((h) => h.name === hookName) : undefined;
    return normalizeModelFieldConfig(hook?.model);
  }

  const chain = phaseChainForUnit(unitType);
  if (!chain) return undefined;
  const winner = resolveWinningPhase(prefs?.preferences?.models as GSDModelConfigV2 | undefined, chain);
  if (!winner) return undefined;
  return normalizeModelFieldConfig(winner.config);
}

/**
 * Resolve the explicitly configured reasoning effort for a unit type (ADR-026).
 *
 * Thinking travels with the model. The chain is walked most-specific-first up to
 * and including the phase whose model won; at each level inline
 * `models.<phase>.thinking` is preferred, then the same phase's `thinking` block
 * entry. This means:
 * - a more-specific block key (`thinking.execution_simple`) surfaces even when
 *   the model only resolves on a less-specific sibling (`models.execution`);
 * - inline thinking is honored even on a model-less `models.<phase>` entry
 *   (e.g. `{ thinking: "high" }` with no `model`);
 * - a unit that claimed its own model bucket never borrows a *less*-specific
 *   sibling's thinking (the walk stops at the winning phase).
 * When no model is configured anywhere in the chain, the walk spans the full
 * chain so inline thinking and the `thinking` block both resolve on their own
 * sibling chain.
 *
 * Returns undefined when nothing explicit is configured — the dispatch path
 * then falls back to the session/default level and applies the code-writing
 * floor. Session level, defaults, the floor, and capability clamping are NOT
 * applied here.
 */
export function resolveThinkingLevelForUnit(
  unitType: string,
  basePath?: string,
  availableModelIds?: string[],
): GSDThinkingLevel | undefined {
  // Single-field configs — `auto_supervisor.model` and `post_unit_hooks[].model`
  // — carry their own inline `thinking` on the object model form and have no
  // phase-bucket chain, so the walk below never covers them. Resolve their
  // per-field level directly (#1269).
  if (unitType === "supervisor" || unitType.startsWith("hook/")) {
    return resolveModelWithFallbacksForUnit(unitType, basePath, availableModelIds)?.thinking;
  }

  const loadOpts = availableModelIds !== undefined ? { availableModelIds } : undefined;
  const prefs = loadEffectiveGSDPreferences(basePath, loadOpts)?.preferences;
  if (!prefs) return undefined;
  const chain = phaseChainForUnit(unitType);
  if (!chain) return undefined;

  const models = prefs.models as GSDModelConfigV2 | undefined;
  const block = prefs.thinking as GSDThinkingConfig | undefined;

  // Walk most-specific-first, up to and including the winning model phase (or
  // the full chain when no model is configured), checking inline then block.
  const winner = resolveWinningPhase(models, chain);
  const limit = winner ? chain.indexOf(winner.phase) + 1 : chain.length;
  for (let i = 0; i < limit; i++) {
    const key = chain[i];
    const entry = models?.[key];
    if (typeof entry === "object" && entry?.thinking) return entry.thinking; // inline (incl. model-less)
    const blockLevel = block?.[key];
    if (blockLevel) return blockLevel;                                       // block
  }
  return undefined;
}

/**
 * Resolve the default session model from GSD preferences.
 *
 * Used at auto-mode bootstrap to override the session model that was
 * determined by settings.json (defaultProvider/defaultModel).  When
 * PREFERENCES.md (or project preferences) configures an `execution` model
 * we treat that as the session default.  Falls back through execution →
 * planning → first configured model.
 *
 * Accepts an optional `sessionProvider` for bare model IDs that don't
 * include an explicit provider prefix (e.g. `gpt-5.4` instead of
 * `openai-codex/gpt-5.4`).  When a bare ID is found and sessionProvider
 * is available, the session provider is used.  Without sessionProvider,
 * bare IDs are still returned with provider set to the bare ID itself
 * so downstream resolution (resolveModelId) can match it. Accepts an optional
 * `sessionModelId` so token-profile defaults can preserve the selected model
 * before auto-mode captures its start snapshot.
 *
 * Returns `{ provider, id }` or `undefined` if no model preference is
 * configured.
 */
export function resolveDefaultSessionModel(
  sessionProvider?: string,
  basePath?: string,
  availableModelIds?: string[],
  sessionModelId?: string,
): { provider: string; id: string } | undefined {
  const preferredModelId = sessionModelId && sessionProvider
    ? `${sessionProvider}/${sessionModelId}`
    : sessionModelId;
  const loadOpts = availableModelIds !== undefined || preferredModelId !== undefined
    ? { availableModelIds, preferredModelId }
    : undefined;
  const prefs = loadEffectiveGSDPreferences(basePath, loadOpts);
  const models = prefs?.preferences?.models;
  if (!models) return undefined;

  const m = models as GSDModelConfigV2;

  // Priority: execution → planning → first configured value
  const candidates: Array<string | GSDPhaseModelConfig | undefined> = [
    m.execution,
    m.planning,
    m.research,
    m.discuss,
    m.completion,
    m.validation,
    m.subagent,
  ];

  for (const cfg of candidates) {
    if (!cfg) continue;

    // Normalize to provider + id from the various config shapes
    let provider: string | undefined;
    let id: string;

    if (typeof cfg === "string") {
      const slashIdx = cfg.indexOf("/");
      if (slashIdx !== -1) {
        provider = cfg.slice(0, slashIdx);
        id = cfg.slice(slashIdx + 1);
      } else {
        // Bare model ID (e.g. "gpt-5.4") — use session provider as context
        provider = sessionProvider;
        id = cfg;
      }
    } else {
      // Object config: { model, provider?, fallbacks? }
      if (cfg.provider) {
        provider = cfg.provider;
      } else if (cfg.model.includes("/")) {
        const slashIdx = cfg.model.indexOf("/");
        provider = cfg.model.slice(0, slashIdx);
        id = cfg.model.slice(slashIdx + 1);
        return { provider, id };
      } else {
        provider = sessionProvider;
      }
      id = cfg.model;
    }

    if (provider && id) {
      return { provider, id };
    }
  }

  return undefined;
}

/**
 * Returns true if `provider` is a custom provider. Custom providers may be
 * declared in `models.json` or registered dynamically by a Pi extension.
 *
 * Used by auto-mode bootstrap to decide whether the session model
 * (set via `/gsd model`) should override `PREFERENCES.md`.  Custom providers
 * are never reachable from `PREFERENCES.md` (which only knows built-in
 * providers), so when the user has explicitly selected one, it must take
 * priority — otherwise auto-mode tries to start the built-in provider from
 * PREFERENCES.md and fails with "Not logged in · Please run /login" (#4122).
 *
 * Reads models.json directly with a lightweight JSON parse, then checks the
 * live model registry for extension-registered providers that are not in the
 * generated built-in provider catalog (`getProviders()`) and not one of the
 * bundled external-CLI providers (`BUILTIN_EXTENSION_PROVIDERS`, e.g.
 * `claude-code`), which register at runtime but are still built-in.  Falls back
 * to `~/.pi/agent/models.json` for parity with `resolveModelsJsonPath()`. Any
 * read, parse, or registry error yields `false` (treat as not-custom) so
 * bootstrap stays non-fatal.
 */
export function isCustomProvider(provider: string | undefined, registry?: ProviderModelRegistry): boolean {
  if (!provider) return false;
  const candidates = [
    join(gsdHome(), "agent", "models.json"),
    join(homedir(), ".pi", "agent", "models.json"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw) as { providers?: Record<string, unknown> };
      if (parsed?.providers && Object.prototype.hasOwnProperty.call(parsed.providers, provider)) {
        return true;
      }
    } catch {
      // Ignore — malformed models.json must not break bootstrap.
    }
  }
  try {
    const normalizedProvider = provider.trim().toLowerCase();
    if (!normalizedProvider) return false;
    if (BUILTIN_EXTENSION_PROVIDERS.has(normalizedProvider)) return false;
    const builtInProviders = new Set(getProviders().map((p) => p.toLowerCase()));
    if (builtInProviders.has(normalizedProvider)) return false;
    const registryModels =
      registry?.getAllWithDiscovered?.()
      ?? registry?.getAll?.()
      ?? registry?.getAvailable?.()
      ?? [];
    return registryModels.some((m) => m.provider.toLowerCase() === normalizedProvider);
  } catch {
    return false;
  }
}

/**
 * Determines the next fallback model to try when the current model fails.
 * If the current model is not in the configured list, returns the primary model.
 * If the current model is the last in the list, returns undefined (exhausted).
 */
export function getNextFallbackModel(
  currentModelId: string | undefined,
  modelConfig: ResolvedModelConfig,
): string | undefined {
  const modelsToTry = [modelConfig.primary, ...modelConfig.fallbacks];

  if (!currentModelId) {
    return modelsToTry[0];
  }

  let foundCurrent = false;
  for (let i = 0; i < modelsToTry.length; i++) {
    const mId = modelsToTry[i];
    // Check for exact match or provider/model suffix match
    if (mId === currentModelId || (mId.includes("/") && mId.endsWith(`/${currentModelId}`))) {
      foundCurrent = true;
      return modelsToTry[i + 1]; // Return the next one, or undefined if at the end
    }
  }

  // If the current model wasn't in our preference list, default to starting the sequence
  if (!foundCurrent) {
    return modelsToTry[0];
  }
}

/**
 * Detect whether an error message indicates a transient network error
 * (worth retrying the same model) vs a permanent provider error
 * (auth failure, quota exceeded, etc. -- should fall back immediately).
 */
export function isTransientNetworkError(errorMsg: string): boolean {
  if (!errorMsg) return false;
  const hasNetworkSignal = /network|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|fetch failed|connection.*reset|dns/i.test(errorMsg);
  const hasPermanentSignal = /auth|unauthorized|forbidden|invalid.*key|quota|billing/i.test(errorMsg);
  return hasNetworkSignal && !hasPermanentSignal;
}

/**
 * Validate a model ID string.
 * Returns true if the ID looks like a valid model identifier.
 */
export function validateModelId(modelId: string): boolean {
  if (!modelId || typeof modelId !== "string") return false;
  const trimmed = modelId.trim();
  if (trimmed.length === 0 || trimmed.length > 256) return false;
  // Allow alphanumeric, hyphens, underscores, dots, slashes, colons
  return /^[a-zA-Z0-9\-_./:]+$/.test(trimmed);
}

/**
 * Update the models section of the global GSD preferences file.
 * Performs a safe read-modify-write: reads current content, updates the models
 * YAML block, and writes back. Creates the file if it doesn't exist.
 */
export function updatePreferencesModels(models: GSDModelConfigV2): void {
  const prefsPath = getGlobalGSDPreferencesPath();

  let content = "";
  if (existsSync(prefsPath)) {
    content = readFileSync(prefsPath, "utf-8");
  }

  // Build the new models block
  const lines: string[] = ["models:"];
  for (const [phase, value] of Object.entries(models)) {
    if (typeof value === "string") {
      lines.push(`  ${phase}: ${value}`);
    } else if (value && typeof value === "object") {
      const config = value as GSDPhaseModelConfig;
      lines.push(`  ${phase}:`);
      lines.push(`    model: ${config.model}`);
      if (config.provider) {
        lines.push(`    provider: ${config.provider}`);
      }
      if (config.fallbacks && config.fallbacks.length > 0) {
        lines.push(`    fallbacks:`);
        for (const fb of config.fallbacks) {
          lines.push(`      - ${fb}`);
        }
      }
    }
  }
  const modelsBlock = lines.join("\n");

  // Replace existing models block or append
  const modelsRegex = /^models:[\s\S]*?(?=\n[a-z_]|\n*$)/m;
  if (modelsRegex.test(content)) {
    content = content.replace(modelsRegex, modelsBlock);
  } else {
    content = content.trimEnd() + "\n\n" + modelsBlock + "\n";
  }

  writeFileSync(prefsPath, content, "utf-8");
  clearGSDPreferencesCache();
}

/**
 * Resolve the dynamic routing configuration from effective preferences.
 * Returns the merged config with defaults applied.
 */
export function resolveDynamicRoutingConfig(): DynamicRoutingConfig {
  const prefs = loadEffectiveGSDPreferences();
  const configured = prefs?.preferences.dynamic_routing;
  if (!configured) return defaultRoutingConfig();
  return {
    ...defaultRoutingConfig(),
    ...configured,
  };
}

export function resolveAutoSupervisorConfig(): ResolvedAutoSupervisorConfig {
  const prefs = loadEffectiveGSDPreferences();
  const configured = prefs?.preferences.auto_supervisor ?? {};

  const modelConfig = normalizeModelFieldConfig(configured.model);

  return {
    soft_timeout_minutes: configured.soft_timeout_minutes ?? 20,
    idle_timeout_minutes: configured.idle_timeout_minutes ?? 10,
    hard_timeout_minutes: configured.hard_timeout_minutes ?? 30,
    stalled_tool_timeout_minutes: configured.stalled_tool_timeout_minutes ?? 5,
    ...(modelConfig
      ? { model: modelConfig.primary, modelFallbacks: modelConfig.fallbacks }
      : {}),
  };
}

// ─── Token Profile Resolution ─────────────────────────────────────────────

export const VALID_TOKEN_PROFILES = new Set<TokenProfile>(["budget", "balanced", "quality", "burn-max"]);

/** D046: balanced is the implicit profile when `token_profile` is omitted. */
export const DEFAULT_TOKEN_PROFILE: TokenProfile = "balanced";

/**
 * Per-phase tier intentions for each token profile.
 * Profiles express capability tiers, not model IDs. Concrete model
 * resolution happens at runtime via resolveModelForTier() which is
 * provider-agnostic — it picks the best available model at each tier.
 */
const PROFILE_TIER_MAP: Record<TokenProfile, Record<string, ComplexityTier>> = {
  budget: {
    planning: "standard",
    research: "light",
    execution: "standard",
    execution_simple: "light",
    completion: "light",
    subagent: "light",
  },
  balanced: {
    planning: "standard",
    research: "standard",
    execution: "standard",
    execution_simple: "light",
    completion: "light",
    subagent: "light",
  },
  quality: {
    planning: "heavy",
    research: "standard",
    execution: "standard",
    execution_simple: "light",
    completion: "light",
    subagent: "standard",
  },
  // burn-max intentionally omits a tier map: it never writes model defaults
  // (it preserves the user's explicit model selection), so resolveProfileDefaults
  // skips model resolution for this profile.
  "burn-max": {},
};

/**
 * Resolve profile defaults for a given token profile tier.
 * Returns a partial GSDPreferences that is used as the base layer --
 * explicit user preferences always override these defaults.
 *
 * Model IDs are resolved from capability tiers, not hardcoded to any
 * provider. When available models are known (runtime), the resolver picks
 * the best match on the anchor provider (session / auto-start model). Callers
 * scope the available-model list via `modelIdsForProfileResolution` so token
 * profiles do not hop to a cheaper provider (e.g. Gemini Flash) when the user
 * is working on OpenAI or Anthropic. When the selected/session model is known,
 * it is preferred for tiers it can satisfy. When the registry is unavailable
 * (e.g., early startup), falls back to canonical Anthropic model IDs.
 *
 * @param profile           The token profile to resolve
 * @param availableModelIds Optional list of available model IDs for cross-provider resolution.
 *                          Undefined means the registry is unavailable.
 * @param routingConfig     Optional routing config for tier model pins.
 * @param preferredModelId  Optional selected/session model ID to prefer.
 */
export function resolveProfileDefaults(
  profile: TokenProfile,
  availableModelIds?: string[],
  routingConfig: DynamicRoutingConfig = defaultRoutingConfig(),
  preferredModelId?: string,
): Partial<GSDPreferences> {
  // burn-max never writes model defaults — preserve user-selected models.
  // For the other three profiles, derive concrete model IDs from the tier map
  // against the available-model list when the registry is provided. If callers
  // omit the registry entirely, use canonical fallbacks explicitly.
  const tierMap = PROFILE_TIER_MAP[profile];
  const resolveTierModel = (tier: ComplexityTier): string =>
    Array.isArray(availableModelIds) || preferredModelId
      ? resolveModelForTier(tier, availableModelIds ?? [], routingConfig, undefined, preferredModelId)
      : canonicalModelForTier(tier);
  const models: GSDModelConfigV2 | undefined = profile === "burn-max"
    ? undefined
    : {
        planning: resolveTierModel(tierMap.planning),
        research: resolveTierModel(tierMap.research),
        execution: resolveTierModel(tierMap.execution),
        execution_simple: resolveTierModel(tierMap.execution_simple),
        completion: resolveTierModel(tierMap.completion),
        subagent: resolveTierModel(tierMap.subagent),
      };

  switch (profile) {
    case "budget":
      return {
        models,
        phases: {
          skip_research: true,
          skip_reassess: true,
          skip_slice_research: true,
          skip_milestone_validation: true,
        },
      };
    case "balanced":
      return {
        models,
        phases: {
          skip_research: true,
          skip_reassess: true,
          skip_slice_research: true,
        },
      };
    case "quality":
      return {
        models,
        phases: {
          skip_research: true,
          skip_slice_research: true,
          skip_reassess: true,
        },
      };
    case "burn-max":
      return {
        // Quality-first profile: keep user-selected models, disable downgrade routing.
        // Policy constraints still apply at dispatch time.
        dynamic_routing: {
          enabled: false,
        },
        context_selection: "full",
        phases: {
          skip_research: false,
          skip_slice_research: false,
          skip_reassess: false,
          skip_milestone_validation: false,
          reassess_after_slice: true,
        },
      };
  }
}

/**
 * Get the tier intentions for a profile without resolving to model IDs.
 * Useful for display, debugging, and testing.
 */
export function getProfileTierMap(profile: TokenProfile): Record<string, ComplexityTier> {
  return { ...PROFILE_TIER_MAP[profile] };
}

/**
 * Resolve the effective token profile from preferences.
 * Returns "balanced" when no profile is set (D046).
 */
export function resolveEffectiveProfile(): TokenProfile {
  const prefs = loadEffectiveGSDPreferences();
  const profile = prefs?.preferences.token_profile;
  if (profile && VALID_TOKEN_PROFILES.has(profile)) return profile;
  return "balanced";
}

/**
 * Resolve the inline level from the active token profile.
 * budget -> minimal, balanced -> standard, quality/burn-max -> full.
 */
export function resolveInlineLevel(): InlineLevel {
  const profile = resolveEffectiveProfile();
  switch (profile) {
    case "budget": return "minimal";
    case "balanced": return "standard";
    case "quality": return "full";
    case "burn-max": return "full";
  }
}

/**
 * Resolve the context selection mode from the active token profile.
 * budget -> "smart", balanced/quality/burn-max -> "full".
 * Explicit preference always wins.
 */
export function resolveContextSelection(): import("./types.js").ContextSelectionMode {
  const prefs = loadEffectiveGSDPreferences();
  if (prefs?.preferences.context_selection) return prefs.preferences.context_selection;
  const profile = resolveEffectiveProfile();
  return profile === "budget" ? "smart" : "full";
}

/**
 * Resolve the search provider preference from preferences.md.
 * Returns undefined if not configured (caller falls back to existing behavior).
 */
export function resolveSearchProviderFromPreferences(): GSDPreferences["search_provider"] | undefined {
  const prefs = loadEffectiveGSDPreferences();
  return prefs?.preferences.search_provider;
}

/**
 * Resolve provider IDs excluded from model selection/routing.
 * Returns a normalized, de-duplicated list.
 */
export function resolveDisabledModelProvidersFromPreferences(): string[] {
  const prefs = loadEffectiveGSDPreferences();
  const raw = prefs?.preferences.disabled_model_providers;
  if (!Array.isArray(raw)) return [];
  return Array.from(new Set(
    raw
      .map((provider) => provider.trim())
      .filter((provider) => provider.length > 0),
  ));
}
