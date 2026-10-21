// Project/App: gsd-pi
// File Purpose: Routes work to appropriate models while preserving configured ceilings.

import { getProviderCapabilities, type Api, type Model, type ProviderCapabilities } from "@gsd/pi-ai";
import { getToolCompatibility } from "@gsd/pi-coding-agent";
import type { ClassificationResult, ComplexityTier, TaskMetadata } from "./complexity-classifier.js";
import { tierOrdinal } from "./complexity-classifier.js";
import { incrementLegacyTelemetry } from "./legacy-telemetry.js";
import { resolveModelEconomics } from "./model-cost-table.js";
import type { ResolvedModelConfig } from "./preferences.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DynamicRoutingConfig {
  enabled?: boolean;
  capability_routing?: boolean;    // default: false — enable capability profile scoring
  tier_models?: {
    light?: string;
    standard?: string;
    heavy?: string;
  };
  escalate_on_failure?: boolean;   // default: true
  budget_pressure?: boolean;       // default: true
  cross_provider?: boolean;        // default: true
  hooks?: boolean;                 // default: true
  /**
   * Override dynamic routing for flat-rate providers (e.g. claude-code,
   * GitHub Copilot). Omit or set true to honor `dynamic_routing.enabled`;
   * set false to preserve one-model dispatch when the subscription makes
   * per-request cost identical.
   */
  allow_flat_rate_providers?: boolean;
}

export interface RoutingDecision {
  /** The model ID to use (may be downgraded from configured) */
  modelId: string;
  /** Fallback chain: [selected_model, ...configured_fallbacks, configured_primary] */
  fallbacks: string[];
  /** The complexity tier that drove this decision */
  tier: ComplexityTier;
  /** True if the model was downgraded from the configured primary */
  wasDowngraded: boolean;
  /** Human-readable reason for this decision */
  reason: string;
  /** How the model was selected */
  selectionMethod: "tier-only" | "capability-scored";
  /** Capability scores per eligible model (capability-scored path only) */
  capabilityScores?: Record<string, number>;
  /** Profile-confidence class for the chosen model */
  profileConfidence?: CapabilityProfileConfidence;
  /** Candidates considered but not selected, with concrete rejection reasons. */
  rejected?: Array<{ modelId: string; reason: string }>;
  /** Tools filtered out due to provider incompatibility (ADR-005) */
  filteredTools?: string[];
  /** Task requirement vector used for scoring */
  taskRequirements?: Partial<Record<string, number>>;
}

// ─── Capability Profiles ─────────────────────────────────────────────────────

/** Seven-dimension capability profile for a model. All values in 0–100 range. */
export interface ModelCapabilities {
  coding: number;
  debugging: number;
  research: number;
  reasoning: number;
  speed: number;
  longContext: number;
  instruction: number;
}

/** Compare all required dimensions without allowing averages to hide regressions. */
export function compareCapabilityDominance(
  selected: ModelCapabilities | undefined,
  candidate: ModelCapabilities | undefined,
): "higher" | "equivalent" | "incomparable" {
  if (!selected || !candidate) return "incomparable";
  const dimensions = CAPABILITY_DIMENSIONS;
  if (dimensions.some((dimension) => !Number.isFinite(selected[dimension]) || !Number.isFinite(candidate[dimension]))) {
    return "incomparable";
  }
  if (dimensions.some((dimension) => candidate[dimension] < selected[dimension])) return "incomparable";
  return dimensions.some((dimension) => candidate[dimension] > selected[dimension]) ? "higher" : "equivalent";
}

/**
 * Semantic aliases whose spelling differs by more than separator or casing.
 * Both keys and values are canonical so formatting variants never need entries.
 */
const MODEL_ID_ALIASES: Readonly<Record<string, string>> = {
  "gemini-flash-2-0": "gemini-2-0-flash",
};

const warnedUnknownConfiguredModelIds = new Set<string>();
const warnedUnknownRoutingModelIds = new Set<string>();

/**
 * Return the provider-independent key used by all routing registries.
 * Dispatch continues to use the original registry ID; this value is only for
 * matching model identities across provider prefixes and formatting variants.
 */
export function canonicalizeModelId(modelId: string): string {
  const trimmedId = modelId.trim();
  const slash = trimmedId.lastIndexOf("/");
  const bareId = slash >= 0 ? trimmedId.slice(slash + 1) : trimmedId;
  const canonicalId = bareId.trim().toLowerCase().replace(/[._-]+/g, "-");
  return MODEL_ID_ALIASES[canonicalId] ?? canonicalId;
}

function warnUnknownConfiguredModel(modelId: string): void {
  const warningKey = canonicalizeModelId(modelId) || modelId;
  if (warnedUnknownConfiguredModelIds.has(warningKey)) return;
  warnedUnknownConfiguredModelIds.add(warningKey);
  console.warn(
    `[gsd] Dynamic routing does not recognize configured model "${modelId}"; ` +
      "honoring the configured model without downgrade.",
  );
}

function warnUnknownRoutingModel(modelId: string): void {
  const warningKey = canonicalizeModelId(modelId) || modelId;
  if (warnedUnknownRoutingModelIds.has(warningKey)) return;
  warnedUnknownRoutingModelIds.add(warningKey);
  console.warn(
    `[gsd] Dynamic routing does not recognize model "${modelId}"; using safe defaults ` +
      "(standard tier, neutral capabilities, and expensive cost).",
  );
}

export type CapabilityProfileConfidence = "curated" | "inherited" | "provisional" | "unknown";

export const PROFILE_CONFIDENCE_ORDINAL: Record<CapabilityProfileConfidence, number> = {
  curated: 4,
  inherited: 3,
  provisional: 2,
  unknown: 1,
};

const CAPABILITY_DIMENSIONS: ReadonlyArray<keyof ModelCapabilities> = [
  "coding",
  "debugging",
  "research",
  "reasoning",
  "speed",
  "longContext",
  "instruction",
];

// ─── Known Model Tiers ───────────────────────────────────────────────────────
// Maps known model IDs to their capability tier. Used when tier_models is not
// explicitly configured to pick the best available model for each tier.

export const MODEL_CAPABILITY_TIER: Record<string, ComplexityTier> = {
  // Light-tier models (cheapest)
  "claude-haiku-4-5": "light",
  "claude-3-5-haiku-latest": "light",
  "claude-3-haiku-20240307": "light",
  "gpt-4o-mini": "light",
  "gpt-4-1-mini": "light",
  "gpt-4-1-nano": "light",
  "gpt-5-mini": "light",
  "gpt-5-nano": "light",
  "gpt-5-4-mini": "light",
  "gpt-5-4-nano": "light",
  "gpt-5-1-codex-mini": "light",
  "gpt-5-3-codex-spark": "light",
  "mai-code-1-flash-picker": "light",
  "mai-code-1-1-flash": "light",
  "gemini-2-0-flash": "light",
  "gemini-3-5-flash": "light",
  "gemini-3-6-flash": "light",
  "gemini-3-7-flash": "light",
  "gemini-3-8-flash": "light",             // models.dev 2026-09 refresh: same class/pricing as Gemini 3.7 Flash

  // Standard-tier models
  "claude-sonnet-4": "standard",
  "claude-sonnet-4-5": "standard",
  "claude-sonnet-4-6": "standard",
  "claude-sonnet-5": "standard",           // GA on GitHub Copilot, Anthropic, Vertex, Bedrock
  "claude-sonnet-4-5-20250514": "standard",
  "claude-3-5-sonnet-latest": "standard",
  "gpt-4o": "standard",
  "gpt-4-1": "standard",
  "gpt-5-1-codex-max": "standard",
  "gemini-2-5-pro": "standard",
  "gemini-3-1-pro-preview": "standard",
  "kimi-k2-7-code": "standard",
  "deepseek-chat": "standard",

  // Heavy-tier models (most capable)
  "claude-opus-4-5": "heavy",
  "claude-opus-4-6": "heavy",
  "claude-opus-4-7": "heavy",
  "claude-opus-4-8": "heavy",
  "claude-opus-5": "heavy",
  "claude-fable-5": "heavy",
  "claude-fable-5-1": "heavy",             // models.dev 2026-09 refresh: Fable 5.1 point release, same class/pricing as Fable 5
  "claude-3-opus-latest": "heavy",
  "gpt-4-turbo": "heavy",
  "gpt-5": "heavy",
  "gpt-5-pro": "heavy",
  "gpt-5-1": "heavy",
  "gpt-5-2": "heavy",
  "gpt-5-2-codex": "heavy",
  "gpt-5-3-codex": "heavy",
  "gpt-5-4": "heavy",
  "gpt-5-5": "heavy",
  "gpt-5-6-sol": "heavy",
  "gpt-5-6-terra": "heavy",
  "gpt-5-6-luna": "heavy",
  "gpt-6-astra": "heavy",
  "o1": "heavy",
  "o3": "heavy",
  "o4-mini": "heavy",
  "o4-mini-deep-research": "heavy",
  "grok-4-5": "heavy",
  "grok-4-6": "heavy",
  "kimi-k3": "heavy",
};

// ─── Cost Table (per 1K input tokens, approximate USD) ───────────────────────
// Used for cross-provider cost comparison when multiple providers offer
// the same capability tier.

const MODEL_COST_PER_1K_INPUT: Record<string, number> = {
  "claude-haiku-4-5": 0.0008,
  "claude-3-5-haiku-latest": 0.0008,
  "claude-sonnet-4": 0.003,
  "claude-sonnet-4-5": 0.003,
  "claude-sonnet-4-6": 0.003,
  "claude-sonnet-5": 0.003,                // $3.00/M input; matches Sonnet 4.x pricing
  "claude-sonnet-4-5-20250514": 0.003,
  "claude-opus-4-5": 0.005,
  "claude-opus-4-6": 0.005,
  "claude-opus-4-7": 0.005,
  "claude-opus-4-8": 0.005,
  "claude-opus-5": 0.005,
  "claude-fable-5": 0.010,
  "claude-fable-5-1": 0.010,
  "gpt-4o-mini": 0.00015,
  "gpt-4o": 0.0025,
  "gpt-4-1": 0.002,
  "gpt-4-1-mini": 0.0004,
  "gpt-4-1-nano": 0.0001,
  "gpt-5": 0.01,
  "gpt-5-mini": 0.0003,
  "gpt-5-nano": 0.0001,
  "gpt-5-4-mini": 0.00075,
  "gpt-5-4-nano": 0.0002,
  "gpt-5-pro": 0.015,
  "gpt-5-1": 0.005,
  "gpt-5-1-codex-max": 0.003,
  "gpt-5-1-codex-mini": 0.0003,
  "gpt-5-2": 0.005,
  "gpt-5-2-codex": 0.005,
  "gpt-5-3-codex": 0.005,
  "gpt-5-3-codex-spark": 0.0003,
  "mai-code-1-flash-picker": 0.00075,
  "mai-code-1-1-flash": 0.0002,
  "gpt-5-4": 0.005,
  "gpt-5-5": 0.005,
  "gpt-5-6-sol": 0.005,
  "gpt-5-6-terra": 0.0025,
  "gpt-5-6-luna": 0.001,
  "gpt-6-astra": 0.01,
  "o4-mini": 0.005,
  "o4-mini-deep-research": 0.005,
  "gemini-2-0-flash": 0.0001,
  "gemini-2-5-pro": 0.00125,
  "gemini-3-1-pro-preview": 0.002,
  "gemini-3-5-flash": 0.0015,
  "gemini-3-6-flash": 0.00075,
  "gemini-3-7-flash": 0.00075,
  "gemini-3-8-flash": 0.00075,
  "deepseek-chat": 0.00014,
  "grok-4-5": 0.002,
  "grok-4-6": 0.002,
  "kimi-k2-7-code": 0.00095,
  "kimi-k3": 0.003,
};

// ─── Capability Profiles Data Table ──────────────────────────────────────────
// Per-model capability profiles (0–100 scale). Used for capability-aware
// model selection within an eligible tier set.

export const MODEL_CAPABILITY_PROFILES: Record<string, ModelCapabilities> = {
  // ── Anthropic ──────────────────────────────────────────────────────────────
  "claude-opus-4-5":              { coding: 95, debugging: 90, research: 85, reasoning: 95, speed: 30, longContext: 80, instruction: 90 },
  "claude-opus-4-6":              { coding: 95, debugging: 90, research: 85, reasoning: 95, speed: 30, longContext: 80, instruction: 90 },
  "claude-opus-4-7":              { coding: 95, debugging: 90, research: 85, reasoning: 95, speed: 30, longContext: 80, instruction: 90 },
  "claude-opus-4-8":              { coding: 97, debugging: 92, research: 87, reasoning: 97, speed: 30, longContext: 85, instruction: 92 },
  "claude-opus-5":                { coding: 97, debugging: 92, research: 87, reasoning: 97, speed: 30, longContext: 85, instruction: 92 },
  "claude-fable-5":               { coding: 97, debugging: 92, research: 87, reasoning: 97, speed: 30, longContext: 85, instruction: 92 },
  // models.dev 2026-09 refresh: Fable 5.1 shares Fable 5's class and pricing; no published eval deltas yet.
  "claude-fable-5-1":             { coding: 97, debugging: 92, research: 87, reasoning: 97, speed: 30, longContext: 85, instruction: 92 },
  "claude-sonnet-4":              { coding: 85, debugging: 80, research: 75, reasoning: 80, speed: 60, longContext: 75, instruction: 85 },
  "claude-sonnet-4-5":            { coding: 85, debugging: 80, research: 75, reasoning: 80, speed: 60, longContext: 75, instruction: 85 },
  "claude-sonnet-4-6":            { coding: 85, debugging: 80, research: 75, reasoning: 80, speed: 60, longContext: 75, instruction: 85 },
  "claude-sonnet-5":              { coding: 90, debugging: 85, research: 80, reasoning: 87, speed: 55, longContext: 80, instruction: 88 },
  "claude-sonnet-4-5-20250514":   { coding: 85, debugging: 80, research: 75, reasoning: 80, speed: 60, longContext: 75, instruction: 85 },
  "claude-3-5-sonnet-latest":     { coding: 82, debugging: 78, research: 72, reasoning: 78, speed: 62, longContext: 70, instruction: 82 },
  "claude-haiku-4-5":             { coding: 60, debugging: 50, research: 45, reasoning: 50, speed: 95, longContext: 50, instruction: 75 },
  "claude-3-5-haiku-latest":      { coding: 60, debugging: 50, research: 45, reasoning: 50, speed: 95, longContext: 50, instruction: 75 },
  "claude-3-haiku-20240307":      { coding: 50, debugging: 40, research: 35, reasoning: 40, speed: 95, longContext: 40, instruction: 65 },
  "claude-3-opus-latest":         { coding: 90, debugging: 85, research: 82, reasoning: 90, speed: 35, longContext: 75, instruction: 88 },

  // ── OpenAI GPT ─────────────────────────────────────────────────────────────
  "gpt-4o":                       { coding: 80, debugging: 75, research: 70, reasoning: 75, speed: 65, longContext: 70, instruction: 80 },
  "gpt-4o-mini":                  { coding: 55, debugging: 45, research: 40, reasoning: 45, speed: 90, longContext: 45, instruction: 70 },
  "gpt-4-turbo":                  { coding: 78, debugging: 72, research: 68, reasoning: 72, speed: 50, longContext: 65, instruction: 78 },
  "gpt-4-1":                      { coding: 82, debugging: 78, research: 72, reasoning: 78, speed: 62, longContext: 72, instruction: 82 },
  "gpt-4-1-mini":                 { coding: 58, debugging: 48, research: 42, reasoning: 48, speed: 88, longContext: 48, instruction: 72 },
  "gpt-4-1-nano":                 { coding: 40, debugging: 30, research: 25, reasoning: 30, speed: 95, longContext: 30, instruction: 60 },
  "gpt-5":                        { coding: 92, debugging: 88, research: 85, reasoning: 92, speed: 40, longContext: 85, instruction: 90 },
  "gpt-5-mini":                   { coding: 62, debugging: 52, research: 48, reasoning: 52, speed: 88, longContext: 52, instruction: 74 },
  "gpt-5-nano":                   { coding: 42, debugging: 32, research: 28, reasoning: 32, speed: 95, longContext: 32, instruction: 62 },
  "gpt-5-4-mini":                 { coding: 70, debugging: 60, research: 55, reasoning: 60, speed: 84, longContext: 60, instruction: 78 },
  "gpt-5-4-nano":                 { coding: 50, debugging: 40, research: 35, reasoning: 42, speed: 94, longContext: 55, instruction: 66 },
  "gpt-5-pro":                    { coding: 94, debugging: 90, research: 88, reasoning: 94, speed: 35, longContext: 88, instruction: 92 },
  "gpt-5-1":                      { coding: 93, debugging: 89, research: 86, reasoning: 93, speed: 42, longContext: 86, instruction: 91 },
  "gpt-5-1-codex-max":            { coding: 90, debugging: 85, research: 70, reasoning: 85, speed: 55, longContext: 75, instruction: 85 },
  "gpt-5-1-codex-mini":           { coding: 65, debugging: 55, research: 40, reasoning: 50, speed: 88, longContext: 48, instruction: 72 },
  "gpt-5-2":                      { coding: 93, debugging: 90, research: 87, reasoning: 93, speed: 42, longContext: 87, instruction: 91 },
  "gpt-5-2-codex":                { coding: 93, debugging: 90, research: 72, reasoning: 88, speed: 50, longContext: 78, instruction: 88 },
  "gpt-5-3-codex":                { coding: 94, debugging: 91, research: 74, reasoning: 89, speed: 50, longContext: 80, instruction: 89 },
  "gpt-5-3-codex-spark":          { coding: 68, debugging: 58, research: 42, reasoning: 52, speed: 90, longContext: 50, instruction: 74 },
  "mai-code-1-flash-picker":      { coding: 74, debugging: 64, research: 42, reasoning: 58, speed: 96, longContext: 68, instruction: 76 },
  "mai-code-1-1-flash":           { coding: 78, debugging: 68, research: 45, reasoning: 62, speed: 96, longContext: 70, instruction: 78 },
  "gpt-5-4":                      { coding: 95, debugging: 92, research: 88, reasoning: 94, speed: 42, longContext: 88, instruction: 92 },
  // GPT-5.5 scores are relative to the existing gpt-5.4 profile and backed by
  // OpenAI's 2026-04-23 published eval deltas across coding, tool use, and long context.
  // Source: https://openai.com/index/introducing-gpt-5-5/
  "gpt-5-5":                      { coding: 96, debugging: 93, research: 89, reasoning: 95, speed: 42, longContext: 90, instruction: 93 },
  // GPT-5.6 profiles are provisional until official eval results are available.
  "gpt-5-6-sol":                  { coding: 97, debugging: 94, research: 90, reasoning: 96, speed: 42, longContext: 91, instruction: 94 },
  "gpt-5-6-terra":                { coding: 96, debugging: 93, research: 89, reasoning: 95, speed: 48, longContext: 91, instruction: 93 },
  "gpt-5-6-luna":                 { coding: 92, debugging: 88, research: 84, reasoning: 91, speed: 72, longContext: 91, instruction: 90 },
  "gpt-6-astra":                  { coding: 98, debugging: 96, research: 93, reasoning: 98, speed: 40, longContext: 94, instruction: 96 },

  // ── OpenAI o-series (reasoning-first) ──────────────────────────────────────
  "o1":                           { coding: 78, debugging: 82, research: 78, reasoning: 90, speed: 20, longContext: 65, instruction: 82 },
  "o3":                           { coding: 80, debugging: 85, research: 80, reasoning: 92, speed: 25, longContext: 70, instruction: 85 },
  "o4-mini":                      { coding: 75, debugging: 80, research: 72, reasoning: 88, speed: 60, longContext: 65, instruction: 80 },
  "o4-mini-deep-research":        { coding: 75, debugging: 80, research: 85, reasoning: 88, speed: 30, longContext: 80, instruction: 80 },

  // ── Google ─────────────────────────────────────────────────────────────────
  "gemini-2-5-pro":               { coding: 75, debugging: 70, research: 85, reasoning: 75, speed: 55, longContext: 90, instruction: 75 },
  "gemini-2-0-flash":             { coding: 50, debugging: 40, research: 50, reasoning: 40, speed: 95, longContext: 60, instruction: 65 },
  "gemini-3-1-pro-preview":       { coding: 80, debugging: 75, research: 88, reasoning: 82, speed: 55, longContext: 95, instruction: 78 },
  "gemini-3-5-flash":             { coding: 62, debugging: 55, research: 60, reasoning: 58, speed: 92, longContext: 75, instruction: 72 },
  "gemini-3-6-flash":             { coding: 66, debugging: 58, research: 64, reasoning: 62, speed: 93, longContext: 88, instruction: 74 },
  "gemini-3-7-flash":             { coding: 68, debugging: 60, research: 66, reasoning: 64, speed: 93, longContext: 88, instruction: 75 },
  // models.dev 2026-09 refresh: Gemini 3.8 Flash shares 3.7 Flash's class and pricing; no published eval deltas yet.
  "gemini-3-8-flash":             { coding: 68, debugging: 60, research: 66, reasoning: 64, speed: 93, longContext: 88, instruction: 75 },

  // ── DeepSeek ───────────────────────────────────────────────────────────────
  "deepseek-chat":                { coding: 75, debugging: 65, research: 55, reasoning: 70, speed: 70, longContext: 55, instruction: 65 },

  // ── Moonshot/Kimi ─────────────────────────────────────────────────────────
  "kimi-k2-7-code":               { coding: 82, debugging: 76, research: 62, reasoning: 78, speed: 70, longContext: 78, instruction: 80 },
  "kimi-k3":                      { coding: 90, debugging: 84, research: 78, reasoning: 88, speed: 55, longContext: 95, instruction: 86 },

  // ── xAI ────────────────────────────────────────────────────────────────────
  // Grok 4.5 (2026-07): Opus-class frontier model tuned for coding and agentic
  // work; notably faster and more token-efficient than peer heavy models.
  "grok-4-5":                     { coding: 95, debugging: 90, research: 82, reasoning: 93, speed: 55, longContext: 80, instruction: 90 },
  "grok-4-6":                     { coding: 96, debugging: 91, research: 83, reasoning: 94, speed: 55, longContext: 82, instruction: 91 },
};

// ─── Base Task Requirements Data Table ───────────────────────────────────────
// Per-unit-type base requirement vectors. Weights indicate how important each
// capability dimension is for this unit type.

export const BASE_REQUIREMENTS: Record<string, Partial<Record<keyof ModelCapabilities, number>>> = {
  "execute-task":       { coding: 0.9, instruction: 0.7, speed: 0.3 },
  "research-milestone": { research: 0.9, longContext: 0.7, reasoning: 0.5 },
  "research-slice":     { research: 0.9, longContext: 0.7, reasoning: 0.5 },
  "plan-milestone":     { reasoning: 0.9, coding: 0.5 },
  "plan-slice":         { reasoning: 0.9, coding: 0.5 },
  "replan-slice":       { reasoning: 0.9, debugging: 0.6, coding: 0.5 },
  "reassess-roadmap":   { reasoning: 0.9, research: 0.5 },
  "complete-slice":     { instruction: 0.8, speed: 0.7 },
  "run-uat":            { instruction: 0.7, speed: 0.8 },
  "discuss-milestone":  { reasoning: 0.6, instruction: 0.7 },
  "complete-milestone": { instruction: 0.8, reasoning: 0.5 },
};

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Score a model's suitability for a task given a requirement vector.
 * Returns a weighted average of capability dimensions (0–100).
 * Returns 50 if requirements are empty (neutral score).
 */
export function scoreModel(
  model: ModelCapabilities,
  requirements: Partial<Record<keyof ModelCapabilities, number>>,
): number {
  let weightedSum = 0;
  let weightSum = 0;
  for (const [dim, weight] of Object.entries(requirements)) {
    const capability = model[dim as keyof ModelCapabilities] ?? 50;
    weightedSum += weight * capability;
    weightSum += weight;
  }
  return weightSum > 0 ? weightedSum / weightSum : 50;
}

export function getModelProfileConfidence(
  modelId: string,
  capabilityOverrides?: Record<string, Partial<ModelCapabilities>>,
): CapabilityProfileConfidence {
  const bareId = canonicalizeModelId(modelId);
  if (MODEL_CAPABILITY_PROFILES[bareId] !== undefined) {
    return "curated";
  }

  if (findInheritedProfileBase(bareId)) {
    return "inherited";
  }

  const override = findCapabilityOverride(modelId, capabilityOverrides);
  if (override && CAPABILITY_DIMENSIONS.every((dimension) => typeof override[dimension] === "number")) {
    return "provisional";
  }

  return "unknown";
}

function findCapabilityOverride(
  modelId: string,
  capabilityOverrides?: Record<string, Partial<ModelCapabilities>>,
): Partial<ModelCapabilities> | undefined {
  if (!capabilityOverrides) return undefined;

  const directOverride = capabilityOverrides[modelId];
  if (directOverride) return directOverride;

  const canonicalId = canonicalizeModelId(modelId);
  return capabilityOverrides[canonicalId]
    ?? Object.entries(capabilityOverrides).find(([id]) => canonicalizeModelId(id) === canonicalId)?.[1];
}

function findInheritedProfileBase(modelId: string): string | undefined {
  const bareId = canonicalizeModelId(modelId);
  return Object.keys(MODEL_CAPABILITY_PROFILES)
    .sort((a, b) => b.length - a.length)
    .find((knownId) =>
      bareId !== knownId
      && (
        bareId.startsWith(`${knownId}-`)
        || bareId.startsWith(`${knownId}.`)
        || bareId.startsWith(`${knownId}:`)
        || bareId.startsWith(`${knownId}@`)
      )
    );
}

function buildNeutralCapabilityProfile(): ModelCapabilities {
  return {
    coding: 50,
    debugging: 50,
    research: 50,
    reasoning: 50,
    speed: 50,
    longContext: 50,
    instruction: 50,
  };
}

export function resolveCapabilityProfile(
  modelId: string,
  capabilityOverrides?: Record<string, Partial<ModelCapabilities>>,
): { profile: ModelCapabilities; confidence: CapabilityProfileConfidence } {
  const bareId = canonicalizeModelId(modelId);
  const builtin = MODEL_CAPABILITY_PROFILES[bareId];
  const inheritedBase = builtin ? undefined : findInheritedProfileBase(bareId);
  const inherited = inheritedBase ? MODEL_CAPABILITY_PROFILES[inheritedBase] : undefined;
  const override = findCapabilityOverride(modelId, capabilityOverrides);
  const confidence = getModelProfileConfidence(modelId, capabilityOverrides);

  if (builtin) {
    return {
      profile: override ? { ...builtin, ...override } : builtin,
      confidence,
    };
  }

  if (inherited) {
    return {
      profile: override ? { ...inherited, ...override } : inherited,
      confidence,
    };
  }

  if (override && CAPABILITY_DIMENSIONS.every((dimension) => typeof override[dimension] === "number")) {
    return {
      profile: override as ModelCapabilities,
      confidence,
    };
  }

  return {
    profile: buildNeutralCapabilityProfile(),
    confidence,
  };
}

function sameProviderQualifiedModel(
  modelId: string,
  candidate: Pick<Model<Api>, "id" | "provider">,
): boolean {
  const provider = modelProvider(modelId)?.toLowerCase();
  const bareId = canonicalizeModelId(modelId);
  const candidateProvider = candidate.provider?.toLowerCase();
  if (provider && candidateProvider && provider !== candidateProvider) return false;
  return bareId === candidate.id;
}

/**
 * Compute dynamic task requirements from unit type and optional task metadata.
 * Returns a requirement vector refined by task-specific signals.
 */
export function computeTaskRequirements(
  unitType: string,
  metadata?: TaskMetadata,
): Partial<Record<keyof ModelCapabilities, number>> {
  const base = BASE_REQUIREMENTS[unitType] ?? { reasoning: 0.5 };
  if (unitType === "execute-task" && metadata) {
    if (metadata.tags?.some(t => /^(docs?|readme|comment|config|typo|rename)$/i.test(t))) {
      return { ...base, instruction: 0.9, coding: 0.3, speed: 0.7 };
    }
    if (metadata.complexityKeywords?.some(k => k === "concurrency" || k === "compatibility")) {
      return { ...base, debugging: 0.9, reasoning: 0.8 };
    }
    if (metadata.complexityKeywords?.some(k => k === "migration" || k === "architecture")) {
      return { ...base, reasoning: 0.9, coding: 0.8 };
    }
    if ((metadata.fileCount ?? 0) >= 6 || (metadata.estimatedLines ?? 0) >= 500) {
      return { ...base, coding: 0.9, reasoning: 0.7 };
    }
  }
  return base;
}

/**
 * Score all eligible models against a requirement vector and return them
 * sorted by score descending. Within 2 points: prefer cheaper; equal cost:
 * lexicographic tie-break by model ID.
 */
export function scoreEligibleModels(
  eligibleModelIds: string[],
  requirements: Partial<Record<keyof ModelCapabilities, number>>,
  capabilityOverrides?: Record<string, Partial<ModelCapabilities>>,
  availableModels?: Array<Model<Api>>,
): Array<{ modelId: string; score: number; confidence: CapabilityProfileConfidence }> {
  const scored = eligibleModelIds.map(modelId => {
    const resolved = resolveCapabilityProfile(modelId, capabilityOverrides);
    return {
      modelId,
      score: scoreModel(resolved.profile, requirements),
      confidence: resolved.confidence,
    };
  });

  scored.sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (Math.abs(scoreDiff) > 2) return scoreDiff;

    const confidenceDiff = PROFILE_CONFIDENCE_ORDINAL[b.confidence] - PROFILE_CONFIDENCE_ORDINAL[a.confidence];
    if (confidenceDiff !== 0) return confidenceDiff;

    const costA = getModelCost(a.modelId, availableModels);
    const costB = getModelCost(b.modelId, availableModels);
    if (costA !== costB) return costA - costB;

    return a.modelId.localeCompare(b.modelId);
  });
  return scored;
}

/**
 * Return all models eligible for a given tier, sorted cheapest first.
 * A runtime preferred model (the user's selected/session model) is returned
 * first when it is available and satisfies the requested tier.
 * If routingConfig.tier_models[tier] is set and available, returns only that
 * model. Otherwise filters availableModelIds by tier from MODEL_CAPABILITY_TIER.
 */
export function getEligibleModels(
  tier: ComplexityTier,
  availableModelIds: string[],
  routingConfig: DynamicRoutingConfig,
  preferredModelId?: string,
  availableModels?: Array<Model<Api>>,
): string[] {
  // 1. Check explicit tier_models config
  const explicitModel = routingConfig.tier_models?.[tier];
  if (explicitModel) {
    // Exact match
    if (availableModelIds.includes(explicitModel)) return [explicitModel];
    // Provider-prefix-stripped match
    const canonicalExplicitModelId = canonicalizeModelId(explicitModel);
    const match = availableModelIds.find(id => canonicalizeModelId(id) === canonicalExplicitModelId);
    if (match) return [match];
  }

  // 2. Auto-detect: filter by tier, sort cheapest first
  const tierMatches = availableModelIds
    .filter(id => getModelTier(id) === tier)
    .sort((a, b) => {
      const costA = getModelCost(a, availableModels);
      const costB = getModelCost(b, availableModels);
      return costA - costB;
    });

  const preferred = findPreferredModelForTier(tier, availableModelIds, preferredModelId);
  if (!preferred) return tierMatches;
  return [preferred, ...tierMatches.filter(id => id !== preferred)];
}

/**
 * Build a fallback chain for a selected model: [selectedModel, ...configuredFallbacks, configuredPrimary]
 * Deduplicates entries while preserving order.
 */
function buildFallbackChain(selectedModelId: string, phaseConfig: ResolvedModelConfig): string[] {
  return [
    ...phaseConfig.fallbacks.filter(f => f !== selectedModelId),
    phaseConfig.primary,
  ].filter(f => f !== selectedModelId);
}

/**
 * Load capability overrides from user preferences' modelOverrides section.
 * Returns a map of model ID → partial capability overrides to deep-merge with built-in profiles.
 *
 * Per D-17: partial capability overrides via models.json modelOverrides, deep-merged with defaults.
 */
export function loadCapabilityOverrides(
  prefs: { modelOverrides?: Record<string, { capabilities?: Partial<ModelCapabilities> }> },
): Record<string, Partial<ModelCapabilities>> {
  const result: Record<string, Partial<ModelCapabilities>> = {};
  if (!prefs.modelOverrides) return result;
  for (const [modelId, overrideEntry] of Object.entries(prefs.modelOverrides)) {
    if (overrideEntry.capabilities) {
      const canonicalId = canonicalizeModelId(modelId);
      if (canonicalId) result[canonicalId] = overrideEntry.capabilities;
    }
  }
  return result;
}

/**
 * Resolve the model to use for a given complexity tier.
 *
 * Downgrade-only: the returned model is always equal to or cheaper than
 * the user's configured primary model. Never upgrades beyond configuration.
 *
 * STEP 1: Filter to eligible models for the requested tier.
 * STEP 2: Capability scoring — ranks eligible models by task-capability match
 *         when capability_routing is enabled and multiple eligible models exist.
 * STEP 3: Fallback chain assembly.
 *
 * @param classification      The complexity classification result
 * @param phaseConfig         The user's configured model for this phase (ceiling)
 * @param routingConfig       Dynamic routing configuration
 * @param availableModelIds   List of available model IDs (from registry)
 * @param unitType            The unit type for capability requirement computation (optional)
 * @param taskMetadata        Task metadata for refined requirement vectors (optional)
 * @param capabilityOverrides User-provided capability overrides (deep-merged with built-in profiles, optional)
 */
export function resolveModelForComplexity(
  classification: ClassificationResult,
  phaseConfig: ResolvedModelConfig | undefined,
  routingConfig: DynamicRoutingConfig,
  availableModelIds: string[],
  unitType?: string,
  taskMetadata?: TaskMetadata,
  capabilityOverrides?: Record<string, Partial<ModelCapabilities>>,
  preferredModelId?: string,
  availableModels?: Array<Model<Api>>,
): RoutingDecision {
  // If no phase config or routing disabled, pass through
  if (!phaseConfig || !routingConfig.enabled) {
    return {
      modelId: phaseConfig?.primary ?? "",
      fallbacks: phaseConfig?.fallbacks ?? [],
      tier: classification.tier,
      wasDowngraded: false,
      reason: "dynamic routing disabled or no phase config",
      selectionMethod: "tier-only",
    };
  }

  const configuredPrimary = phaseConfig.primary;
  const requestedTier = classification.tier;

  // If the configured model is unknown (not in MODEL_CAPABILITY_TIER),
  // honor the user's explicit choice — don't downgrade based on a guess.
  // Unknown models default to "heavy" in getModelTier, which makes every
  // standard/light unit get downgraded to tier_models, silently ignoring
  // the user's configuration. (#2192)
  if (!isKnownModel(configuredPrimary)) {
    warnUnknownConfiguredModel(configuredPrimary);
    return {
      modelId: configuredPrimary,
      fallbacks: phaseConfig.fallbacks,
      tier: requestedTier,
      wasDowngraded: false,
      reason: `configured model "${configuredPrimary}" is not in the known tier map — honoring explicit config`,
      selectionMethod: "tier-only",
    };
  }

  const configuredTier = getModelTier(configuredPrimary);

  // Downgrade-only: if requested tier >= configured tier, no change
  if (tierOrdinal(requestedTier) >= tierOrdinal(configuredTier)) {
    // If the configured primary is directly available, use it
    if (isModelAvailable(configuredPrimary, availableModelIds)) {
      return {
        modelId: configuredPrimary,
        fallbacks: phaseConfig.fallbacks,
        tier: requestedTier,
        wasDowngraded: false,
        reason: `tier ${requestedTier} >= configured ${configuredTier}`,
        selectionMethod: "tier-only",
      };
    }

    // Configured primary is unavailable (e.g. Anthropic model configured but
    // running on a non-Anthropic provider). Find the best available model at
    // the same capability tier so routing still works cross-provider.
    const crossProviderEquivalent = findModelForTier(
      configuredTier,
      routingConfig,
      availableModelIds,
      routingConfig.cross_provider !== false,
      preferredModelId,
      availableModels,
      { overrides: capabilityOverrides },
    );

    return {
      modelId: crossProviderEquivalent ?? configuredPrimary,
      fallbacks: crossProviderEquivalent
        ? [...phaseConfig.fallbacks.filter(f => f !== crossProviderEquivalent), configuredPrimary]
        : phaseConfig.fallbacks,
      tier: requestedTier,
      wasDowngraded: false,
      reason: crossProviderEquivalent
        ? `cross-provider ${configuredTier}-tier equivalent`
        : `tier ${requestedTier} >= configured ${configuredTier}`,
      selectionMethod: "tier-only",
    };
  }

  // STEP 1: Get all eligible models for the requested tier
  const eligible = getEligibleModels(requestedTier, availableModelIds, routingConfig, preferredModelId);
  const eligibleModels = getEligibleModels(requestedTier, availableModelIds, routingConfig, preferredModelId, availableModels);

  if (eligibleModels.length === 0) {
    // No suitable model found — use configured primary
    return {
      modelId: configuredPrimary,
      fallbacks: phaseConfig.fallbacks,
      tier: requestedTier,
      wasDowngraded: false,
      reason: `no ${requestedTier}-tier model available`,
      selectionMethod: "tier-only",
    };
  }

  const preferred = findPreferredModelForTier(requestedTier, availableModelIds, preferredModelId);
  if (preferred && eligibleModels.includes(preferred)) {
    const fallbacks = buildFallbackChain(preferred, phaseConfig);
    return {
      modelId: preferred,
      fallbacks,
      tier: requestedTier,
      wasDowngraded: !isModelAvailable(configuredPrimary, [preferred]),
      reason: `preferred session model ${preferred} satisfies ${requestedTier} tier`,
      selectionMethod: "tier-only",
    };
  }

  // STEP 2: Capability scoring (when enabled and multiple eligible models exist)
  if (routingConfig.capability_routing !== false && eligible.length > 1 && unitType) {
    const requirements = computeTaskRequirements(unitType, taskMetadata);
    const scored = scoreEligibleModels(eligibleModels, requirements, capabilityOverrides, availableModels);
    const profiled = scored.filter((candidate) => candidate.confidence !== "unknown");

    if (profiled.length === 0) {
      const rejected = scored.map((candidate) => ({
        modelId: candidate.modelId,
        reason: "no GSD capability profile (unknown confidence) — explicit/manual selection only, not auto-routed",
      }));
      return {
        modelId: configuredPrimary,
        fallbacks: phaseConfig.fallbacks,
        tier: requestedTier,
        wasDowngraded: false,
        reason: "no profiled candidate eligible for automatic routing — fail closed",
        selectionMethod: "tier-only",
        rejected,
      };
    }

    const winner = profiled[0];
    if (winner) {
      const capScores: Record<string, number> = {};
      for (const s of scored) capScores[s.modelId] = s.score;
      const rejected = scored
        .filter((candidate) => candidate.modelId !== winner.modelId)
        .map((candidate) => {
          if (candidate.confidence === "unknown") {
            return {
              modelId: candidate.modelId,
              reason: "no GSD capability profile (unknown confidence) — explicit/manual selection only, not auto-routed",
            };
          }

          // Mirror scoreEligibleModels's own comparator precedence exactly: a
          // score gap only decides the ordering once it exceeds the 2-point
          // tolerance band; within that band, confidence decides, then cost.
          // Checking confidence before the score-band gate (as this used to)
          // could report "lower profile confidence" or "lower capability
          // match" for a candidate the comparator actually ranked below
          // winner on cost alone.
          if (winner.score - candidate.score > 2) {
            return {
              modelId: candidate.modelId,
              reason: `lower capability match (${candidate.score.toFixed(1)} vs ${winner.score.toFixed(1)})`,
            };
          }

          if (PROFILE_CONFIDENCE_ORDINAL[candidate.confidence] < PROFILE_CONFIDENCE_ORDINAL[winner.confidence]) {
            return {
              modelId: candidate.modelId,
              reason: `lower profile confidence (${candidate.confidence} vs ${winner.confidence}) within the capability score band`,
            };
          }

          const candidateCost = getModelCost(candidate.modelId, availableModels);
          const winnerCost = getModelCost(winner.modelId, availableModels);
          if (candidateCost > winnerCost) {
            return {
              modelId: candidate.modelId,
              reason: `higher projected input cost ($${candidateCost.toFixed(4)} vs $${winnerCost.toFixed(4)} per 1K input)`,
            };
          }

          return {
            modelId: candidate.modelId,
            reason: `ranked below ${winner.modelId} after capability, confidence, and cost tie-breaks`,
          };
        });
      const fallbacks = buildFallbackChain(winner.modelId, phaseConfig);
      return {
        modelId: winner.modelId,
        fallbacks,
        tier: requestedTier,
        wasDowngraded: true,
        reason: `capability-scored: ${winner.modelId} (${winner.score.toFixed(1)}, ${winner.confidence} confidence) for ${unitType}`,
        capabilityScores: capScores,
        profileConfidence: winner.confidence,
        taskRequirements: requirements,
        selectionMethod: "capability-scored",
        ...(rejected.length > 0 ? { rejected } : {}),
      };
    }
  }

  // STEP 3: Fallback — use the cheapest eligible model with a known capability
  // profile. An unknown-confidence candidate is skipped, not treated as a
  // dead end: it must never itself be auto-selected, but it also must not
  // mask a safe, known-confidence alternative further down the same
  // (cost-sorted) eligible list.
  const explicitTierPin = routingConfig.tier_models?.[requestedTier];
  const isExplicitTierPin = (modelId: string): boolean =>
    !!explicitTierPin && (modelId === explicitTierPin || canonicalizeModelId(modelId) === canonicalizeModelId(explicitTierPin));

  // getEligibleModels() honors an explicit tier_models pin unconditionally (its
  // own step 1, which always returns a single-element list for a pin), so a
  // pinned model bypasses this confidence gate even without a capability
  // profile — same "honor the user's explicit choice" precedent already used
  // above for an unknown configuredPrimary. Only the automatic-detection path
  // (STEP 2's own scoring skipped or reduced to one candidate) is gated here.
  const targetModelId = eligibleModels.find(
    (modelId) => isExplicitTierPin(modelId) || getModelProfileConfidence(modelId, capabilityOverrides) !== "unknown",
  );

  if (!targetModelId) {
    return {
      modelId: configuredPrimary,
      fallbacks: phaseConfig.fallbacks,
      tier: requestedTier,
      wasDowngraded: false,
      reason: "no profiled candidate eligible for automatic routing — fail closed",
      selectionMethod: "tier-only",
    };
  }

  // Build fallback chain: [downgraded_model, ...configured_fallbacks, configured_primary]
  const fallbacks = buildFallbackChain(targetModelId, phaseConfig);

  return {
    modelId: targetModelId,
    fallbacks,
    tier: requestedTier,
    wasDowngraded: true,
    reason: classification.reason,
    selectionMethod: "tier-only",
  };
}

/**
 * Escalate to the next tier after a failure.
 * Returns the new tier, or null if already at heavy (max).
 */
export function escalateTier(currentTier: ComplexityTier): ComplexityTier | null {
  switch (currentTier) {
    case "light": return "standard";
    case "standard": return "heavy";
    case "heavy": return null;
  }
}

/**
 * Get the default routing config (all features enabled).
 */
export function defaultRoutingConfig(): DynamicRoutingConfig {
  return {
    enabled: true,
    capability_routing: true,
    escalate_on_failure: true,
    budget_pressure: true,
    cross_provider: true,
    hooks: true,
  };
}

// ─── Tier-Based Model Resolution (for profile defaults) ─────────────────────

/**
 * Fallback-only canonical model IDs per tier. Returned only when the
 * available-model list is empty (e.g., preferences are loaded before the
 * model registry is populated at bootstrap).
 *
 * Precedence (resolveModelForTier):
 *   1. configured `tier_models[tier]` (via getEligibleModels) — exact/bare match
 *   2. preferred/session model when it is available and satisfies `tier`
 *   3. cheapest available model whose tier matches `tier`
 *   4. CANONICAL_TIER_MODELS[tier] when the registry is empty
 */
const CANONICAL_TIER_MODELS: Record<ComplexityTier, string> = {
  light: "claude-haiku-4-5",
  standard: "claude-sonnet-4-6",
  heavy: "claude-opus-4-6",
};

export function canonicalModelForTier(tier: ComplexityTier): string {
  return CANONICAL_TIER_MODELS[tier];
}

/**
 * Single source of truth for tier-based model selection.
 * Returns the preferred/session model when it satisfies `tier`, otherwise the
 * cheapest available model whose capability tier matches `tier`, honoring
 * `routingConfig.tier_models[tier]` when set. Returns undefined when no
 * available model satisfies the tier.
 *
 * `crossProvider`: when false, restricts the search to models that share the
 * canonical (Anthropic) provider for the tier. When true, any provider is
 * eligible.
 */
function findModelForTier(
  tier: ComplexityTier,
  routingConfig: DynamicRoutingConfig,
  availableModelIds: string[],
  crossProvider: boolean,
  preferredModelId?: string,
  availableModels?: Array<Model<Api>>,
  capabilityGate?: { overrides?: Record<string, Partial<ModelCapabilities>> },
): string | undefined {
  const eligible = getEligibleModels(tier, availableModelIds, routingConfig, preferredModelId, availableModels);
  if (eligible.length === 0) return undefined;

  if (crossProvider) {
    if (!capabilityGate) return eligible[0];

    // Fail-closed, mirroring resolveModelForComplexity's own STEP 3 gate: an
    // automatic cross-provider substitution must never itself be an
    // unknown-confidence model, though an explicit tier_models pin is always
    // honored regardless of profile.
    const explicitTierPin = routingConfig.tier_models?.[tier];
    const isExplicitTierPin = (modelId: string): boolean =>
      !!explicitTierPin && (modelId === explicitTierPin || canonicalizeModelId(modelId) === canonicalizeModelId(explicitTierPin));
    return eligible.find(
      (modelId) => isExplicitTierPin(modelId) || getModelProfileConfidence(modelId, capabilityGate.overrides) !== "unknown",
    );
  }

  // Same-provider only: keep models whose bare ID matches a canonical
  // Anthropic ID at this tier (i.e., a claude-* model in the tier map).
  const sameProvider = eligible.filter(id => {
    const bare = canonicalizeModelId(id);
    return MODEL_CAPABILITY_TIER[bare] === tier && bare.startsWith("claude-");
  });

  // Honor the preferred/session model only when it is itself a same-provider
  // (Anthropic/Claude) model. A non-Anthropic session model must not bypass
  // the cross_provider:false restriction.
  const preferred = findPreferredModelForTier(tier, availableModelIds, preferredModelId);
  if (preferred && sameProvider.includes(preferred)) return preferred;

  return sameProvider[0];
}

/**
 * Resolve a concrete model ID for a given capability tier using the
 * available model list. Provider-agnostic: picks the best available
 * model at the requested tier.
 *
 * Precedence:
 *   1. configured `tier_models[tier]`, if provided and available
 *   2. preferred/session model when available and satisfying the tier
 *   3. tier-matching model from any provider in `availableModelIds`
 *   4. preferred/session model, then first available model, when the registry
 *      is non-empty but has no tier match
 *   5. canonical Anthropic ID only when `availableModelIds` is empty
 *
 * @param tier              The capability tier to resolve
 * @param availableModelIds List of available model IDs (REQUIRED for
 *                          provider-agnostic resolution; pass [] only when
 *                          the model registry is genuinely unavailable)
 * @param routingConfig     Optional routing config, or legacy crossProvider boolean
 * @param crossProvider     Whether to consider models from other providers
 * @param preferredModelId  Optional selected/session model ID to prefer
 */
export function resolveModelForTier(
  tier: ComplexityTier,
  availableModelIds: string[],
  crossProvider?: boolean,
): string;
export function resolveModelForTier(
  tier: ComplexityTier,
  availableModelIds: string[],
  routingConfig?: DynamicRoutingConfig,
  crossProvider?: boolean,
  preferredModelId?: string,
): string;
export function resolveModelForTier(
  tier: ComplexityTier,
  availableModelIds: string[],
  routingConfigOrCrossProvider: DynamicRoutingConfig | boolean = defaultRoutingConfig(),
  crossProvider?: boolean,
  preferredModelId?: string,
): string {
  const routingConfig = typeof routingConfigOrCrossProvider === "boolean"
    ? defaultRoutingConfig()
    : { ...defaultRoutingConfig(), ...routingConfigOrCrossProvider };
  const allowCrossProvider = typeof routingConfigOrCrossProvider === "boolean"
    ? routingConfigOrCrossProvider
    : crossProvider ?? routingConfig.cross_provider !== false;

  // No available models known — prefer the session model when provided, else canonical
  if (availableModelIds.length === 0) {
    if (preferredModelId) {
      return normalizeResolvedTierModelId(preferredModelId, tier, routingConfig);
    }
    incrementLegacyTelemetry("legacy.providerDefaultUsed");
    return canonicalModelForTier(tier);
  }

  // Cross-provider tier search
  const resolved = findModelForTier(tier, routingConfig, availableModelIds, allowCrossProvider, preferredModelId);
  if (resolved) {
    return normalizeResolvedTierModelId(resolved, tier, routingConfig);
  }

  const providerLocalFallback = findAvailableModelId(preferredModelId, availableModelIds)
    ?? availableModelIds[0]
    ?? canonicalModelForTier(tier);
  return normalizeResolvedTierModelId(providerLocalFallback, tier, routingConfig);
}

// ─── Internal ────────────────────────────────────────────────────────────────

function modelProvider(modelId: string): string | undefined {
  const trimmedId = modelId.trim();
  const slash = trimmedId.indexOf("/");
  return slash > 0 ? trimmedId.slice(0, slash).trim() : undefined;
}

function findAvailableModelId(
  preferredModelId: string | undefined,
  availableModelIds: string[],
): string | undefined {
  if (!preferredModelId) return undefined;
  if (availableModelIds.includes(preferredModelId)) return preferredModelId;

  const preferredBare = canonicalizeModelId(preferredModelId);
  if (!preferredBare) return undefined;
  const preferredProvider = modelProvider(preferredModelId)?.toLowerCase();
  if (preferredProvider) {
    const providerMatch = availableModelIds.find(id =>
      modelProvider(id)?.toLowerCase() === preferredProvider && canonicalizeModelId(id) === preferredBare
    );
    if (providerMatch) return providerMatch;
  }

  return availableModelIds.find(id => canonicalizeModelId(id) === preferredBare);
}

function modelSatisfiesTier(modelId: string, tier: ComplexityTier): boolean {
  return tierOrdinal(getModelTier(modelId)) >= tierOrdinal(tier);
}

function findPreferredModelForTier(
  tier: ComplexityTier,
  availableModelIds: string[],
  preferredModelId: string | undefined,
): string | undefined {
  const preferred = findAvailableModelId(preferredModelId, availableModelIds);
  if (!preferred) return undefined;
  return modelSatisfiesTier(preferred, tier) ? preferred : undefined;
}

/**
 * Check whether a model ID is present in the available models list.
 * Handles provider prefixes plus casing and separator variants.
 */
function isModelAvailable(modelId: string, availableModelIds: string[]): boolean {
  if (availableModelIds.includes(modelId)) return true;
  // Canonicalize provider prefixes and formatting variants for comparison. Treat
  // trailing-slash IDs ("provider/") as no-bare-ID rather than empty-string
  // match (which would erroneously match any other "provider/" ID).
  const bare = canonicalizeModelId(modelId);
  if (!bare) return false;
  return availableModelIds.some(id => canonicalizeModelId(id) === bare);
}

function getModelTier(modelId: string): ComplexityTier {
  // Normalize provider prefixes, casing, and separators before lookup.
  const bareId = canonicalizeModelId(modelId);
  if (MODEL_CAPABILITY_TIER[bareId]) return MODEL_CAPABILITY_TIER[bareId];

  // Unknown models are assumed standard (per D-15: avoids silently ignoring user config)
  warnUnknownRoutingModel(modelId);
  return "standard";
}

/** Check if a model ID has a known capability tier mapping. (#2192) */
function isKnownModel(modelId: string): boolean {
  const bareId = canonicalizeModelId(modelId);
  return Boolean(bareId && MODEL_CAPABILITY_TIER[bareId]);
}

function getModelCost(modelId: string, availableModels?: Array<Model<Api>>): number {
  const provider = modelProvider(modelId) ?? availableModels?.find((candidate) => sameProviderQualifiedModel(modelId, candidate))?.provider ?? "unknown";
  const bareId = canonicalizeModelId(modelId);

  const runtimeModel = availableModels?.find((candidate) => sameProviderQualifiedModel(modelId, candidate));
  // All-zero cost is the registry's placeholder for "unknown", not a real free
  // price (see model-registry.ts's defaultCost) — require a meaningful nonzero
  // field before trusting it, same gate buildStaticEconomics uses.
  const hasMeaningfulRuntimeCost = runtimeModel?.cost && (
    runtimeModel.cost.input > 0
    || runtimeModel.cost.output > 0
    || runtimeModel.cost.cacheRead > 0
    || runtimeModel.cost.cacheWrite > 0
    || (runtimeModel.cost.tiers?.length ?? 0) > 0
  );
  if (hasMeaningfulRuntimeCost && runtimeModel?.cost) {
    const runtimeLongContextTiers = runtimeModel.cost.tiers
      ?.filter(
        (tier): tier is typeof tier & { input: number; output: number } =>
          typeof tier.input === "number" && typeof tier.output === "number",
      )
      .map((tier) => ({
        inputTokensAbove: tier.inputTokensAbove,
        inputPer1k: tier.input / 1000,
        outputPer1k: tier.output / 1000,
        ...(typeof tier.cacheRead === "number" ? { cachedInputPer1k: tier.cacheRead / 1000 } : {}),
        ...(typeof tier.cacheWrite === "number" ? { cachedOutputPer1k: tier.cacheWrite / 1000 } : {}),
      }));

    const runtimeEconomics = resolveModelEconomics({
      provider,
      modelId: bareId,
      liveEconomics: {
        billingUnit: "tokens",
        stale: false,
        tokenPrices: {
          default: {
            inputPer1k: runtimeModel.cost.input / 1000,
            outputPer1k: runtimeModel.cost.output / 1000,
            cachedInputPer1k: runtimeModel.cost.cacheRead / 1000,
            cachedOutputPer1k: runtimeModel.cost.cacheWrite / 1000,
          },
          ...(runtimeLongContextTiers?.length ? { longContextTiers: runtimeLongContextTiers } : {}),
        },
      },
    });
    const runtimeCost = runtimeEconomics.tokenPrices?.default.inputPer1k;
    if (runtimeCost !== undefined) return runtimeCost;
  }

  // A provider-qualified runtime model was matched but carries no meaningful
  // price (the registry's all-zero "unknown" placeholder). That is itself an
  // answer -- this specific provider/model pairing is unpriced -- so it must
  // not fall through to the shared bare-ID cost table, which is keyed only by
  // bare model ID and can otherwise silently inherit another provider's price
  // for the same-named model (e.g. github-copilot/gpt-5.5 picking up the
  // OpenAI/Codex entry).
  if (!runtimeModel) {
    if (MODEL_COST_PER_1K_INPUT[bareId] !== undefined) {
      return MODEL_COST_PER_1K_INPUT[bareId];
    }

    // Check partial matches
    for (const [knownId, cost] of Object.entries(MODEL_COST_PER_1K_INPUT)) {
      if (bareId.includes(knownId) || knownId.includes(bareId)) return cost;
    }
  }

  // Unknown cost — assume expensive to avoid routing to unknown cheap models
  warnUnknownRoutingModel(modelId);
  return 999;
}

function normalizeResolvedTierModelId(
  modelId: string,
  tier: ComplexityTier,
  routingConfig: DynamicRoutingConfig,
): string {
  const explicitModel = routingConfig.tier_models?.[tier];
  if (explicitModel?.includes("/")) {
    return modelId;
  }

  const canonicalId = canonicalizeModelId(modelId);
  if (!MODEL_CAPABILITY_TIER[canonicalId]) return modelId;
  return modelId.split("/").pop() ?? modelId;
}

// ─── Provider-specific Tool Limits ─────────────────────────────────────────

/**
 * Groq enforces a hard limit of 128 tools per request.
 * Requests exceeding this limit receive a 400 error:
 * "maximum number of items is 128"
 * @see https://console.groq.com/docs/tool-use
 */
export const GROQ_MAX_TOOLS = 128;

/**
 * Provider IDs that map to the Groq API backend.
 * Used to detect Groq at the GSD routing layer where only the provider string
 * is available (the pi-ai openai-completions adapter is shared across providers).
 */
const GROQ_PROVIDER_IDS = new Set(["groq"]);

// ─── Tool Compatibility Filter (ADR-005 Phase 3) ───────────────────────────

/**
 * Check if a tool is compatible with a provider's capabilities.
 * Returns true if the tool can be used with the provider.
 */
export function isToolCompatibleWithProvider(
  toolName: string,
  providerCaps: ProviderCapabilities,
): boolean {
  const compat = getToolCompatibility(toolName);
  if (!compat) return true;  // no metadata = always compatible

  // Hard filter: provider doesn't support image tool results
  if (compat.producesImages && !providerCaps.imageToolResults) return false;

  // Hard filter: tool uses schema features provider doesn't support
  if (compat.schemaFeatures?.some(f => providerCaps.unsupportedSchemaFeatures.includes(f))) {
    return false;
  }

  return true;
}

/**
 * Filter a list of tool names to only those compatible with a provider.
 * Used by the routing pipeline to adjust tool sets when switching providers.
 *
 * @param toolNames - The full list of active tool names to filter.
 * @param providerApi - The pi-ai API string (e.g. "openai-completions").
 * @param provider - Optional provider ID (e.g. "groq"). Used to apply
 *   provider-specific limits that can't be expressed as API-level capabilities
 *   (e.g. Groq's 128-tool hard limit on the shared openai-completions adapter).
 */
export function filterToolsForProvider(
  toolNames: string[],
  providerApi: string,
  provider?: string,
): { compatible: string[]; filtered: string[] } {
  const providerCaps = getProviderCapabilities(providerApi);

  // Provider doesn't support tool calling at all
  if (!providerCaps.toolCalling) {
    return { compatible: [], filtered: toolNames };
  }

  const compatible: string[] = [];
  const filtered: string[] = [];

  for (const name of toolNames) {
    if (isToolCompatibleWithProvider(name, providerCaps)) {
      compatible.push(name);
    } else {
      filtered.push(name);
    }
  }

  // Groq enforces a hard limit of 128 tools per request (#4376).
  // Trim the compatible list to GROQ_MAX_TOOLS and move the excess to filtered.
  if (provider && GROQ_PROVIDER_IDS.has(provider) && compatible.length > GROQ_MAX_TOOLS) {
    const trimmed = compatible.splice(GROQ_MAX_TOOLS);
    filtered.push(...trimmed);
    console.warn(
      `[gsd] Groq tool limit: ${compatible.length + trimmed.length} tools active but Groq allows at most ${GROQ_MAX_TOOLS}. ` +
        `Trimming to the first ${GROQ_MAX_TOOLS} tools. Removed: ${trimmed.join(", ")}`,
    );
  }

  return { compatible, filtered };
}

/**
 * Adjust the active tool set for a selected model's provider capabilities.
 * Returns tool names that should be active — removes incompatible tools.
 *
 * This is a hard filter only — it removes tools that would fail at the
 * provider level. It does NOT remove tools based on soft heuristics.
 *
 * @param activeToolNames - The full list of currently active tool names.
 * @param selectedModelApi - The pi-ai API string for the selected model.
 * @param provider - Optional provider ID (e.g. "groq") for provider-specific
 *   limits beyond what the API-level capability profile expresses.
 */
export function adjustToolSet(
  activeToolNames: string[],
  selectedModelApi: string,
  provider?: string,
): { toolNames: string[]; removedTools: string[] } {
  const { compatible, filtered } = filterToolsForProvider(activeToolNames, selectedModelApi, provider);
  return { toolNames: compatible, removedTools: filtered };
}
