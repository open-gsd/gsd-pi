// GSD Extension — Model Cost Table
// Static cost reference for known models, used by the dynamic router
// for cross-provider cost comparison.
//
// Costs are approximate per-1K-token rates in USD (input tokens).
// Updated with GSD releases. Users can override via preferences.

export interface ModelCostEntry {
  /** Model ID (bare, without provider prefix) */
  id: string;
  /** Approximate cost per 1K input tokens in USD */
  inputPer1k: number;
  /** Approximate cost per 1K output tokens in USD */
  outputPer1k: number;
  /** Input-token-based long-context pricing tiers, when published */
  tiers?: Array<{
    inputTokensAbove: number;
    inputPer1k: number;
    outputPer1k: number;
  }>;
  /** Last updated date */
  updatedAt: string;
}

export type RuntimeEconomicsSource =
  | "user"
  | "provider-live"
  | "provider-static"
  | "bundled-fallback"
  | "mixed"
  | "unknown";

export type RuntimeEconomicsFreshness = "fresh" | "stale" | "unknown";

export interface TokenPriceTier {
  inputPer1k: number;
  outputPer1k: number;
  cachedInputPer1k?: number;
  cachedOutputPer1k?: number;
  inputTokensAbove?: number;
}

export interface RuntimePromotion {
  discountPercent?: number;
  startsAt?: string;
  endsAt?: string;
  message?: string;
  status?: "active" | "future" | "expired" | "unknown";
}

export interface RuntimeEconomicsFieldResolution {
  source: RuntimeEconomicsSource;
  freshness: RuntimeEconomicsFreshness;
  fetchedAt?: number;
}

export interface RuntimeEconomicsProvenance {
  billingUnit: RuntimeEconomicsFieldResolution;
  defaultTokenPrices?: RuntimeEconomicsFieldResolution;
  longContextTiers?: RuntimeEconomicsFieldResolution;
  requestMultiplier?: RuntimeEconomicsFieldResolution;
  promotion?: RuntimeEconomicsFieldResolution;
}

export interface RuntimeModelEconomics {
  provider: string;
  modelId: string;
  source: RuntimeEconomicsSource;
  fetchedAt?: number;
  stale: boolean;
  billingUnit: "tokens" | "request" | "unknown";
  tokenPrices?: {
    default: TokenPriceTier;
    longContext?: TokenPriceTier;
    longContextTiers?: Array<TokenPriceTier & { inputTokensAbove: number }>;
  };
  requestMultiplier?: number;
  promotion?: RuntimePromotion;
  provenance: RuntimeEconomicsProvenance;
}

export interface ResolveModelEconomicsInput {
  provider: string;
  modelId: string;
  userOverride?: Partial<RuntimeModelEconomics>;
  liveEconomics?: Partial<RuntimeModelEconomics>;
  staticEconomics?: Partial<RuntimeModelEconomics>;
  fallbackEconomics?: Partial<RuntimeModelEconomics>;
  /**
   * Skip the built-in bare-model-ID bundled-cost-table lookup. BUNDLED_COST_TABLE
   * entries are not provider-qualified, so for callers whose own static/live data
   * doesn't cover every model, this implicit fallback can silently apply a
   * different provider's price to a same-named model. Callers that would rather
   * report unknown pricing than risk a wrong cross-provider guess should set this.
   */
  disableImplicitFallback?: boolean;
}

function stripProviderPrefix(modelId: string): string {
  if (!modelId.includes("/")) return modelId;
  return modelId.split("/").pop() ?? modelId;
}

function toFiniteNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  }
  return undefined;
}

function normalizeTokenPriceTier(value: unknown): TokenPriceTier | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const inputPer1k = toFiniteNonNegativeNumber(record.inputPer1k);
  const outputPer1k = toFiniteNonNegativeNumber(record.outputPer1k);
  if (inputPer1k === undefined || outputPer1k === undefined) return undefined;

  const cachedInputPer1k = toFiniteNonNegativeNumber(record.cachedInputPer1k);
  const cachedOutputPer1k = toFiniteNonNegativeNumber(record.cachedOutputPer1k);
  const inputTokensAbove = toFiniteNonNegativeNumber(record.inputTokensAbove);

  return {
    inputPer1k,
    outputPer1k,
    ...(cachedInputPer1k !== undefined ? { cachedInputPer1k } : {}),
    ...(cachedOutputPer1k !== undefined ? { cachedOutputPer1k } : {}),
    ...(inputTokensAbove !== undefined ? { inputTokensAbove } : {}),
  };
}

function normalizeLongContextTiers(
  value: unknown,
): Array<TokenPriceTier & { inputTokensAbove: number }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const tiers = value
    .map((entry) => normalizeTokenPriceTier(entry))
    .filter(
      (entry): entry is TokenPriceTier & { inputTokensAbove: number } =>
        !!entry && typeof entry.inputTokensAbove === "number",
    )
    .sort((a, b) => a.inputTokensAbove - b.inputTokensAbove);
  return tiers.length > 0 ? tiers : undefined;
}

function computePromotionStatus(
  startsAt?: string,
  endsAt?: string,
  now = Date.now(),
): RuntimePromotion["status"] {
  const startsAtMs = startsAt ? Date.parse(startsAt) : Number.NaN;
  const endsAtMs = endsAt ? Date.parse(endsAt) : Number.NaN;

  if (Number.isFinite(startsAtMs) && startsAtMs > now) return "future";
  if (Number.isFinite(endsAtMs) && endsAtMs < now) return "expired";
  if (Number.isFinite(startsAtMs) || Number.isFinite(endsAtMs)) return "active";
  return "unknown";
}

function normalizePromotion(value: unknown): RuntimePromotion | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const discountPercent = toFiniteNonNegativeNumber(
    record.discountPercent ?? record.discount_percent,
  );
  const startsAt = typeof (record.startsAt ?? record.starts_at) === "string"
    ? String(record.startsAt ?? record.starts_at)
    : undefined;
  const endsAt = typeof (record.endsAt ?? record.ends_at) === "string"
    ? String(record.endsAt ?? record.ends_at)
    : undefined;
  const message = typeof record.message === "string" ? record.message : undefined;

  if (
    discountPercent === undefined
    && startsAt === undefined
    && endsAt === undefined
    && message === undefined
  ) {
    return undefined;
  }

  return {
    ...(discountPercent !== undefined ? { discountPercent } : {}),
    ...(startsAt !== undefined ? { startsAt } : {}),
    ...(endsAt !== undefined ? { endsAt } : {}),
    ...(message !== undefined ? { message } : {}),
    status: computePromotionStatus(startsAt, endsAt),
  };
}

function freshnessFor(
  source: RuntimeEconomicsSource,
  stale: boolean | undefined,
): RuntimeEconomicsFreshness {
  if (source === "unknown") return "unknown";
  if (source === "user") return "fresh";
  if (source === "provider-live") return stale === false ? "fresh" : "stale";
  return "stale";
}

function resolutionFor(
  source: RuntimeEconomicsSource,
  candidate: Partial<RuntimeModelEconomics> | undefined,
): RuntimeEconomicsFieldResolution {
  return {
    source,
    freshness: freshnessFor(source, candidate?.stale),
    ...(typeof candidate?.fetchedAt === "number" ? { fetchedAt: candidate.fetchedAt } : {}),
  };
}

function hasMeaningfulEconomics(value: Partial<RuntimeModelEconomics> | undefined): value is Partial<RuntimeModelEconomics> {
  return !!value && Object.keys(value).length > 0;
}

function buildDefaultTokenPricesFromBundle(modelId: string): RuntimeModelEconomics["tokenPrices"] | undefined {
  const bareId = stripProviderPrefix(modelId);
  const costEntry = lookupModelCost(bareId);
  if (!costEntry) return undefined;

  return {
    default: {
      inputPer1k: costEntry.inputPer1k,
      outputPer1k: costEntry.outputPer1k,
    },
    ...(costEntry.tiers?.length
      ? {
          longContextTiers: costEntry.tiers.map((tier) => ({
            inputTokensAbove: tier.inputTokensAbove,
            inputPer1k: tier.inputPer1k,
            outputPer1k: tier.outputPer1k,
          })),
        }
      : {}),
  };
}

function buildImplicitFallbackEconomics(
  modelId: string,
): Partial<RuntimeModelEconomics> | undefined {
  const tokenPrices = buildDefaultTokenPricesFromBundle(modelId);
  if (!tokenPrices?.default) return undefined;
  return {
    billingUnit: "tokens",
    tokenPrices,
    stale: true,
  };
}

function firstResolvedField<T>(
  candidates: Array<{
    source: RuntimeEconomicsSource;
    candidate: Partial<RuntimeModelEconomics> | undefined;
    value: T | undefined;
  }>,
): { value?: T; resolution: RuntimeEconomicsFieldResolution } {
  for (const { source, candidate, value } of candidates) {
    if (value === undefined) continue;
    return { value, resolution: resolutionFor(source, candidate) };
  }
  return { resolution: { source: "unknown", freshness: "unknown" } };
}

export function resolveModelEconomics(input: ResolveModelEconomicsInput): RuntimeModelEconomics {
  const modelId = stripProviderPrefix(input.modelId || "unknown");
  const provider = input.provider || input.userOverride?.provider || input.liveEconomics?.provider || input.staticEconomics?.provider || input.fallbackEconomics?.provider || "unknown";
  const implicitFallback = input.disableImplicitFallback ? undefined : buildImplicitFallbackEconomics(modelId);
  const fallbackEconomics = hasMeaningfulEconomics(input.fallbackEconomics)
    ? {
        ...implicitFallback,
        ...input.fallbackEconomics,
        tokenPrices: input.fallbackEconomics?.tokenPrices ?? implicitFallback?.tokenPrices,
      }
    : implicitFallback;

  const precedence: Array<{
    source: RuntimeEconomicsSource;
    candidate: Partial<RuntimeModelEconomics> | undefined;
  }> = [
    { source: "user", candidate: hasMeaningfulEconomics(input.userOverride) ? input.userOverride : undefined },
    { source: "provider-live", candidate: hasMeaningfulEconomics(input.liveEconomics) ? input.liveEconomics : undefined },
    { source: "provider-static", candidate: hasMeaningfulEconomics(input.staticEconomics) ? input.staticEconomics : undefined },
    { source: "bundled-fallback", candidate: hasMeaningfulEconomics(fallbackEconomics) ? fallbackEconomics : undefined },
  ];

  const billingUnit = firstResolvedField(
    precedence.map(({ source, candidate }) => ({
      source,
      candidate,
      value: candidate?.billingUnit === "tokens" || candidate?.billingUnit === "request" || candidate?.billingUnit === "unknown"
        ? candidate.billingUnit
        : undefined,
    })),
  );

  const defaultTokenPrices = firstResolvedField(
    precedence.map(({ source, candidate }) => ({
      source,
      candidate,
      value: normalizeTokenPriceTier(candidate?.tokenPrices?.default),
    })),
  );

  const longContextTiers = firstResolvedField(
    precedence.map(({ source, candidate }) => ({
      source,
      candidate,
      value: normalizeLongContextTiers(candidate?.tokenPrices?.longContextTiers)
        ?? (() => {
          const tier = normalizeTokenPriceTier(candidate?.tokenPrices?.longContext);
          return tier && typeof tier.inputTokensAbove === "number" ? [tier as TokenPriceTier & { inputTokensAbove: number }] : undefined;
        })(),
    })),
  );

  const requestMultiplier = firstResolvedField(
    precedence.map(({ source, candidate }) => ({
      source,
      candidate,
      value: toFiniteNonNegativeNumber(candidate?.requestMultiplier),
    })),
  );

  const promotion = firstResolvedField(
    precedence.map(({ source, candidate }) => ({
      source,
      candidate,
      value: normalizePromotion(candidate?.promotion),
    })),
  );

  const usedSources = [
    billingUnit.resolution.source,
    defaultTokenPrices.resolution.source,
    longContextTiers.resolution.source,
    requestMultiplier.resolution.source,
    promotion.resolution.source,
  ].filter((source) => source !== "unknown");

  const source = usedSources.length === 0
    ? "unknown"
    : usedSources.every((candidate) => candidate === usedSources[0])
      ? usedSources[0]
      : "mixed";

  const fetchedAt = [
    billingUnit.resolution.fetchedAt,
    defaultTokenPrices.resolution.fetchedAt,
    longContextTiers.resolution.fetchedAt,
    requestMultiplier.resolution.fetchedAt,
    promotion.resolution.fetchedAt,
  ]
    .filter((value): value is number => typeof value === "number")
    .sort((a, b) => b - a)[0];

  const stale = [
    billingUnit.resolution.freshness,
    defaultTokenPrices.resolution.freshness,
    longContextTiers.resolution.freshness,
    requestMultiplier.resolution.freshness,
    promotion.resolution.freshness,
  ].includes("stale");

  return {
    provider,
    modelId,
    source,
    ...(fetchedAt !== undefined ? { fetchedAt } : {}),
    stale,
    billingUnit: billingUnit.value ?? (defaultTokenPrices.value ? "tokens" : "unknown"),
    ...(defaultTokenPrices.value
      ? {
          tokenPrices: {
            default: defaultTokenPrices.value,
            ...(longContextTiers.value?.[0] ? { longContext: longContextTiers.value[0] } : {}),
            ...(longContextTiers.value ? { longContextTiers: longContextTiers.value } : {}),
          },
        }
      : {}),
    ...(requestMultiplier.value !== undefined ? { requestMultiplier: requestMultiplier.value } : {}),
    ...(promotion.value ? { promotion: promotion.value } : {}),
    provenance: {
      billingUnit: billingUnit.resolution,
      ...(defaultTokenPrices.value ? { defaultTokenPrices: defaultTokenPrices.resolution } : {}),
      ...(longContextTiers.value ? { longContextTiers: longContextTiers.resolution } : {}),
      ...(requestMultiplier.value !== undefined ? { requestMultiplier: requestMultiplier.resolution } : {}),
      ...(promotion.value ? { promotion: promotion.resolution } : {}),
    },
  };
}

/**
 * Bundled cost table for known models.
 * Updated periodically with GSD releases.
 */
export const BUNDLED_COST_TABLE: ModelCostEntry[] = [
  // Anthropic
  { id: "claude-opus-4-6", inputPer1k: 0.005, outputPer1k: 0.025, updatedAt: "2026-04-16" },
  { id: "claude-opus-4-7", inputPer1k: 0.005, outputPer1k: 0.025, updatedAt: "2026-04-16" },
  { id: "claude-opus-4-8", inputPer1k: 0.005, outputPer1k: 0.025, updatedAt: "2026-05-28" },
  { id: "claude-opus-5", inputPer1k: 0.005, outputPer1k: 0.025, updatedAt: "2026-08-12" },
  { id: "claude-fable-5", inputPer1k: 0.010, outputPer1k: 0.050, updatedAt: "2026-06-09" },
  { id: "claude-sonnet-4-6", inputPer1k: 0.003, outputPer1k: 0.015, updatedAt: "2025-03-15" },
  { id: "claude-sonnet-5", inputPer1k: 0.003, outputPer1k: 0.015, updatedAt: "2026-08-12" },
  { id: "claude-haiku-4-5", inputPer1k: 0.0008, outputPer1k: 0.004, updatedAt: "2025-03-15" },
  { id: "claude-sonnet-4-5-20250514", inputPer1k: 0.003, outputPer1k: 0.015, updatedAt: "2025-03-15" },
  { id: "claude-3-5-sonnet-latest", inputPer1k: 0.003, outputPer1k: 0.015, updatedAt: "2025-03-15" },
  { id: "claude-3-5-haiku-latest", inputPer1k: 0.0008, outputPer1k: 0.004, updatedAt: "2025-03-15" },
  { id: "claude-3-opus-latest", inputPer1k: 0.015, outputPer1k: 0.075, updatedAt: "2025-03-15" },

  // OpenAI
  { id: "gpt-4o", inputPer1k: 0.0025, outputPer1k: 0.01, updatedAt: "2025-03-15" },
  { id: "gpt-4o-mini", inputPer1k: 0.00015, outputPer1k: 0.0006, updatedAt: "2025-03-15" },
  { id: "gpt-4.1", inputPer1k: 0.002, outputPer1k: 0.008, updatedAt: "2026-03-29" },
  { id: "gpt-4.1-mini", inputPer1k: 0.0004, outputPer1k: 0.0016, updatedAt: "2026-03-29" },
  { id: "gpt-4.1-nano", inputPer1k: 0.0001, outputPer1k: 0.0004, updatedAt: "2026-03-29" },
  { id: "gpt-5", inputPer1k: 0.01, outputPer1k: 0.04, updatedAt: "2026-03-29" },
  { id: "gpt-5-mini", inputPer1k: 0.0003, outputPer1k: 0.0012, updatedAt: "2026-03-29" },
  { id: "gpt-5-nano", inputPer1k: 0.0001, outputPer1k: 0.0004, updatedAt: "2026-03-29" },
  { id: "gpt-5-pro", inputPer1k: 0.015, outputPer1k: 0.06, updatedAt: "2026-03-29" },
  { id: "o1", inputPer1k: 0.015, outputPer1k: 0.06, updatedAt: "2025-03-15" },
  { id: "o3", inputPer1k: 0.015, outputPer1k: 0.06, updatedAt: "2025-03-15" },
  { id: "o4-mini", inputPer1k: 0.005, outputPer1k: 0.02, updatedAt: "2026-03-29" },
  { id: "o4-mini-deep-research", inputPer1k: 0.005, outputPer1k: 0.02, updatedAt: "2026-03-29" },
  { id: "gpt-4-turbo", inputPer1k: 0.01, outputPer1k: 0.03, updatedAt: "2025-03-15" },

  // OpenAI Codex
  { id: "gpt-5.1", inputPer1k: 0.005, outputPer1k: 0.02, updatedAt: "2026-03-29" },
  { id: "gpt-5.1-codex-max", inputPer1k: 0.003, outputPer1k: 0.012, updatedAt: "2026-03-29" },
  { id: "gpt-5.1-codex-mini", inputPer1k: 0.0003, outputPer1k: 0.0012, updatedAt: "2026-03-29" },
  { id: "gpt-5.2", inputPer1k: 0.005, outputPer1k: 0.02, updatedAt: "2026-03-29" },
  { id: "gpt-5.2-codex", inputPer1k: 0.005, outputPer1k: 0.02, updatedAt: "2026-03-29" },
  { id: "gpt-5.3-codex", inputPer1k: 0.005, outputPer1k: 0.02, updatedAt: "2026-03-29" },
  { id: "gpt-5.3-codex-spark", inputPer1k: 0.0003, outputPer1k: 0.0012, updatedAt: "2026-03-29" },
  { id: "gpt-5.4", inputPer1k: 0.005, outputPer1k: 0.02, updatedAt: "2026-03-29" },
  { id: "gpt-5.4-mini", inputPer1k: 0.00075, outputPer1k: 0.0045, updatedAt: "2026-04-18" },
  // GPT-5.5 API list price, also used for live Codex OAuth routing.
  // Source: https://openai.com/api/pricing/
  { id: "gpt-5.5", inputPer1k: 0.005, outputPer1k: 0.03, updatedAt: "2026-04-23" },
  { id: "gpt-5.6-sol", inputPer1k: 0.005, outputPer1k: 0.03, tiers: [{ inputTokensAbove: 272000, inputPer1k: 0.01, outputPer1k: 0.045 }], updatedAt: "2026-07-11" },
  { id: "gpt-5.6-terra", inputPer1k: 0.0025, outputPer1k: 0.015, tiers: [{ inputTokensAbove: 272000, inputPer1k: 0.005, outputPer1k: 0.0225 }], updatedAt: "2026-07-11" },
  { id: "gpt-5.6-luna", inputPer1k: 0.001, outputPer1k: 0.006, tiers: [{ inputTokensAbove: 272000, inputPer1k: 0.002, outputPer1k: 0.009 }], updatedAt: "2026-07-11" },
  { id: "gpt-6-astra", inputPer1k: 0.01, outputPer1k: 0.05, tiers: [{ inputTokensAbove: 272000, inputPer1k: 0.02, outputPer1k: 0.075 }], updatedAt: "2026-09-04" },

  // GitHub Copilot
  { id: "mai-code-1.1-flash", inputPer1k: 0.0002, outputPer1k: 0.0012, updatedAt: "2026-08-14" },

  // Google
  { id: "gemini-2.0-flash", inputPer1k: 0.0001, outputPer1k: 0.0004, updatedAt: "2025-03-15" },
  { id: "gemini-flash-2.0", inputPer1k: 0.0001, outputPer1k: 0.0004, updatedAt: "2025-03-15" },
  { id: "gemini-2.5-pro", inputPer1k: 0.00125, outputPer1k: 0.005, updatedAt: "2025-03-15" },

  // DeepSeek
  { id: "deepseek-chat", inputPer1k: 0.00014, outputPer1k: 0.00028, updatedAt: "2025-03-15" },
];

/**
 * Lookup cost for a model ID. Returns undefined if not found.
 */
export function lookupModelCost(modelId: string): ModelCostEntry | undefined {
  const bareId = modelId.includes("/") ? (modelId.split("/").pop() ?? modelId) : modelId;
  return BUNDLED_COST_TABLE.find(e => e.id === bareId)
    ?? BUNDLED_COST_TABLE.find(e =>
      bareId.startsWith(`${e.id}-`) ||
      bareId.startsWith(`${e.id}:`) ||
      bareId.startsWith(`${e.id}@`)
    );
}

/**
 * Compare two models by input cost. Returns negative if a is cheaper.
 */
export function compareModelCost(modelIdA: string, modelIdB: string): number {
  const costA = lookupModelCost(modelIdA)?.inputPer1k ?? 999;
  const costB = lookupModelCost(modelIdB)?.inputPer1k ?? 999;
  return costA - costB;
}
