/**
 * Model selection and dynamic routing for auto-mode unit dispatch.
 * Handles complexity-based routing, model resolution across providers,
 * and fallback chains.
 */

import type { Api, Model, ModelThinkingLevel } from "@gsd/pi-ai";
import { getProviderCapabilities, clampThinkingLevel } from "@gsd/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";
import type { GSDPreferences } from "./preferences.js";
import { resolveModelWithFallbacksForUnit, resolveThinkingLevelForUnit, resolveDynamicRoutingConfig } from "./preferences.js";
import type { ComplexityTier } from "./complexity-classifier.js";
import { classifyUnitComplexity, extractTaskMetadata, tierLabel } from "./complexity-classifier.js";
import { resolveModelForComplexity, escalateTier, getEligibleModels, loadCapabilityOverrides, adjustToolSet, filterToolsForProvider } from "./model-router.js";
import { getLedger, getProjectTotals } from "./metrics.js";
import { unitPhaseLabel } from "./auto-dashboard.js";
import { getSessionModelOverride } from "./session-model-override.js";
import { logWarning } from "./workflow-logger.js";
import { resolveUokFlags } from "./uok/flags.js";
import { modelIdsForProfileResolution, resolveProfileAnchorProvider, resolveDisabledModelProvidersFromPreferences } from "./preferences.js";
import { applyModelPolicyFilter } from "./uok/model-policy.js";
import { isModelBlocked, isModelTemporarilyUnavailable } from "./blocked-models.js";
import { getRequiredWorkflowToolsForAutoUnit, isWorkflowMcpSurfaceTool } from "./workflow-mcp.js";

/**
 * Thrown when the model-policy gate rejects every candidate model for a unit
 * dispatch (#4959 / #4681 / #4850).  The auto-loop catches this specifically
 * to classify the unit as `blocked` rather than counting it as a retryable
 * iteration error — pre-send policy denial is a configuration problem, not a
 * transient runtime failure, so retrying just burns the consecutive-error
 * budget toward a hard stop.
 */
export class ModelPolicyDispatchBlockedError extends Error {
  readonly unitType: string;
  readonly unitId: string;
  readonly reasons: ReadonlyArray<{ provider: string; modelId: string; reason: string }>;
  constructor(
    unitType: string,
    unitId: string,
    reasons: ReadonlyArray<{ provider: string; modelId: string; reason: string }>,
  ) {
    const summary = reasons.length === 0
      ? "no candidate models"
      : reasons
          .slice(0, 4)
          .map((r) => `${r.provider}/${r.modelId} (${r.reason})`)
          .join("; ");
    super(`Model policy denied dispatch for ${unitType}/${unitId} before prompt send. Rejected: ${summary}`);
    this.name = "ModelPolicyDispatchBlockedError";
    this.unitType = unitType;
    this.unitId = unitId;
    this.reasons = reasons;
  }
}

export interface ModelSelectionResult {
  /** Routing metadata for metrics recording */
  routing: { tier: string; modelDowngraded: boolean } | null;
  /** Concrete model applied before dispatch so it can be restored after a fresh session. */
  appliedModel: Model<Api> | null;
  /**
   * Reasoning effort applied for this dispatch after per-phase resolution,
   * floor, and capability clamping (ADR-026). Null when no level was applied
   * (e.g. no start level captured). Surfaced for metrics/telemetry.
   */
  appliedThinkingLevel?: ReturnType<ExtensionAPI["getThinkingLevel"]> | null;
}

const PROVIDER_ALIAS_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [
  ["github-copilot", "copilot"],
];

function providerAliases(provider: string): Set<string> {
  const normalized = provider.toLowerCase();
  for (const group of PROVIDER_ALIAS_GROUPS) {
    if (group.includes(normalized)) {
      return new Set(group);
    }
  }
  return new Set([normalized]);
}

function sameProvider(a: string, b: string): boolean {
  return providerAliases(a).has(b.toLowerCase());
}

function normalizeModelIdToken(modelId: string): string {
  return modelId.trim().toLowerCase();
}

export interface PreferredModelConfig {
  primary: string;
  fallbacks: string[];
  source: "explicit" | "synthesized";
}

// Baseline active-tool set per-`pi` instance, captured the first time
// `selectAndApplyModel` runs against that instance during an auto session
// and re-applied before each subsequent dispatch.  WeakMap so that test
// fakes / disposed sessions are garbage-collected normally.  See
// #4959 / #4681 cross-unit poisoning notes at the call site below.
//
// LIFECYCLE: the baseline is tied to a single auto session, NOT to the
// lifetime of the `pi` instance (which can outlive many auto runs and have
// the user mutate tools between them).  `clearToolBaseline` MUST be called
// at auto start AND auto stop so that a second `/gsd auto` run on the same
// `pi` does not silently restore a stale snapshot from the prior run and
// undo any tool changes the user made between sessions.
const TOOL_BASELINE = new WeakMap<object, string[]>();

/**
 * Drop the captured tool baseline for `pi` so the next `selectAndApplyModel`
 * call re-captures from the live active set.  Wired into `startAuto` and
 * `stopAuto` in `auto.ts` to bound the baseline to a single auto session.
 *
 * Safe to call when no baseline is recorded (no-op).
 */
export function clearToolBaseline(pi: ExtensionAPI | object): void {
  TOOL_BASELINE.delete(pi as unknown as object);
}

/**
 * Return the union of the pre-dispatch baseline tool set and the current live
 * active tools, or just the live tools when no baseline has been recorded yet.
 *
 * Use this instead of `pi.getActiveTools()` anywhere you need the full tool
 * surface for a preflight/routing check that runs BEFORE `selectAndApplyModel`
 * restores the baseline — e.g. in `runDispatch` and `decideNextUnit`.
 *
 * The union is intentional:
 *   - Baseline covers tools that a prior unit's per-provider narrowing (hook
 *     overrides, Groq 128-tool cap, etc.) has removed from the live set.
 *     Those tools will be restored by `selectAndApplyModel` before dispatch, so
 *     dropping them from the preflight check would be a false negative.
 *   - Live set covers tools connected after the baseline was first captured
 *     (e.g. MCP servers attached mid-session or after a paused resume).
 *     Without the live merge, a stale baseline permanently hides newly
 *     connected MCP tools and prevents transport-preflight from clearing on
 *     resume (#477 follow-up).
 */
export function getToolBaselineSnapshot(pi: ExtensionAPI): string[] {
  const live = typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
  const baseline = TOOL_BASELINE.get(pi as unknown as object);
  if (baseline === undefined) return live;
  return [...new Set([...baseline, ...live])];
}

export function getRegisteredToolSnapshot(pi: ExtensionAPI): string[] {
  if (typeof pi.getAllTools !== "function") return getToolBaselineSnapshot(pi);
  const names = pi.getAllTools()
    .map((tool) => tool.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
  return [...new Set(names)];
}

/**
 * Models eligible for the pre-dispatch policy gate. Prefer registry-available
 * models; when that list is empty (common after worktree resume before registry
 * refresh), fall back to the live session / auto-start / pinned models that are
 * still request-ready.
 */
function getRegistryAllModels(registry: ExtensionContext["modelRegistry"]): Model<Api>[] {
  if (typeof registry.getAll === "function") {
    return registry.getAll();
  }
  return registry.getAvailable();
}

function buildModelPolicyCandidates(
  ctx: ExtensionContext,
  autoModeStartModel: { provider: string; id: string } | null,
  sessionModelOverride?: { provider: string; id: string },
): Model<Api>[] {
  const available = ctx.modelRegistry.getAvailable();
  if (available.length > 0) return available;

  const registry = ctx.modelRegistry;
  const all = getRegistryAllModels(registry);
  const candidates: Model<Api>[] = [];
  const seen = new Set<string>();

  const tryAdd = (provider: string | undefined, id: string | undefined) => {
    if (!provider || !id) return;
    const key = `${provider.toLowerCase()}/${id.toLowerCase()}`;
    if (seen.has(key)) return;
    if (!registry.isProviderRequestReady(provider)) return;
    seen.add(key);
    const match = all.find((m) => m.provider === provider && m.id === id);
    if (match) {
      candidates.push(match);
      return;
    }
    if (ctx.model?.provider === provider && ctx.model?.id === id) {
      candidates.push(ctx.model);
    }
  };

  tryAdd(ctx.model?.provider, ctx.model?.id);
  tryAdd(autoModeStartModel?.provider, autoModeStartModel?.id);
  tryAdd(sessionModelOverride?.provider, sessionModelOverride?.id);

  return candidates;
}

/** Include configured primary/fallback IDs from the full registry, not only getAvailable(). */
function augmentModelPolicyCandidates(
  ctx: ExtensionContext,
  candidates: Model<Api>[],
  modelConfig: PreferredModelConfig,
): Model<Api>[] {
  const registry = ctx.modelRegistry;
  const all = getRegistryAllModels(registry);
  const seen = new Set(candidates.map((m) => `${m.provider.toLowerCase()}/${m.id.toLowerCase()}`));
  const augmented = [...candidates];

  const tryAdd = (modelId: string | undefined) => {
    if (!modelId) return;
    const resolved = resolveModelId(modelId, all, ctx.model?.provider);
    if (!resolved) return;
    const key = `${resolved.provider.toLowerCase()}/${resolved.id.toLowerCase()}`;
    if (seen.has(key)) return;
    if (!registry.isProviderRequestReady(resolved.provider)) return;
    seen.add(key);
    augmented.push(resolved);
  };

  tryAdd(modelConfig.primary);
  for (const fallback of modelConfig.fallbacks) tryAdd(fallback);

  return augmented;
}

/** Pi-native tools only — workflow MCP tools use transport checks instead. */
function requiredPiToolsForModelPolicy(unitType: string): string[] {
  return getRequiredWorkflowToolsForAutoUnit(unitType).filter((tool) => !isWorkflowMcpSurfaceTool(tool));
}

function buildPolicyEligibleFallbackOrder(
  ctx: ExtensionContext,
  routingEligibleModels: Model<Api>[],
  autoModeStartModel: { provider: string; id: string } | null,
): Model<Api>[] {
  const ordered: Model<Api>[] = [];
  const seen = new Set<string>();
  const add = (model: Model<Api> | undefined) => {
    if (!model) return;
    const key = `${model.provider.toLowerCase()}/${model.id.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    ordered.push(model);
  };

  add(ctx.model ?? undefined);
  if (autoModeStartModel) {
    add(resolveModelId(
      `${autoModeStartModel.provider}/${autoModeStartModel.id}`,
      routingEligibleModels,
      ctx.model?.provider,
    ));
    add(resolveModelId(autoModeStartModel.id, routingEligibleModels, ctx.model?.provider));
  }
  for (const model of routingEligibleModels) add(model);
  return ordered;
}

function buildModelPolicyBlockReasons(
  policyDenyReasons: Array<{ provider: string; modelId: string; reason: string }>,
  availableModels: Model<Api>[],
  routingEligibleModels: Model<Api>[],
  modelsToTry: string[],
): Array<{ provider: string; modelId: string; reason: string }> {
  if (policyDenyReasons.length > 0) return policyDenyReasons;
  if (availableModels.length === 0) {
    return [{
      provider: "(registry)",
      modelId: "(none)",
      reason: "no authenticated providers in model registry — run /gsd login or set provider API keys, then verify with /model",
    }];
  }
  if (routingEligibleModels.length === 0) {
    return [{
      provider: "(registry)",
      modelId: "(none)",
      reason: "no candidate models passed model policy",
    }];
  }
  const eligibleSummary = routingEligibleModels
    .slice(0, 4)
    .map((m) => `${m.provider}/${m.id}`)
    .join(", ");
  return [{
    provider: "(config)",
    modelId: modelsToTry.join(", ") || "(none)",
    reason: `configured model(s) did not resolve against policy-eligible registry [${eligibleSummary}]`,
  }];
}

export function isModelUnavailable(
  basePath: string,
  provider: string | undefined,
  id: string | undefined,
): boolean {
  return isModelBlocked(basePath, provider, id) ||
    isModelTemporarilyUnavailable(basePath, provider, id);
}

/** Apply `auto_supervisor.model`, walking configured fallbacks on unavailability (#1229). */
export async function applySupervisorModelIfConfigured(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  basePath: string,
): Promise<void> {
  const modelConfig = resolveModelWithFallbacksForUnit("supervisor", basePath);
  if (!modelConfig) return;

  const availableModels = ctx.modelRegistry.getAvailable();
  for (const candidate of [modelConfig.primary, ...modelConfig.fallbacks]) {
    const match = resolveModelId(candidate, availableModels, ctx.model?.provider);
    if (!match) continue;
    if (isModelUnavailable(basePath, match.provider, match.id)) continue;
    try {
      if (await pi.setModel(match, { persist: false })) {
        // Prefer the per-field `thinking` from `auto_supervisor.model`'s object
        // form over the session level so a configured supervisor level actually
        // applies (#1269).
        applyThinkingLevelForModel(pi, modelConfig.thinking ?? pi.getThinkingLevel(), match, ctx);
        return;
      }
    } catch (err) {
      // Non-fatal — try the next fallback.
      logWarning(
        "dispatch",
        `supervisor model set failed for ${candidate}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function restoreToolBaseline(pi: ExtensionAPI): void {
  const key = pi as unknown as object;
  const baseline = TOOL_BASELINE.get(key);
  if (baseline === undefined) {
    // First call: capture the canonical pre-dispatch tool set.  At auto-mode
    // start the active set has not yet been narrowed for any provider.
    // Guarded against test fakes that omit getActiveTools — record an empty
    // baseline so subsequent calls don't keep re-probing.
    const initial = typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
    TOOL_BASELINE.set(key, [...initial]);
    return;
  }
  // Restore baseline before the next unit reads getActiveTools / applies
  // post-selection adjustToolSet.  Older fakes that omit setActiveTools are
  // tolerated — the test asserts call order on real fakes.
  if (typeof pi.setActiveTools === "function") {
    pi.setActiveTools([...baseline]);
  }
}

/**
 * Apply the desired reasoning effort for the just-selected model, clamping to
 * what the model actually supports (ADR-026). An unsupported level is never
 * sent to the provider — it is clamped via `clampThinkingLevel` and the
 * mismatch is surfaced once per (model, requested-level). Returns the level
 * actually applied so callers can record it.
 */
export function applyThinkingLevelForModel(
  pi: ExtensionAPI,
  desired: ReturnType<ExtensionAPI["getThinkingLevel"]> | null | undefined,
  model: Model<Api>,
  ctx: ExtensionContext,
): ReturnType<ExtensionAPI["getThinkingLevel"]> | null | undefined {
  if (!desired) return desired;
  // Capability-clamp only when we have a bare string level AND the model
  // advertises reasoning capability (`reasoning` is always present on real
  // registry models). Richer host snapshot shapes (e.g. `{ effort: "high" }`)
  // and partial model objects are applied verbatim — we never coerce an unknown
  // shape into a string or guess capability we can't see.
  if (typeof desired === "string" && model != null && typeof model === "object" && "reasoning" in model) {
    const clamped = clampThinkingLevel(model, desired as ModelThinkingLevel) as ReturnType<ExtensionAPI["getThinkingLevel"]>;
    pi.setThinkingLevel(clamped);
    if (clamped !== desired) {
      const key = `${model.provider}/${model.id}:${desired}`;
      if (!_warnedThinkingClamp.has(key)) {
        _warnedThinkingClamp.add(key);
        ctx.ui.notify(
          `Thinking level '${desired}' not supported by ${model.provider}/${model.id}; using '${clamped}'.`,
          "warning",
        );
      }
    }
    return clamped;
  }
  pi.setThinkingLevel(desired);
  return desired;
}

/** Warn-once guard for capability clamps, keyed by `provider/id:requested`. */
const _warnedThinkingClamp = new Set<string>();
/** Warn-once guard for the execute-task floor punch-through advisory. */
let _warnedExecuteTaskFloorBypass = false;

type EffectiveThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

/**
 * Ascending severity order for reasoning levels (matches @gsd/pi-agent-core
 * `ThinkingLevel`). Used only for floor comparisons below.
 */
const THINKING_LEVEL_ORDER: readonly EffectiveThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as EffectiveThinkingLevel[];

/**
 * Minimum reasoning level for code-writing units.
 *
 * `execute-task` is the only unit that edits source. With a low/minimal
 * thinking level a model does not plan its edits and compensates by re-reading
 * the same files dozens of times per task (measured: index.html read ~49× in a
 * single task on a minimal-thinking model) and shelling out to `nl`/`sed` to
 * re-locate code after every edit invalidates its line numbers. Flooring the
 * level for this unit type removes that read/bash thrash. Planning, research,
 * and lifecycle units are unaffected.
 */
const EXECUTE_TASK_MIN_THINKING_LEVEL: EffectiveThinkingLevel = "medium";

function thinkingLevelRank(level: EffectiveThinkingLevel): number {
  const idx = THINKING_LEVEL_ORDER.indexOf(level);
  return idx === -1 ? 0 : idx;
}

/**
 * Raise (never lower) the thinking level for code-writing units to a sane
 * floor. Returns the input unchanged for non-`execute-task` units, when no
 * level was captured, or when the captured level already meets the floor.
 */
export function floorThinkingLevelForUnit(
  unitType: string,
  level: ReturnType<ExtensionAPI["getThinkingLevel"]> | null | undefined,
): ReturnType<ExtensionAPI["getThinkingLevel"]> | null | undefined {
  if (unitType !== "execute-task") return level;
  if (!level) return level;
  // Only act on the recognized string levels. Any other shape (e.g. a richer
  // host snapshot object) is passed through untouched so we never coerce an
  // unknown representation into a bare string the host can't apply.
  if (!THINKING_LEVEL_ORDER.includes(level as EffectiveThinkingLevel)) {
    return level;
  }
  if (thinkingLevelRank(level as EffectiveThinkingLevel) >= thinkingLevelRank(EXECUTE_TASK_MIN_THINKING_LEVEL)) {
    return level;
  }
  return EXECUTE_TASK_MIN_THINKING_LEVEL;
}

export function resolvePreferredModelConfig(
  unitType: string,
  autoModeStartModel: { provider: string; id: string; flatRateCtx?: FlatRateContext } | null,
  isAutoMode = true,
  basePath?: string,
  availableModelIds?: string[],
  preferredModelId?: string,
): PreferredModelConfig | undefined {
  const explicitConfig = resolveModelWithFallbacksForUnit(
    unitType,
    basePath,
    availableModelIds,
    preferredModelId,
    true,
  );
  if (explicitConfig) {
    return {
      ...explicitConfig,
      source: "explicit",
    };
  }

  // In interactive mode, don't synthesize a routing-based model config.
  // The user's session model (/model) should be used as-is (#3962).
  if (!isAutoMode) return undefined;

  const routingConfig = resolveDynamicRoutingConfig();
  if (!routingConfig.enabled) return undefined;

  // Only an explicit flat-rate opt-out suppresses synthesized routing.
  // `dynamic_routing.enabled: true` is user intent to run routing even when
  // the start provider is a flat-rate subscription. Applied ahead of both the
  // tier-pin and profile-derived synthesis paths so the opt-out is uniform.
  if (
    routingConfig.allow_flat_rate_providers === false &&
    autoModeStartModel &&
    isFlatRateProvider(autoModeStartModel.provider, autoModeStartModel.flatRateCtx)
  ) {
    return undefined;
  }

  // With explicit `tier_models` pins, synthesize a heavy-tier ceiling that
  // dynamic routing downgrades from per unit.
  if (routingConfig.tier_models) {
    const ceilingModel = routingConfig.tier_models.heavy
      ?? (autoModeStartModel ? `${autoModeStartModel.provider}/${autoModeStartModel.id}` : undefined);
    if (!ceilingModel) return undefined;

    return {
      primary: ceilingModel,
      fallbacks: [],
      source: "synthesized",
    };
  }

  // No `tier_models` pins: fall back to the token-profile's per-phase model so
  // profile tier resolution survives. `skipProfileDefaults` is left false here
  // (unlike the explicit-detection call above) precisely because we WANT the
  // profile defaults this time — they are the routing ceiling, not a hard
  // user selection. Labeling the result `synthesized` (not `explicit`) keeps
  // dynamic routing and fallbacks enabled downstream. Without this branch,
  // `resolvePreferredModelConfig` returns undefined for profile-only configs
  // and auto dispatch bleeds the start model onto every unit, silently
  // discarding the profile (#1115: routing/fallbacks disabled when a
  // token_profile is set but no tier_models are pinned).
  const profileConfig = resolveModelWithFallbacksForUnit(
    unitType,
    basePath,
    availableModelIds,
    preferredModelId,
    false,
  );
  if (!profileConfig) return undefined;

  return {
    ...profileConfig,
    source: "synthesized",
  };
}

/**
 * Select and apply the appropriate model for a unit dispatch.
 * Handles: per-unit-type model preferences, dynamic complexity routing,
 * provider/model resolution, fallback chains, and start-model re-application.
 *
 * Returns routing metadata for metrics tracking.
 */
export async function selectAndApplyModel(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  unitType: string,
  unitId: string,
  basePath: string,
  prefs: GSDPreferences | undefined,
  verbose: boolean,
  autoModeStartModel: { provider: string; id: string; flatRateCtx?: FlatRateContext } | null,
  retryContext?: { isRetry: boolean; previousTier?: string },
  /** When false (interactive/guided-flow), skip dynamic routing and use the session model.
   *  Dynamic routing only applies in auto-mode where cost optimization is expected. (#3962) */
  isAutoMode = true,
  /** Explicit /gsd model pin captured at bootstrap for long-running auto loops. */
  sessionModelOverride?: { provider: string; id: string } | null,
  /** Thinking level captured at auto-mode start and re-applied after model swaps. */
  autoModeStartThinkingLevel?: ReturnType<ExtensionAPI["getThinkingLevel"]> | null,
): Promise<ModelSelectionResult> {
  const uokFlags = resolveUokFlags(prefs);
  // Resolve reasoning effort for this dispatch (ADR-026). An explicit per-phase
  // thinking config (inline `models.<phase>.thinking` or the separate `thinking`
  // block) expresses hard user intent: it bypasses the execute-task floor and is
  // honored verbatim, then capability-clamped per model at apply time below.
  // With no explicit level, fall back to the auto-start session level and raise
  // the code-writing floor — preserving prior behavior exactly. Recomputed per
  // dispatch so neither the floor nor a phase override leaks to other units.
  const anchorProvider = resolveProfileAnchorProvider(ctx.model?.provider, autoModeStartModel?.provider);
  const profileResolutionIds = modelIdsForProfileResolution(
    ctx.modelRegistry,
    anchorProvider,
    resolveDisabledModelProvidersFromPreferences(),
  );
  const explicitThinkingLevel =
    resolveThinkingLevelForUnit(unitType, basePath, profileResolutionIds) as ReturnType<ExtensionAPI["getThinkingLevel"]> | undefined;
  const desiredThinkingLevel = explicitThinkingLevel
    ?? floorThinkingLevelForUnit(unitType, autoModeStartThinkingLevel);
  if (explicitThinkingLevel) {
    if (
      unitType === "execute-task" &&
      thinkingLevelRank(explicitThinkingLevel) < thinkingLevelRank(EXECUTE_TASK_MIN_THINKING_LEVEL) &&
      !_warnedExecuteTaskFloorBypass
    ) {
      _warnedExecuteTaskFloorBypass = true;
      ctx.ui.notify(
        `Explicit execution thinking '${explicitThinkingLevel}' is below the measured execute-task floor ` +
        `(${EXECUTE_TASK_MIN_THINKING_LEVEL}); honoring it as configured. Low reasoning on code edits can ` +
        `cause repeated file re-reads.`,
        "warning",
      );
    }
  } else if (
    verbose &&
    desiredThinkingLevel &&
    desiredThinkingLevel !== autoModeStartThinkingLevel
  ) {
    ctx.ui.notify(
      `Thinking level raised to ${desiredThinkingLevel} for ${unitType} (was ${autoModeStartThinkingLevel ?? "unset"})`,
      "info",
    );
  }
  let appliedThinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]> | null | undefined = null;
  const effectiveSessionModelOverride = sessionModelOverride === undefined
    ? getSessionModelOverride(ctx.sessionManager.getSessionId())
    : (sessionModelOverride ?? undefined);
  // Enrich the start model with a flat-rate context up front so routing
  // synthesis and the dispatch-time guard see the same signals (built-in
  // list + user `flat_rate_providers` preference + externalCli auto-
  // detection).  The dispatch-time primary-model check below builds its
  // own per-provider context when it has a resolved primary model.
  if (autoModeStartModel) {
    autoModeStartModel = {
      ...autoModeStartModel,
      flatRateCtx: buildFlatRateContext(autoModeStartModel.provider, ctx, prefs),
    };
  }
  const preferredModelId = autoModeStartModel
    ? `${autoModeStartModel.provider}/${autoModeStartModel.id}`
    : ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
  const modelConfig = effectiveSessionModelOverride
    ? undefined
    : resolvePreferredModelConfig(
      unitType,
      autoModeStartModel,
      isAutoMode,
      basePath,
      profileResolutionIds,
      preferredModelId,
    );
  let routing: { tier: string; modelDowngraded: boolean } | null = null;
  let appliedModel: Model<Api> | null = null;

  // ── Restore active-tool baseline before policy evaluation (#4959, #4681, #4850) ──
  // Per-unit narrowing at the bottom of this function (line ~417) calls
  // `pi.setActiveTools(finalToolNames)` and monotonically narrows the active
  // set across units.  Without restoration, a previously-dispatched unit on a
  // narrow-API provider (e.g. openai-completions) leaves the active set
  // missing tools that the next unit's selected model fully supports, but
  // `pi.getActiveTools()` snapshot-as-hard-gate (the old behaviour) blocked
  // dispatch with "tool policy denied" anyway.
  //
  // The baseline is captured once per `pi` instance via a WeakMap and
  // re-applied here so each unit starts from a clean slate.  Soft adaptation
  // (adjustToolSet at the bottom of this function) still trims for the
  // selected model.
  //
  // Auto-mode only (#4965): `guided-flow.ts:dispatchWorkflow` also calls
  // `selectAndApplyModel` with `isAutoMode=false`. Guided-flow has its own
  // narrow/restore via discuss-tool-scoping (guided-flow.ts:587-622) and no
  // baseline-clear hook of its own, so an unconditional restore here would
  // resurrect an auto-era baseline on guided-flow dispatches — silently
  // overwriting any tool changes made interactively between auto sessions.
  // The baseline is structurally an auto-mode concept; gate it accordingly.
  if (isAutoMode) restoreToolBaseline(pi);

  if (modelConfig) {
    let availableModels = buildModelPolicyCandidates(
      ctx,
      autoModeStartModel,
      effectiveSessionModelOverride,
    );
    availableModels = augmentModelPolicyCandidates(ctx, availableModels, modelConfig);
    const modelPolicyTraceId = `model:${ctx.sessionManager.getSessionId()}:${Date.now()}`;
    const modelPolicyTurnId = `${unitType}:${unitId}`;
    let policyAllowedModelKeys: Set<string> | null = null;

    // ─── Dynamic Model Routing ─────────────────────────────────────────
    // Dynamic routing (complexity-based downgrading) only applies in auto-mode.
    // Interactive/guided-flow dispatches use the user's session model directly,
    // respecting their /model selection without silent downgrades (#3962).
    const routingConfig = resolveDynamicRoutingConfig();
    if (!isAutoMode) {
      routingConfig.enabled = false;
    }
    // burn-max defaults to quality-first dispatch (no downgrade routing).
    if (prefs?.token_profile === "burn-max") {
      routingConfig.enabled = false;
    }
    if (modelConfig.source === "explicit") {
      // Explicit per-phase model preferences express hard user intent.
      // Dynamic routing may only treat synthesized tier ceilings as downgradeable.
      routingConfig.enabled = false;
    }
    let effectiveModelConfig = modelConfig;
    let routingTierLabel = "";
    let routingEligibleModels = availableModels;

    const taskMetadataForPolicy = unitType === "execute-task"
      ? extractTaskMetadata(unitId, basePath)
      : undefined;

    let policyDenyReasons: Array<{ provider: string; modelId: string; reason: string }> = [];
    if (uokFlags.modelPolicy) {
      // Use the workflow-spec required-tool subset for the unit type rather
      // than the live `pi.getActiveTools()` snapshot (#4959).  The active set
      // is poisoned by per-unit narrowing for narrow-API providers — using it
      // as a hard gate promotes soft adaptation (adjustToolSet at line ~417)
      // into a layering violation that throws before dispatch.  The smaller
      // workflow-required subset reflects what the unit actually needs; soft
      // adaptation post-selection still trims provider-incompatible tools.
      const requiredTools = requiredPiToolsForModelPolicy(unitType);
      const policy = applyModelPolicyFilter(
        availableModels,
        {
          basePath,
          traceId: modelPolicyTraceId,
          turnId: modelPolicyTurnId,
          unitType,
          taskMetadata: taskMetadataForPolicy,
          currentProvider: ctx.model?.provider,
          allowCrossProvider: modelConfig.source === "explicit"
            ? true
            : routingConfig.cross_provider !== false,
          requiredTools,
        },
      );
      routingEligibleModels = policy.eligible;
      policyAllowedModelKeys = new Set(
        policy.eligible.map((m) => `${m.provider.toLowerCase()}/${m.id.toLowerCase()}`),
      );
      policyDenyReasons = policy.decisions
        .filter((d) => !d.allowed)
        .map((d) => ({ provider: d.provider, modelId: d.modelId, reason: d.reason }));
      if (routingEligibleModels.length === 0) {
        throw new ModelPolicyDispatchBlockedError(
          unitType,
          unitId,
          buildModelPolicyBlockReasons(policyDenyReasons, availableModels, routingEligibleModels, [
            effectiveModelConfig.primary,
            ...effectiveModelConfig.fallbacks,
          ]),
        );
      }
    }

    // Disable routing for flat-rate providers only when the user explicitly
    // opts out with dynamic_routing.allow_flat_rate_providers: false.
    // Fail-closed: if primary model can't be resolved, fall back to
    // provider-level signals rather than allowing unwanted downgrades.
    if (routingConfig.enabled && routingConfig.allow_flat_rate_providers === false) {
      const primaryModel = resolveModelId(modelConfig.primary, routingEligibleModels, ctx.model?.provider);
      if (primaryModel) {
        const primaryFlatRateCtx = buildFlatRateContext(primaryModel.provider, ctx, prefs);
        if (isFlatRateProvider(primaryModel.provider, primaryFlatRateCtx)) {
          routingConfig.enabled = false;
        }
      } else if (
        (autoModeStartModel && isFlatRateProvider(autoModeStartModel.provider, autoModeStartModel.flatRateCtx))
        || (ctx.model?.provider && isFlatRateProvider(
          ctx.model.provider,
          buildFlatRateContext(ctx.model.provider, ctx, prefs),
        ))
      ) {
        // Primary model unresolvable but provider signals indicate flat-rate —
        // disable routing to prevent quality degradation.
        routingConfig.enabled = false;
      }
    }

    if (routingConfig.enabled) {
      let budgetPct: number | undefined;
      if (routingConfig.budget_pressure !== false) {
        const budgetCeiling = prefs?.budget_ceiling;
        if (budgetCeiling !== undefined && budgetCeiling > 0) {
          const currentLedger = getLedger();
          const totalCost = currentLedger ? getProjectTotals(currentLedger.units).cost : 0;
          budgetPct = totalCost / budgetCeiling;
        }
      }

      const isHook = unitType.startsWith("hook/");
      const shouldClassify = !isHook || routingConfig.hooks !== false;

      if (shouldClassify) {
        let classification = classifyUnitComplexity(
          unitType,
          unitId,
          basePath,
          budgetPct,
          taskMetadataForPolicy,
        );
        const availableModelIds = routingEligibleModels.map(m => `${m.provider}/${m.id}`);

        // Escalate tier on retry when escalate_on_failure is enabled (default: true).
        // #4973: Deterministic policy errors are short-circuited at the postUnit
        // level (auto-post-unit.ts writes a placeholder and returns "continue"),
        // so this code path only runs for legitimate model-quality retries where
        // tier escalation is the right response.
        if (
          retryContext?.isRetry &&
          retryContext.previousTier &&
          routingConfig.escalate_on_failure !== false
        ) {
          const escalated = escalateTier(retryContext.previousTier as ComplexityTier);
          if (escalated) {
            classification = { ...classification, tier: escalated, reason: "escalated after failure" };
            // Always notify on tier escalation — model changes should be visible (#3962)
            ctx.ui.notify(
              `Tier escalation: ${retryContext.previousTier} → ${escalated} (retry after failure)`,
              "info",
            );
          } else {
            // #4973: Already at max tier — keep previousTier rather than letting
            // fresh classification silently downgrade the model back to a lower tier.
            // Without this, a light-start unit on retry 3 would revert to the light
            // model after escalating to heavy on retries 1 and 2.
            const tierOrder: Record<string, number> = { light: 0, standard: 1, heavy: 2 };
            const prevOrder = tierOrder[retryContext.previousTier] ?? 0;
            const freshOrder = tierOrder[classification.tier] ?? 0;
            if (prevOrder > freshOrder) {
              classification = { ...classification, tier: retryContext.previousTier as ComplexityTier, reason: "retained escalated tier from retry" };
            }
          }
        }

        // Load user capability overrides from preferences (D-17: deep-merged with built-in profiles)
        const capabilityOverrides = loadCapabilityOverrides(prefs ?? {});

        // Fire before_model_select hook (ADR-004, D-03)
        // Hook can override model selection entirely by returning { modelId }
        let hookOverride: string | undefined;
        if (routingConfig.hooks !== false) {
          const eligible = getEligibleModels(
            classification.tier,
            availableModelIds,
            routingConfig,
            preferredModelId,
            routingEligibleModels,
          );
          const hookResult = await pi.emitBeforeModelSelect({
            unitType,
            unitId,
            classification: {
              tier: classification.tier,
              reason: classification.reason,
              downgraded: classification.downgraded,
            },
            taskMetadata: classification.taskMetadata as Record<string, unknown> | undefined,
            eligibleModels: eligible,
            phaseConfig: modelConfig ? {
              primary: modelConfig.primary,
              fallbacks: modelConfig.fallbacks ?? [],
            } : undefined,
          });
          if (hookResult?.modelId) {
            hookOverride = hookResult.modelId;
          }
        }

        let routingResult: ReturnType<typeof resolveModelForComplexity>;
        if (hookOverride) {
          // Hook override bypasses capability scoring entirely
          routingResult = {
            modelId: hookOverride,
            fallbacks: [
              ...(modelConfig?.fallbacks ?? []).filter(f => f !== hookOverride),
              ...(modelConfig?.primary && modelConfig.primary !== hookOverride ? [modelConfig.primary] : []),
            ],
            tier: classification.tier,
            wasDowngraded: hookOverride !== modelConfig?.primary,
            reason: `hook override: ${hookOverride}`,
            selectionMethod: "tier-only",
          };
        } else {
          routingResult = resolveModelForComplexity(
            classification,
            modelConfig,
            routingConfig,
            availableModelIds,
            unitType,
            classification.taskMetadata,
            capabilityOverrides,
            preferredModelId,
            routingEligibleModels,
          );
        }

        if (routingResult.wasDowngraded) {
          effectiveModelConfig = {
            primary: routingResult.modelId,
            fallbacks: routingResult.fallbacks,
            source: modelConfig.source,
          };
          // Always notify on model downgrade — users should see when their
          // model selection is overridden, not just in verbose mode (#3962).
          if (routingResult.selectionMethod === "capability-scored" && routingResult.capabilityScores) {
            const tierLbl = tierLabel(classification.tier);
            const scores = Object.entries(routingResult.capabilityScores)
              .sort(([, a], [, b]) => b - a)
              .map(([id, score]) => `${id}: ${score.toFixed(1)}`)
              .join(", ");
            ctx.ui.notify(
              `Dynamic routing [${tierLbl}]: ${routingResult.modelId} (capability-scored) — ${scores}`,
              "info",
            );
          } else {
            ctx.ui.notify(
              `Dynamic routing [${tierLabel(classification.tier)}]: ${routingResult.modelId} (${classification.reason})`,
              "info",
            );
          }
        }
        routingTierLabel = ` [${tierLabel(classification.tier)}]`;
        routing = { tier: classification.tier, modelDowngraded: routingResult.wasDowngraded };
      }
    }

    const modelsToTry = [effectiveModelConfig.primary, ...effectiveModelConfig.fallbacks];
    let attemptedPolicyEligible = false;

    for (const modelId of modelsToTry) {
      const resolutionPool = uokFlags.modelPolicy ? routingEligibleModels : availableModels;
      const model = resolveModelId(modelId, resolutionPool, ctx.model?.provider);

      if (!model) {
        if (verbose) ctx.ui.notify(`Model ${modelId} not found, trying fallback.`, "info");
        continue;
      }

      if (policyAllowedModelKeys) {
        const key = `${model.provider.toLowerCase()}/${model.id.toLowerCase()}`;
        if (!policyAllowedModelKeys.has(key)) {
          if (verbose) {
            ctx.ui.notify(`Model policy denied ${model.provider}/${model.id}; trying fallback.`, "warning");
          }
          continue;
        }
        attemptedPolicyEligible = true;
      }

      // Skip models the provider has previously rejected for this account
      // (issue #4513).  The block is persisted in .gsd/runtime/blocked-models.json
      // so it survives /gsd auto restarts — without this, the same dead model
      // gets reselected after every restart.
      if (isModelUnavailable(basePath, model.provider, model.id)) {
        ctx.ui.notify(
          `Skipping unavailable model ${model.provider}/${model.id}.`,
          "warning",
        );
        continue;
      }

      // Warn if the ID is ambiguous across providers
      if (!modelId.includes("/")) {
        const providers = availableModels.filter(m => m.id === modelId).map(m => m.provider);
        if (providers.length > 1 && model.provider !== ctx.model?.provider) {
          ctx.ui.notify(
            `Model ID "${modelId}" exists in multiple providers (${providers.join(", ")}). ` +
            `Resolved to ${model.provider}. Use "provider/model" format for explicit targeting.`,
            "warning",
          );
        }
      }

      const ok = await pi.setModel(model, { persist: false });
      if (ok) {
        appliedModel = model;
        appliedThinkingLevel = applyThinkingLevelForModel(pi, desiredThinkingLevel, model, ctx);

        // ADR-005: Adjust active tool set for the selected model's provider capabilities.
        // Hard-filter incompatible tools, then let extensions override via adjust_tool_set hook.
        const activeToolNames = pi.getActiveTools();
        const { toolNames: compatibleTools, removedTools } = adjustToolSet(activeToolNames, model.api, model.provider);
        let finalToolNames = compatibleTools;

        // Fire adjust_tool_set hook — extensions can override the filtered tool set
        if (routingConfig.hooks !== false) {
          const hookResult = await pi.emitAdjustToolSet({
            selectedModelApi: model.api,
            selectedModelProvider: model.provider,
            selectedModelId: model.id,
            activeToolNames,
            filteredTools: removedTools,
          });
          if (hookResult?.toolNames) {
            finalToolNames = hookResult.toolNames;
          }
        }

        // Apply the filtered tool set if any tools were removed
        if (removedTools.length > 0 || finalToolNames.length !== activeToolNames.length) {
          pi.setActiveTools(finalToolNames);
        }

        if (verbose) {
          const fallbackNote = modelId === effectiveModelConfig.primary
            ? ""
            : ` (fallback from ${effectiveModelConfig.primary})`;
          const phase = unitPhaseLabel(unitType);
          ctx.ui.notify(`Model [${phase}]${routingTierLabel}: ${model.provider}/${model.id}${fallbackNote}`, "info");
          // ADR-005: Report tools filtered due to provider incompatibility
          if (removedTools.length > 0) {
            ctx.ui.notify(
              `Tool compatibility: ${removedTools.length} tools filtered for ${model.api} — ${removedTools.join(", ")}`,
              "info",
            );
          }
        }
        break;
      } else {
        const nextModel = modelsToTry[modelsToTry.indexOf(modelId) + 1];
        if (nextModel) {
          if (verbose) ctx.ui.notify(`Failed to set model ${modelId}, trying ${nextModel}...`, "info");
        } else {
          ctx.ui.notify(`All preferred models unavailable for ${unitType}. Using default.`, "warning");
        }
      }
    }

    if (uokFlags.modelPolicy && policyAllowedModelKeys && !attemptedPolicyEligible) {
      for (const model of buildPolicyEligibleFallbackOrder(ctx, routingEligibleModels, autoModeStartModel)) {
        const key = `${model.provider.toLowerCase()}/${model.id.toLowerCase()}`;
        if (!policyAllowedModelKeys.has(key)) continue;
        if (isModelUnavailable(basePath, model.provider, model.id)) continue;
        const ok = await pi.setModel(model, { persist: false });
        if (!ok) continue;
        appliedModel = model;
        appliedThinkingLevel = applyThinkingLevelForModel(pi, desiredThinkingLevel, model, ctx);
        attemptedPolicyEligible = true;
        if (verbose) {
          ctx.ui.notify(
            `Model policy: configured model unavailable; using ${model.provider}/${model.id}`,
            "info",
          );
        }
        break;
      }
      if (!attemptedPolicyEligible) {
        throw new ModelPolicyDispatchBlockedError(
          unitType,
          unitId,
          buildModelPolicyBlockReasons(policyDenyReasons, availableModels, routingEligibleModels, modelsToTry),
        );
      }
    }
  } else if (autoModeStartModel) {
    // No model preference for this unit type — re-apply the model captured
    // at auto-mode start to prevent bleed from shared global settings.json (#650).
    const availableModels = buildModelPolicyCandidates(
      ctx,
      autoModeStartModel,
      effectiveSessionModelOverride,
    );
    const startBlocked = isModelUnavailable(basePath, autoModeStartModel.provider, autoModeStartModel.id);
    if (startBlocked) {
      ctx.ui.notify(
        `Auto-mode start model ${autoModeStartModel.provider}/${autoModeStartModel.id} is unavailable. Using current session model instead.`,
        "warning",
      );
    } else {
      const startModel = availableModels.find(
        m => m.provider === autoModeStartModel.provider && m.id === autoModeStartModel.id,
      );
      if (startModel) {
        const ok = await pi.setModel(startModel, { persist: false });
        if (!ok) {
          const byId = availableModels.find(
            m => m.id === autoModeStartModel.id && !isModelUnavailable(basePath, m.provider, m.id),
          );
          if (byId) {
            const fallbackOk = await pi.setModel(byId, { persist: false });
            if (fallbackOk) {
              appliedModel = byId;
              appliedThinkingLevel = applyThinkingLevelForModel(pi, desiredThinkingLevel, byId, ctx);
            }
          }
        } else {
          appliedModel = startModel;
          appliedThinkingLevel = applyThinkingLevelForModel(pi, desiredThinkingLevel, startModel, ctx);
        }
      }
    }
  }

  // If no model branch applied a thinking level (e.g. interactive guided-flow
  // with a `thinking:` block but no per-phase model and no start model), still
  // honor an explicitly configured phase thinking level against the current
  // session model. Only the explicit path runs here — the floored session
  // default is intentionally left untouched so no-config interactive runs keep
  // the user's /model thinking level. (ADR-026)
  if (appliedThinkingLevel == null && explicitThinkingLevel && ctx.model) {
    // Prefer the full registry model (carries reasoning capability so the level
    // can be clamped); fall back to ctx.model. Always route through
    // applyThinkingLevelForModel so the clamp runs whenever capability metadata
    // exists — never a raw verbatim setThinkingLevel that bypasses it (ADR-026).
    const current = resolveModelId(
      `${ctx.model.provider}/${ctx.model.id}`,
      ctx.modelRegistry?.getAvailable?.() ?? [],
      ctx.model.provider,
    ) ?? (ctx.model as Model<Api>);
    appliedThinkingLevel = applyThinkingLevelForModel(pi, explicitThinkingLevel, current, ctx);
  }

  return { routing, appliedModel, appliedThinkingLevel };
}

/**
 * Resolve a model ID string to a model object from the available models list.
 * Handles formats: "provider/model", "bare-id", "org/model-name" (OpenRouter).
 */
export function resolveModelId<T extends { id: string; provider: string }>(
  modelId: string | undefined,
  availableModels: T[],
  currentProvider: string | undefined,
): T | undefined {
  if (!modelId) return undefined;
  const requestedModelId = modelId.trim();
  const slashIdx = requestedModelId.indexOf("/");

  if (slashIdx !== -1) {
    const maybeProvider = requestedModelId.substring(0, slashIdx);
    const id = requestedModelId.substring(slashIdx + 1);
    const normalizedId = normalizeModelIdToken(id);

    const knownProviders = new Set(availableModels.map(m => m.provider.toLowerCase()));
    const requestedProviderAliases = providerAliases(maybeProvider);
    const knownProviderMatch = [...requestedProviderAliases].some(p => knownProviders.has(p));
    if (knownProviderMatch) {
      const match = availableModels.find(
        m => requestedProviderAliases.has(m.provider.toLowerCase())
          && normalizeModelIdToken(m.id) === normalizedId,
      );
      if (match) return match;
    }

    // Try matching the full string as a model ID (OpenRouter-style)
    const lower = normalizeModelIdToken(requestedModelId);
    return availableModels.find(
      m => normalizeModelIdToken(m.id) === lower
        || normalizeModelIdToken(`${m.provider}/${m.id}`) === lower,
    );
  }

  // Bare ID — resolve with provider precedence to avoid silent misrouting.
  // Extension providers (e.g. claude-code) expose the same model IDs as their
  // upstream API providers but route through a subprocess with different
  // context, tool visibility, and cost characteristics (#2905).  Bare IDs in
  // PREFERENCES.md must resolve to the canonical API provider, not to an
  // extension wrapper that happens to be the current session provider.
  const normalizedBareId = normalizeModelIdToken(requestedModelId);
  const candidates = availableModels.filter(m => normalizeModelIdToken(m.id) === normalizedBareId);
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  // When the user's current provider is claude-code (set by startup migration
  // or explicit selection), honour it for bare IDs.  Routing back to anthropic
  // would undo the migration and hit the third-party subscription block (#3772).
  const normalizedCurrentProvider = currentProvider?.toLowerCase();
  if (normalizedCurrentProvider && sameProvider(normalizedCurrentProvider, "claude-code")) {
    const ccMatch = candidates.find(m => m.provider === "claude-code");
    if (ccMatch) return ccMatch;
  }

  // Extension / CLI-wrapper providers that should not win bare-ID resolution
  // when a first-class API provider also offers the same model AND the user
  // has not explicitly chosen the extension provider.
  const EXTENSION_PROVIDERS = new Set(["claude-code"]);

  // Prefer currentProvider only when it is a first-class API provider
  if (normalizedCurrentProvider && !EXTENSION_PROVIDERS.has(normalizedCurrentProvider)) {
    const providerMatch = candidates.find(m => sameProvider(m.provider, normalizedCurrentProvider));
    if (providerMatch) return providerMatch;
  }

  // Subscription/OAuth routes beat pay-per-token API when the same model ID
  // exists on multiple providers. Order matters — first match wins.
  for (const provider of BARE_ID_SUBSCRIPTION_PROVIDER_PRECEDENCE) {
    const match = candidates.find(m => sameProvider(m.provider, provider));
    if (match) return match;
  }

  // Fall back to first non-extension candidate, or any candidate
  return candidates.find(m => !EXTENSION_PROVIDERS.has(m.provider)) ?? candidates[0];
}

/**
 * When a bare model ID exists on multiple providers, prefer subscription/OAuth
 * routes over pay-per-token API keys. Matches PROVIDER_ROUTES in doctor-providers
 * but applies when *both* sides are authenticated.
 *
 * Order rationale:
 * - openai-codex before github-copilot: ChatGPT-native for shared GPT IDs
 * - google-antigravity before google-gemini-cli: Antigravity replaced Gemini CLI for individuals
 * - anthropic before github-copilot: first-party Claude API/OAuth over Copilot
 * - github-copilot before openai/google: Copilot OAuth over platform API keys
 */
export const BARE_ID_SUBSCRIPTION_PROVIDER_PRECEDENCE = [
  "openai-codex",
  "google-antigravity",
  "google-gemini-cli",
  "anthropic",
  "github-copilot",
] as const;

/**
 * Flat-rate providers charge the same per request regardless of model.
 * Dynamic routing provides no cost benefit — it only degrades quality (#3453).
 * Uses case-insensitive matching with alias support to prevent fail-open on
 * provider naming variations (e.g. "copilot" vs "github-copilot").
 */
const BUILTIN_FLAT_RATE = new Set(["github-copilot", "copilot", "claude-code"]);

/**
 * Optional context that lets callers extend flat-rate detection beyond the
 * hard-coded built-in list.  Either signal on its own is enough to classify
 * a provider as flat-rate.
 */
export interface FlatRateContext {
  /**
   * Auth mode for the specific provider being checked, as returned by
   * `ctx.modelRegistry.getProviderAuthMode(provider)`.  Any provider that
   * wraps a local CLI (externalCli) is, by definition, a flat-rate
   * subscription wrapper — every request costs the same regardless of
   * model, so dynamic routing only degrades quality.
   */
  authMode?: "apiKey" | "oauth" | "externalCli" | "none";
  /**
   * Case-insensitive list of extra provider IDs the user has declared as
   * flat-rate via `preferences.flat_rate_providers`.  Used for private
   * subscription-backed proxies and enterprise-gated deployments that the
   * built-in list doesn't know about.
   */
  userFlatRate?: readonly string[];
}

export function isFlatRateProvider(provider: string, opts?: FlatRateContext): boolean {
  const p = provider.toLowerCase();
  if (BUILTIN_FLAT_RATE.has(p)) return true;
  if (opts?.userFlatRate?.some(id => id.toLowerCase() === p)) return true;
  if (opts?.authMode === "externalCli") return true;
  return false;
}

/**
 * Build a FlatRateContext for a given provider from live runtime state.
 * Safe to call when ctx or prefs are undefined — missing pieces are
 * treated as "no signal".
 */
export function buildFlatRateContext(
  provider: string,
  ctx?: { modelRegistry?: { getProviderAuthMode?: (p: string) => string } },
  prefs?: { flat_rate_providers?: readonly string[] },
): FlatRateContext {
  let authMode: FlatRateContext["authMode"];
  const registry = ctx?.modelRegistry;
  if (registry && typeof registry.getProviderAuthMode === "function") {
    try {
      const mode = registry.getProviderAuthMode(provider);
      if (mode === "apiKey" || mode === "oauth" || mode === "externalCli" || mode === "none") {
        authMode = mode;
      }
    } catch (err) {
      // Registry lookup failure must never break flat-rate detection —
      // fall through with authMode undefined and surface the cause.
      logWarning(
        "dispatch",
        `flat-rate auth-mode lookup failed for ${provider}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return {
    authMode,
    userFlatRate: prefs?.flat_rate_providers,
  };
}
