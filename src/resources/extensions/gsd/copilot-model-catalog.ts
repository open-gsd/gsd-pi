/**
 * GitHub Copilot model catalog — read-only fetch/normalize/diff pipeline.
 *
 * The normalized record intentionally keeps live-provider fields and
 * authoritative provider-static fallback separate in provenance rather than
 * flattening everything into one opaque string. Callers can then explain why a
 * model is usable, routable, quarantined, or priced the way it is without
 * inventing metadata or leaking auth material.
 */
import { createHash } from "node:crypto";

import { type Api, getModels, getSupportedThinkingLevels, type Model, type ModelThinkingLevel } from "@gsd/pi-ai";

/** Copilot client-identity headers the /models endpoint's policy enforcement expects — mirrors COPILOT_HEADERS in packages/pi-ai/src/utils/oauth/github-copilot.ts. */
const COPILOT_MODELS_REQUEST_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
});

export type GitHubCopilotProvider = "github-copilot" | "openai" | "anthropic" | "google" | "unknown";
export type CopilotFieldSource = "provider-live" | "provider-static" | "bundled-fallback" | "user" | "unknown";
export type CopilotFieldFreshness = "fresh" | "stale" | "unknown";
export type CopilotPolicyState = "enabled" | "disabled" | "restricted" | "unknown";

export interface CopilotFieldProvenance {
  source: CopilotFieldSource;
  freshness: CopilotFieldFreshness;
  fetchedAt?: string;
}

export interface CopilotLongContextTier {
  inputTokensAbove: number;
  inputPer1k?: number;
  outputPer1k?: number;
  cacheReadPer1k?: number;
  cacheWritePer1k?: number;
}

export interface CopilotPromotion {
  discountPercent?: number;
  startsAt?: string;
  endsAt?: string;
  message?: string;
  status: "active" | "future" | "expired" | "unknown";
}

export interface CopilotModelRecord {
  provider: "github-copilot";
  id: string;
  registryId: string;
  name: string;
  vendor?: string;
  version?: string;
  availability: {
    enabled?: boolean;
    pickerEnabled?: boolean;
    preview?: boolean;
    policyState: CopilotPolicyState;
  };
  execution: {
    api?: Api;
    supportedEndpoints: string[];
    toolCalls?: boolean;
    parallelToolCalls?: boolean;
    streaming?: boolean;
    vision?: boolean;
    reasoning?: boolean;
    reasoningLevels: string[];
    reasoningLevelMap?: NonNullable<Model<Api>["thinkingLevelMap"]>;
    reasoningEffortCompatible?: boolean;
    contextWindow?: number;
    maxTokens?: number;
  };
  billing: {
    billingUnit: "tokens" | "request" | "unknown";
    inputPer1k?: number;
    outputPer1k?: number;
    cacheReadPer1k?: number;
    cacheWritePer1k?: number;
    longContextTiers?: CopilotLongContextTier[];
    requestMultiplier?: number;
    autoDiscount?: number;
    promotion?: CopilotPromotion;
  };
  provenance: {
    displayName: CopilotFieldProvenance;
    availability: CopilotFieldProvenance;
    endpoints: CopilotFieldProvenance;
    reasoning: CopilotFieldProvenance;
    limits: CopilotFieldProvenance;
    billingUnit: CopilotFieldProvenance;
    tokenPrices: CopilotFieldProvenance;
    requestMultiplier: CopilotFieldProvenance;
    promotion: CopilotFieldProvenance;
  };
  conflicts: string[];
  hash: string;
}

export interface CopilotModelSnapshot {
  generatedAt: string;
  hash: string;
  modelCount: number;
  models: CopilotModelRecord[];
}

export interface FetchCopilotModelsOptions {
  provider: GitHubCopilotProvider;
  authToken?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface FetchCopilotModelsResult {
  skipped?: boolean;
  reason?: string;
  models: CopilotModelRecord[];
  snapshot?: CopilotModelSnapshot;
}

export class CopilotCatalogFetchError extends Error {
  readonly kind: "unauthorized" | "forbidden" | "rate-limited" | "server" | "network" | "timeout" | "aborted" | "malformed";
  readonly status?: number;

  constructor(
    kind: "unauthorized" | "forbidden" | "rate-limited" | "server" | "network" | "timeout" | "aborted" | "malformed",
    message: string,
    status?: number,
  ) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.name = "CopilotCatalogFetchError";
  }
}

const DEFAULT_TIMEOUT_MS = 5_000;
const COPILOT_STATIC_MODELS = getModels("github-copilot") as Array<Model<Api>>;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ModelThinkingLevel[];

type CopilotThinkingLevel = (typeof THINKING_LEVELS)[number];

interface LiveReasoningLevels {
  present: boolean;
  levels: CopilotThinkingLevel[];
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashValue(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableProvenanceForHash(
  provenance: CopilotModelRecord["provenance"],
): CopilotModelRecord["provenance"] {
  const stripFetchedAt = (field: CopilotFieldProvenance): CopilotFieldProvenance => ({
    source: field.source,
    freshness: field.freshness,
  });

  return {
    displayName: stripFetchedAt(provenance.displayName),
    availability: stripFetchedAt(provenance.availability),
    endpoints: stripFetchedAt(provenance.endpoints),
    reasoning: stripFetchedAt(provenance.reasoning),
    limits: stripFetchedAt(provenance.limits),
    billingUnit: stripFetchedAt(provenance.billingUnit),
    tokenPrices: stripFetchedAt(provenance.tokenPrices),
    requestMultiplier: stripFetchedAt(provenance.requestMultiplier),
    promotion: stripFetchedAt(provenance.promotion),
  };
}

function toTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return undefined;
}

function toFinitePositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined;
  }
  return undefined;
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

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => toTrimmedString(entry))
    .filter((entry): entry is string => !!entry);
}

function normalizeLiveReasoningLevels(record: Record<string, unknown>): LiveReasoningLevels {
  const capabilities = toRecord(record.capabilities);
  const supports = toRecord(capabilities?.supports);
  const nested = supports?.reasoning_effort;
  const values = [
    record.reasoning_levels,
    record.supported_reasoning_efforts,
    record.supportedReasoningEfforts,
    record.reasoning_efforts,
    ...(typeof nested === "boolean" ? [] : [nested]),
  ];
  const present = values.some((value) => value !== undefined);
  if (!present) return { present: false, levels: [] };
  if (values.some((value) => value !== undefined && !Array.isArray(value))) {
    return { present: true, levels: [] };
  }

  function toRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  }

  const candidates = values.filter(Array.isArray);
  const supportedByCandidate = candidates.map((candidate) => {
    if (candidate.some((entry) => typeof entry !== "string"
      || !THINKING_LEVELS.some((level) => level === entry.trim().toLowerCase()))) {
      return new Set<CopilotThinkingLevel>();
    }
    return new Set(normalizeStringArray(candidate).map((level) => level.toLowerCase() as CopilotThinkingLevel));
  });
  const sharedLevels = new Set(supportedByCandidate[0]);
  for (const candidate of supportedByCandidate.slice(1)) {
    for (const level of sharedLevels) {
      if (!candidate.has(level)) sharedLevels.delete(level);
    }
  }

  return {
    present: true,
    levels: THINKING_LEVELS.filter((level) => sharedLevels.has(level)),
  };
}

function createThinkingLevelMap(
  supportedLevels: readonly ModelThinkingLevel[],
  sourceMap?: Model<Api>["thinkingLevelMap"],
): NonNullable<Model<Api>["thinkingLevelMap"]> {
  const supported = new Set(supportedLevels);
  const map: NonNullable<Model<Api>["thinkingLevelMap"]> = {};
  for (const level of THINKING_LEVELS) {
    map[level] = supported.has(level) ? sourceMap?.[level] ?? level : null;
  }
  return map;
}

function buildProvenance(
  source: CopilotFieldSource,
  generatedAt?: string,
  freshness?: CopilotFieldFreshness,
): CopilotFieldProvenance {
  return {
    source,
    freshness: freshness ?? (source === "provider-live" ? "fresh" : source === "unknown" ? "unknown" : "stale"),
    ...(generatedAt ? { fetchedAt: generatedAt } : {}),
  };
}

function findStaticCopilotModel(modelId: string): Model<Api> | undefined {
  return COPILOT_STATIC_MODELS.find((model) => model.id === modelId);
}

export { findStaticCopilotModel };

function isOpenAICompletionsModel(model: Model<Api> | undefined): model is Model<"openai-completions"> {
  return model?.api === "openai-completions";
}

function isAnthropicModel(model: Model<Api> | undefined): model is Model<"anthropic-messages"> {
  return model?.api === "anthropic-messages";
}

function endpointsFromApi(api: Api): string[] {
  switch (api) {
    case "anthropic-messages":
      return ["/v1/messages"];
    case "openai-responses":
      return ["/responses"];
    case "openai-completions":
      return ["/chat/completions"];
    default:
      return [];
  }
}

function mapEndpointToApi(endpoint: string): Api | undefined {
  const normalized = endpoint.trim().toLowerCase();
  if (
    normalized.includes("/v1/messages")
    || normalized.includes("anthropic-messages")
    || normalized === "messages"
  ) {
    return "anthropic-messages";
  }
  if (
    normalized.includes("/responses")
    || normalized.includes("websocket-responses")
    || normalized.includes("openai-responses")
    || normalized === "responses"
  ) {
    return "openai-responses";
  }
  if (
    normalized.includes("/chat/completions")
    || normalized.includes("openai-completions")
    || normalized === "chat/completions"
  ) {
    return "openai-completions";
  }
  return undefined;
}

function computePromotionStatus(startsAt?: string, endsAt?: string): CopilotPromotion["status"] {
  const now = Date.now();
  const startsAtMs = startsAt ? Date.parse(startsAt) : Number.NaN;
  const endsAtMs = endsAt ? Date.parse(endsAt) : Number.NaN;
  if (Number.isFinite(startsAtMs) && startsAtMs > now) return "future";
  if (Number.isFinite(endsAtMs) && endsAtMs < now) return "expired";
  if (Number.isFinite(startsAtMs) || Number.isFinite(endsAtMs)) return "active";
  return "unknown";
}

function extractPromotion(record: Record<string, unknown>): CopilotPromotion | undefined {
  const raw = (record.promotion ?? record.promo) as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") return undefined;
  const discountPercent = toFiniteNonNegativeNumber(raw.discountPercent ?? raw.discount_percent);
  const startsAt = toTrimmedString(raw.startsAt ?? raw.starts_at);
  const endsAt = toTrimmedString(raw.endsAt ?? raw.ends_at);
  const message = toTrimmedString(raw.message);
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
    ...(startsAt ? { startsAt } : {}),
    ...(endsAt ? { endsAt } : {}),
    ...(message ? { message } : {}),
    status: computePromotionStatus(startsAt, endsAt),
  };
}

function extractLivePricing(record: Record<string, unknown>) {
  const tokenPricesRoot = (record.tokenPrices ?? record.token_prices) as Record<string, unknown> | undefined;
  const pricingRoot = (record.pricing ?? record.cost) as Record<string, unknown> | undefined;

  const explicitInputPer1k = toFiniteNonNegativeNumber(
    tokenPricesRoot?.default && typeof tokenPricesRoot.default === "object"
      ? (tokenPricesRoot.default as Record<string, unknown>).inputPer1k
      : undefined,
  );
  const explicitOutputPer1k = toFiniteNonNegativeNumber(
    tokenPricesRoot?.default && typeof tokenPricesRoot.default === "object"
      ? (tokenPricesRoot.default as Record<string, unknown>).outputPer1k
      : undefined,
  );
  const explicitCacheReadPer1k = toFiniteNonNegativeNumber(
    tokenPricesRoot?.default && typeof tokenPricesRoot.default === "object"
      ? (tokenPricesRoot.default as Record<string, unknown>).cachedInputPer1k
      : undefined,
  );
  const explicitCacheWritePer1k = toFiniteNonNegativeNumber(
    tokenPricesRoot?.default && typeof tokenPricesRoot.default === "object"
      ? (tokenPricesRoot.default as Record<string, unknown>).cachedOutputPer1k
      : undefined,
  );

  const legacyInputPerMillion = toFiniteNonNegativeNumber(pricingRoot?.input ?? pricingRoot?.input_price ?? pricingRoot?.prompt);
  const legacyOutputPerMillion = toFiniteNonNegativeNumber(pricingRoot?.output ?? pricingRoot?.output_price ?? pricingRoot?.completion);
  // Some Copilot-fronted models report cost as a per-single-token rate (the same
  // LiteLLM-style shape used by input_cost_per_token/output_cost_per_token elsewhere)
  // rather than per-1K or per-million — convert to per-1K.
  const perTokenInputPer1k = (() => {
    const value = toFiniteNonNegativeNumber(pricingRoot?.input_cost_per_token);
    return value !== undefined ? value * 1000 : undefined;
  })();
  const perTokenOutputPer1k = (() => {
    const value = toFiniteNonNegativeNumber(pricingRoot?.output_cost_per_token);
    return value !== undefined ? value * 1000 : undefined;
  })();
  const legacyCacheReadPerMillion = toFiniteNonNegativeNumber(pricingRoot?.cache_read ?? pricingRoot?.input_cache_read);
  const legacyCacheWritePerMillion = toFiniteNonNegativeNumber(pricingRoot?.cache_write ?? pricingRoot?.input_cache_write);

  const inputPer1k = explicitInputPer1k ?? perTokenInputPer1k ?? (legacyInputPerMillion !== undefined ? legacyInputPerMillion / 1000 : undefined);
  const outputPer1k = explicitOutputPer1k ?? perTokenOutputPer1k ?? (legacyOutputPerMillion !== undefined ? legacyOutputPerMillion / 1000 : undefined);
  const cacheReadPer1k = explicitCacheReadPer1k ?? (legacyCacheReadPerMillion !== undefined ? legacyCacheReadPerMillion / 1000 : undefined);
  const cacheWritePer1k = explicitCacheWritePer1k ?? (legacyCacheWritePerMillion !== undefined ? legacyCacheWritePerMillion / 1000 : undefined);

  const longContextSource = (pricingRoot?.tiers ?? tokenPricesRoot?.longContextTiers ?? tokenPricesRoot?.long_context_tiers) as unknown;
  const longContextTiers = Array.isArray(longContextSource)
    ? longContextSource
        .map((entry) => {
          if (!entry || typeof entry !== "object") return undefined;
          const tier = entry as Record<string, unknown>;
          const inputTokensAbove = toFinitePositiveInteger(tier.inputTokensAbove ?? tier.input_tokens_above);
          if (inputTokensAbove === undefined) return undefined;
          const longInput = toFiniteNonNegativeNumber(tier.inputPer1k) ?? (() => {
            const value = toFiniteNonNegativeNumber(tier.input);
            return value !== undefined ? value / 1000 : undefined;
          })();
          const longOutput = toFiniteNonNegativeNumber(tier.outputPer1k) ?? (() => {
            const value = toFiniteNonNegativeNumber(tier.output);
            return value !== undefined ? value / 1000 : undefined;
          })();
          const longCacheRead = toFiniteNonNegativeNumber(tier.cacheReadPer1k) ?? (() => {
            const value = toFiniteNonNegativeNumber(tier.cache_read ?? tier.cacheRead);
            return value !== undefined ? value / 1000 : undefined;
          })();
          const longCacheWrite = toFiniteNonNegativeNumber(tier.cacheWritePer1k) ?? (() => {
            const value = toFiniteNonNegativeNumber(tier.cache_write ?? tier.cacheWrite);
            return value !== undefined ? value / 1000 : undefined;
          })();
          if (longInput === undefined && longOutput === undefined && longCacheRead === undefined && longCacheWrite === undefined) {
            return undefined;
          }
          return {
            inputTokensAbove,
            ...(longInput !== undefined ? { inputPer1k: longInput } : {}),
            ...(longOutput !== undefined ? { outputPer1k: longOutput } : {}),
            ...(longCacheRead !== undefined ? { cacheReadPer1k: longCacheRead } : {}),
            ...(longCacheWrite !== undefined ? { cacheWritePer1k: longCacheWrite } : {}),
          } as CopilotLongContextTier;
        })
        .filter((tier): tier is CopilotLongContextTier => !!tier)
    : undefined;

  return {
    inputPer1k,
    outputPer1k,
    cacheReadPer1k,
    cacheWritePer1k,
    longContextTiers: longContextTiers && longContextTiers.length > 0 ? longContextTiers : undefined,
  };
}

function normalizePolicyState(record: Record<string, unknown>): CopilotPolicyState {
  const raw = toTrimmedString(record.policy_state ?? record.policyState ?? record.policy);
  if (raw === "enabled" || raw === "disabled" || raw === "restricted") return raw;
  const enabled = toBoolean(record.enabled);
  if (enabled === false) return "disabled";
  const restrictions = normalizeStringArray(record.restrictions);
  if (restrictions.length > 0) return "restricted";
  return "unknown";
}

function normalizeSupportedEndpoints(
  record: Record<string, unknown>,
  staticModel: Model<Api> | undefined,
): { api?: Api; supportedEndpoints: string[]; provenance: CopilotFieldProvenance; conflicts: string[] } {
  const liveEndpoints = [
    ...normalizeStringArray(record.supported_endpoints),
    ...normalizeStringArray(record.supportedEndpoints),
    ...normalizeStringArray(record.endpoints),
    ...(() => {
      const capabilities = record.capabilities as Record<string, unknown> | undefined;
      return capabilities ? normalizeStringArray(capabilities.supported_endpoints ?? capabilities.endpoints) : [];
    })(),
  ];
  const uniqueLiveEndpoints = [...new Set(liveEndpoints)];
  const liveApis = [...new Set(uniqueLiveEndpoints.map((endpoint) => mapEndpointToApi(endpoint)).filter((api): api is Api => !!api))];
  const staticEndpoints = staticModel ? endpointsFromApi(staticModel.api) : [];
  const staticApi = staticModel?.api;
  const chosenApi = staticApi && liveApis.includes(staticApi)
    ? staticApi
    : liveApis.length === 1
      ? liveApis[0]
      : liveApis.length === 0
        ? staticApi
        : undefined;
  const conflicts: string[] = [];

  if (liveApis.length > 1 && !chosenApi) {
    conflicts.push(`no canonical transport can be determined from endpoint alternatives: ${liveApis.join(", ")}`);
  }
  if (liveApis.length === 1 && staticApi && liveApis[0] !== staticApi) {
    conflicts.push(`provider-live transport ${liveApis[0]} conflicts with provider-static transport ${staticApi}`);
  }

  return {
    api: chosenApi,
    supportedEndpoints: uniqueLiveEndpoints.length > 0 ? uniqueLiveEndpoints : staticEndpoints,
    provenance: uniqueLiveEndpoints.length > 0
      ? buildProvenance("provider-live")
      : staticEndpoints.length > 0
        ? buildProvenance("provider-static")
        : buildProvenance("unknown"),
    conflicts,
  };
}

function normalizeGitHubCopilotModel(
  record: Record<string, unknown>,
  provider: GitHubCopilotProvider,
  generatedAt: string,
): CopilotModelRecord | null {
  const rawId = toTrimmedString(record.id);
  if (!rawId) return null;

  const staticModel = provider === "github-copilot" ? findStaticCopilotModel(rawId) : undefined;

  const liveName = toTrimmedString(record.name);
  const name = liveName ?? staticModel?.name ?? rawId;
  const displayNameProvenance = liveName
    ? buildProvenance("provider-live", generatedAt)
    : staticModel?.name
      ? buildProvenance("provider-static")
      : buildProvenance("unknown");

  const endpoints = normalizeSupportedEndpoints(record, staticModel);
  const liveToolCalls = toBoolean(
    record.tool_call
    ?? record.tool_calls
    ?? record.supports_tool_calls
    ?? (record.capabilities && typeof record.capabilities === "object" && !Array.isArray(record.capabilities)
      ? (record.capabilities as Record<string, unknown>).tool_calls
      : undefined),
  );
  const toolCalls = liveToolCalls;
  const liveReasoning = toBoolean(record.reasoning ?? record.thinking ?? record.supports_reasoning);
  const liveReasoningLevels = normalizeLiveReasoningLevels(record);
  const capabilities = record.capabilities && typeof record.capabilities === "object" && !Array.isArray(record.capabilities)
    ? record.capabilities as Record<string, unknown>
    : undefined;
  const capabilitySupports = capabilities?.supports && typeof capabilities.supports === "object" && !Array.isArray(capabilities.supports)
    ? capabilities.supports as Record<string, unknown>
    : undefined;
  const liveReasoningEffortSupport = typeof capabilitySupports?.reasoning_effort === "boolean"
    ? capabilitySupports.reasoning_effort
    : undefined;
  const reasoningEffortCompatible = endpoints.api === "openai-completions"
    && endpoints.provenance.source === "provider-live"
    && endpoints.conflicts.length === 0
    && liveReasoningEffortSupport !== false
    && !(liveReasoningLevels.present && liveReasoningLevels.levels.length === 0)
    && (liveReasoningEffortSupport === true || liveReasoningLevels.levels.length > 0);
  const staticReasoningEffortCompatible = endpoints.api !== "openai-completions"
    || (isOpenAICompletionsModel(staticModel) && staticModel.compat?.supportsReasoningEffort === true);
  const staticReasoningLevels = staticModel && staticReasoningEffortCompatible
    ? getSupportedThinkingLevels(staticModel)
    : [];
  const sourceMap = endpoints.api === "anthropic-messages"
    ? { minimal: "low", ...(staticModel?.api === endpoints.api ? staticModel.thinkingLevelMap : {}) }
    : staticModel?.api === endpoints.api ? staticModel?.thinkingLevelMap : undefined;
  const staticReasoningLevelMap = staticReasoningEffortCompatible ? sourceMap : undefined;
  const usableLiveReasoningLevels = (endpoints.api === "openai-completions" && !reasoningEffortCompatible)
    || (endpoints.api === "anthropic-messages"
      && (!isAnthropicModel(staticModel) || staticModel.compat?.forceAdaptiveThinking !== true))
    ? []
    : liveReasoningLevels.levels;
  const reasoningLevelMap = createThinkingLevelMap(
    liveReasoningLevels.present ? usableLiveReasoningLevels : staticReasoningLevels,
    liveReasoningLevels.present ? sourceMap : staticReasoningLevelMap,
  );
  const reasoningLevels = THINKING_LEVELS.filter((level) => reasoningLevelMap[level] !== null);
  const reasoning = liveReasoning ?? staticModel?.reasoning;
  const liveVision = toBoolean(record.vision ?? record.multimodal);
  const modalities = record.modalities as Record<string, unknown> | undefined;
  // Parenthesized so an explicit true/false liveVision always wins; only fall
  // through to modalities/static when liveVision itself is nullish.
  const vision = liveVision ?? (
    modalities?.input !== undefined
      ? normalizeStringArray(modalities?.input).includes("image")
      : staticModel?.input.includes("image")
  );

  const liveContextWindow = toFinitePositiveInteger(
    record.context_window
    ?? record.contextWindow
    ?? (record.limit && typeof record.limit === "object" ? (record.limit as Record<string, unknown>).context : undefined)
    ?? (record.limits && typeof record.limits === "object" ? (record.limits as Record<string, unknown>).context_window : undefined),
  );
  const liveMaxTokens = toFinitePositiveInteger(
    record.max_output_tokens
    ?? record.maxTokens
    ?? (record.limit && typeof record.limit === "object" ? (record.limit as Record<string, unknown>).output : undefined)
    ?? (record.limits && typeof record.limits === "object" ? (record.limits as Record<string, unknown>).max_output_tokens : undefined),
  );

  const availability = {
    enabled: toBoolean(record.enabled),
    pickerEnabled: toBoolean(record.model_picker_enabled ?? record.pickerEnabled ?? record.modelPickerEnabled),
    preview: toBoolean(record.preview ?? record.is_preview),
    policyState: normalizePolicyState(record),
  };

  const livePricing = extractLivePricing(record);
  const staticPricing = staticModel?.cost
    ? {
        inputPer1k: staticModel.cost.input / 1000,
        outputPer1k: staticModel.cost.output / 1000,
        cacheReadPer1k: staticModel.cost.cacheRead / 1000,
        cacheWritePer1k: staticModel.cost.cacheWrite / 1000,
        longContextTiers: staticModel.cost.tiers?.map((tier) => ({
          inputTokensAbove: tier.inputTokensAbove,
          ...(typeof tier.input === "number" ? { inputPer1k: tier.input / 1000 } : {}),
          ...(typeof tier.output === "number" ? { outputPer1k: tier.output / 1000 } : {}),
          ...(typeof tier.cacheRead === "number" ? { cacheReadPer1k: tier.cacheRead / 1000 } : {}),
          ...(typeof tier.cacheWrite === "number" ? { cacheWritePer1k: tier.cacheWrite / 1000 } : {}),
        })),
      }
    : undefined;
  const inputPer1k = livePricing.inputPer1k ?? staticPricing?.inputPer1k;
  const outputPer1k = livePricing.outputPer1k ?? staticPricing?.outputPer1k;
  const cacheReadPer1k = livePricing.cacheReadPer1k ?? staticPricing?.cacheReadPer1k;
  const cacheWritePer1k = livePricing.cacheWritePer1k ?? staticPricing?.cacheWritePer1k;
  const longContextTiers = livePricing.longContextTiers ?? staticPricing?.longContextTiers;
  const requestMultiplier = toFiniteNonNegativeNumber(
    record.requestMultiplier ?? record.request_multiplier ?? record.multiplier ?? record.premium_multiplier,
  );
  const autoDiscount = toFiniteNonNegativeNumber(record.autoDiscount ?? record.auto_discount);
  const promotion = extractPromotion(record);
  const billingUnit = inputPer1k !== undefined || outputPer1k !== undefined || cacheReadPer1k !== undefined || cacheWritePer1k !== undefined
    ? "tokens"
    : requestMultiplier !== undefined
      ? "request"
      : staticModel
        ? "tokens"
        : "unknown";

  const normalized: Omit<CopilotModelRecord, "hash"> = {
    provider: "github-copilot",
    id: rawId,
    registryId: `${provider}/${rawId}`,
    name,
    ...(toTrimmedString(record.vendor) ? { vendor: toTrimmedString(record.vendor) } : {}),
    ...(toTrimmedString(record.version) ? { version: toTrimmedString(record.version) } : {}),
    availability,
    execution: {
      ...(endpoints.api ? { api: endpoints.api } : {}),
      supportedEndpoints: endpoints.supportedEndpoints,
      ...(toolCalls !== undefined ? { toolCalls } : {}),
      ...(toBoolean(record.parallel_tool_calls ?? record.parallelToolCalls) !== undefined
        ? { parallelToolCalls: toBoolean(record.parallel_tool_calls ?? record.parallelToolCalls) }
        : {}),
      ...(toBoolean(record.streaming) !== undefined ? { streaming: toBoolean(record.streaming) } : {}),
      ...(vision !== undefined ? { vision } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
      reasoningLevels,
      reasoningLevelMap,
      reasoningEffortCompatible,
      ...(liveContextWindow ?? staticModel?.contextWindow ? { contextWindow: liveContextWindow ?? staticModel?.contextWindow } : {}),
      ...(liveMaxTokens ?? staticModel?.maxTokens ? { maxTokens: liveMaxTokens ?? staticModel?.maxTokens } : {}),
    },
    billing: {
      billingUnit,
      ...(inputPer1k !== undefined ? { inputPer1k } : {}),
      ...(outputPer1k !== undefined ? { outputPer1k } : {}),
      ...(cacheReadPer1k !== undefined ? { cacheReadPer1k } : {}),
      ...(cacheWritePer1k !== undefined ? { cacheWritePer1k } : {}),
      ...(longContextTiers?.length ? { longContextTiers } : {}),
      ...(requestMultiplier !== undefined ? { requestMultiplier } : {}),
      ...(autoDiscount !== undefined ? { autoDiscount } : {}),
      ...(promotion ? { promotion } : {}),
    },
    provenance: {
      displayName: displayNameProvenance,
      availability: availability.enabled !== undefined || availability.pickerEnabled !== undefined || availability.preview !== undefined || availability.policyState !== "unknown"
        ? buildProvenance("provider-live", generatedAt)
        : buildProvenance("unknown"),
      endpoints: endpoints.provenance,
      reasoning: liveReasoning !== undefined || liveReasoningLevels.present
        ? buildProvenance("provider-live", generatedAt)
        : staticModel
          ? buildProvenance("provider-static")
          : buildProvenance("unknown"),
      limits: liveContextWindow !== undefined || liveMaxTokens !== undefined
        ? buildProvenance("provider-live", generatedAt)
        : staticModel
          ? buildProvenance("provider-static")
          : buildProvenance("unknown"),
      billingUnit: billingUnit !== "unknown"
        ? buildProvenance(livePricing.inputPer1k !== undefined || requestMultiplier !== undefined ? "provider-live" : staticModel ? "provider-static" : "unknown", livePricing.inputPer1k !== undefined || requestMultiplier !== undefined ? generatedAt : undefined)
        : buildProvenance("unknown"),
      tokenPrices: inputPer1k !== undefined || outputPer1k !== undefined || cacheReadPer1k !== undefined || cacheWritePer1k !== undefined
        ? buildProvenance(livePricing.inputPer1k !== undefined || livePricing.outputPer1k !== undefined || livePricing.cacheReadPer1k !== undefined || livePricing.cacheWritePer1k !== undefined ? "provider-live" : staticModel ? "provider-static" : "unknown", livePricing.inputPer1k !== undefined || livePricing.outputPer1k !== undefined || livePricing.cacheReadPer1k !== undefined || livePricing.cacheWritePer1k !== undefined ? generatedAt : undefined)
        : buildProvenance("unknown"),
      requestMultiplier: requestMultiplier !== undefined ? buildProvenance("provider-live", generatedAt) : buildProvenance("unknown"),
      promotion: promotion ? buildProvenance("provider-live", generatedAt) : buildProvenance("unknown"),
    },
    conflicts: endpoints.conflicts,
  };

  return {
    ...normalized,
    hash: hashValue({
      ...normalized,
      provenance: stableProvenanceForHash(normalized.provenance),
    }),
  };
}

function normalizePayloadRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown[] }).data)) {
    return (payload as { data: unknown[] }).data;
  }
  throw new CopilotCatalogFetchError("malformed", "Copilot models payload did not contain an array of records.");
}

export function sanitizeGitHubCopilotModels(
  payload: unknown,
  options: { provider?: GitHubCopilotProvider; generatedAt?: string } = {},
): CopilotModelRecord[] {
  const rows = normalizePayloadRows(payload);
  const provider = options.provider ?? "github-copilot";
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const seen = new Set<string>();
  const sanitized: CopilotModelRecord[] = [];

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const model = normalizeGitHubCopilotModel(row as Record<string, unknown>, provider, generatedAt);
    if (!model || seen.has(model.registryId)) continue;
    seen.add(model.registryId);
    sanitized.push(model);
  }

  return sanitized.sort((a, b) => a.registryId.localeCompare(b.registryId));
}

function buildSnapshot(generatedAt: string, models: CopilotModelRecord[]): CopilotModelSnapshot {
  const orderedModels = [...models].sort((a, b) => a.registryId.localeCompare(b.registryId));
  const hash = hashValue(
    orderedModels.map((model) => ({ registryId: model.registryId, hash: model.hash })),
  );
  return {
    generatedAt,
    hash,
    modelCount: orderedModels.length,
    models: orderedModels,
  };
}

/** Combine abort signals with a manual-composition fallback for runtimes without `AbortSignal.any`. */
function combineAbortSignals(signals: AbortSignal[]): AbortSignal {
  if (signals.length === 1) return signals[0];
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(signals);
  }
  const controller = new AbortController();
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort();
  };
  if (signals.some((signal) => signal.aborted)) {
    abort();
  } else {
    for (const signal of signals) {
      signal.addEventListener("abort", abort, { once: true });
    }
  }
  return controller.signal;
}

export async function fetchGitHubCopilotModels(options: FetchCopilotModelsOptions): Promise<FetchCopilotModelsResult> {
  if (options.provider !== "github-copilot") {
    return { skipped: true, reason: "provider-not-copilot", models: [] };
  }

  const endpoint = options.baseUrl ?? "https://api.githubcopilot.com";
  const authToken = options.authToken ?? "";
  const fetcher = options.fetchImpl ?? fetch;
  const generatedAt = new Date().toISOString();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const timeoutController = new AbortController();
  const combinedSignal = timeoutMs > 0 || options.signal
    ? combineAbortSignals([
        timeoutController.signal,
        ...(options.signal ? [options.signal] : []),
      ])
    : undefined;
  const timeout = timeoutMs > 0
    ? setTimeout(() => timeoutController.abort(new Error("timeout")), timeoutMs)
    : undefined;

  try {
    if (combinedSignal?.aborted) {
      if (timeoutController.signal.aborted) {
        throw new CopilotCatalogFetchError("timeout", `Copilot models fetch timed out after ${timeoutMs}ms.`);
      }
      throw new CopilotCatalogFetchError("aborted", "Copilot models fetch was cancelled.");
    }

    const response = await fetcher(`${endpoint}/models`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...COPILOT_MODELS_REQUEST_HEADERS,
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      ...(combinedSignal ? { signal: combinedSignal } : {}),
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new CopilotCatalogFetchError("unauthorized", "Copilot models fetch returned 401 Unauthorized.", 401);
      }
      if (response.status === 403) {
        throw new CopilotCatalogFetchError("forbidden", "Copilot models fetch returned 403 Forbidden.", 403);
      }
      if (response.status === 429) {
        throw new CopilotCatalogFetchError("rate-limited", "Copilot models fetch returned 429 Too Many Requests.", 429);
      }
      if (response.status >= 500) {
        throw new CopilotCatalogFetchError("server", `Copilot models fetch returned ${response.status}.`, response.status);
      }
      throw new CopilotCatalogFetchError("network", `Copilot models fetch returned ${response.status}.`, response.status);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new CopilotCatalogFetchError("malformed", "Copilot models payload was not valid JSON.");
    }

    const models = sanitizeGitHubCopilotModels(payload, {
      provider: options.provider,
      generatedAt,
    });
    const snapshot = buildSnapshot(generatedAt, models);
    return { models, snapshot };
  } catch (error) {
    if (error instanceof CopilotCatalogFetchError) throw error;
    if (combinedSignal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      if (timeoutController.signal.aborted) {
        throw new CopilotCatalogFetchError("timeout", `Copilot models fetch timed out after ${timeoutMs}ms.`);
      }
      throw new CopilotCatalogFetchError("aborted", "Copilot models fetch was cancelled.");
    }
    throw new CopilotCatalogFetchError(
      "network",
      error instanceof Error ? error.message : "Unknown network failure while fetching Copilot models.",
    );
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function applyLastKnownGood<T>(previous: T, next: { ok: boolean; error?: string; snapshot: T | null }): T {
  if (next.ok && next.snapshot) return next.snapshot;
  return previous;
}

export function diffCatalogSnapshots(previous: CopilotModelSnapshot, next: CopilotModelSnapshot) {
  const previousMap = new Map(previous.models.map((model) => [model.registryId, model]));
  const nextMap = new Map(next.models.map((model) => [model.registryId, model]));

  const added = [...nextMap.entries()].filter(([id]) => !previousMap.has(id)).map(([, model]) => model);
  const removed = [...previousMap.entries()].filter(([id]) => !nextMap.has(id)).map(([, model]) => model);
  const changed = [...nextMap.entries()].filter(([id, model]) => {
    const previousModel = previousMap.get(id);
    return previousModel && previousModel.hash !== model.hash;
  }).map(([, model]) => model);

  return { added, removed, changed };
}

export function dedupeShellNotifications(messages: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const message of messages) {
    if (seen.has(message)) continue;
    seen.add(message);
    result.push(message);
  }

  return result;
}

export function isSuspiciousCatalogShrink(
  previous: CopilotModelSnapshot | null,
  next: CopilotModelSnapshot,
): boolean {
  if (!previous) return false;
  if (next.modelCount === 0 && previous.modelCount > 0) return true;
  if (previous.modelCount < 4) return false;
  return next.modelCount <= Math.floor(previous.modelCount / 2);
}
