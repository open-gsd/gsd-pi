/**
 * Provider Payload Policy - ordered shaping of provider request payloads.
 *
 * The order is intentional:
 * 1. superseded GSD context injections (memory/guided/forensics) are removed,
 *    keeping only the latest, for every mode,
 * 2. observation budgeting masks old tool results in auto-mode,
 * 3. display truncation caps tool-result text for every mode,
 * 4. the protected Source Context Block is appended after truncation,
 * 5. supported models receive the configured service tier.
 */

import type { ContextManagementConfig } from "./preferences-types.js";
import type { ServiceTierSetting } from "./service-tier.js";

import {
  createObservationMask,
  createResponsesInputObservationMask,
  filterSupersededContextInjections,
  filterSupersededResponsesContextInjections,
  truncateContextResultMessages,
  truncateResponsesInputResultItems,
} from "./context-masker.js";
import { getSourceObservationStore, isAutoActive } from "./auto-runtime-state.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { getEffectiveServiceTier, supportsServiceTier } from "./service-tier.js";
import { injectSourceContextBlockIntoPayload } from "./source-observations.js";

const DEFAULT_OBSERVATION_MASK_TURNS = 8;
const DEFAULT_TOOL_RESULT_MAX_CHARS = 800;

type MessagePayload = Parameters<ReturnType<typeof createObservationMask>>[0];
type ResponsesInputPayload = Parameters<ReturnType<typeof createResponsesInputObservationMask>>[0];

export interface ProviderPayloadPolicyDeps {
  isAutoActive(): boolean;
  loadContextManagementConfig(): ContextManagementConfig | undefined;
  renderSourceContextBlock(): string | null;
  getEffectiveServiceTier(): ServiceTierSetting;
  supportsServiceTier(modelId: string): boolean;
}

export interface ProviderPayloadPolicyInput {
  payload: Record<string, unknown>;
  modelId?: string;
  deps?: Partial<ProviderPayloadPolicyDeps>;
}

export const DEFAULT_PROVIDER_PAYLOAD_POLICY_DEPS: ProviderPayloadPolicyDeps = {
  isAutoActive,
  loadContextManagementConfig: () => loadEffectiveGSDPreferences()?.preferences.context_management,
  renderSourceContextBlock: () => getSourceObservationStore().renderActiveBlock(),
  getEffectiveServiceTier,
  supportsServiceTier,
};

export function applyProviderPayloadPolicy({
  payload,
  modelId,
  deps: overrides,
}: ProviderPayloadPolicyInput): Record<string, unknown> {
  const deps = { ...DEFAULT_PROVIDER_PAYLOAD_POLICY_DEPS, ...overrides };

  try {
    applyContextManagement(payload, deps);
  } catch {
    // Provider payload shaping should not block a request when optional
    // context management preferences or adapters fail.
  }

  try {
    applySourceContextBlock(payload, deps);
  } catch {
    // Source observations are opportunistic; execution can continue without
    // an injected block.
  }

  applyServiceTier(payload, modelId, deps);
  return payload;
}

function applyContextManagement(
  payload: Record<string, unknown>,
  deps: ProviderPayloadPolicyDeps,
): void {
  const config = deps.loadContextManagementConfig();
  applyContextInjectionFilter(payload, config);
  applyObservationBudget(payload, config, deps.isAutoActive());
  applyDisplayTruncation(payload, config);
}

function applyContextInjectionFilter(
  payload: Record<string, unknown>,
  config: ContextManagementConfig | undefined,
): void {
  // Default: keep superseded context injections (#cache-stability).
  // Removal retroactively rewrites payload positions, so the provider KV
  // prefix cache diverges at the first removed injection (~system/tool
  // offset) and re-prefills the whole history for a small block change.
  // With content-addressed reinjection upstream, an unchanged memory block
  // is never re-injected, so nothing accumulates in the payload; the
  // compaction pass already re-roots the history when it summarizes.
  // `superseded_injections: "drop"` restores the legacy token-saving filter
  // for sessions without KV prefix caching (e.g. stateless API providers).
  if (config?.superseded_injections !== "drop") return;
  if (Array.isArray(payload.messages)) {
    payload.messages = filterSupersededContextInjections(payload.messages as MessagePayload);
  }
  if (Array.isArray(payload.input)) {
    payload.input = filterSupersededResponsesContextInjections(payload.input as ResponsesInputPayload);
  }
}

function applyObservationBudget(
  payload: Record<string, unknown>,
  config: ContextManagementConfig | undefined,
  autoActive: boolean,
): void {
  if (!autoActive || config?.observation_masking === false) return;

  const keepTurns = config?.observation_mask_turns ?? DEFAULT_OBSERVATION_MASK_TURNS;
  if (Array.isArray(payload.messages)) {
    payload.messages = createObservationMask(keepTurns)(payload.messages as MessagePayload);
  }
  if (Array.isArray(payload.input)) {
    payload.input = createResponsesInputObservationMask(keepTurns)(payload.input as ResponsesInputPayload);
  }
}

function applyDisplayTruncation(
  payload: Record<string, unknown>,
  config: ContextManagementConfig | undefined,
): void {
  const maxChars = config?.tool_result_max_chars ?? DEFAULT_TOOL_RESULT_MAX_CHARS;

  if (Array.isArray(payload.messages)) {
    payload.messages = truncateContextResultMessages(payload.messages as MessagePayload, maxChars);
  }
  if (Array.isArray(payload.input)) {
    payload.input = truncateResponsesInputResultItems(payload.input as ResponsesInputPayload, maxChars);
  }
}

function applySourceContextBlock(
  payload: Record<string, unknown>,
  deps: ProviderPayloadPolicyDeps,
): void {
  if (!deps.isAutoActive()) return;

  const sourceContextBlock = deps.renderSourceContextBlock();
  if (!sourceContextBlock) return;

  Object.assign(payload, injectSourceContextBlockIntoPayload(payload, sourceContextBlock));
}

function applyServiceTier(
  payload: Record<string, unknown>,
  modelId: string | undefined,
  deps: ProviderPayloadPolicyDeps,
): void {
  if (!modelId) return;

  const tier = deps.getEffectiveServiceTier();
  if (!tier || !deps.supportsServiceTier(modelId)) return;

  payload.service_tier = tier;
}
