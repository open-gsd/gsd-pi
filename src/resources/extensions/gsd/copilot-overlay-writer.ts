/**
 * GitHub Copilot model-catalog overlay writer — Phase H, first vertical slice.
 *
 * Closes the loop that Phase C's read-only drift-check (`copilot-model-catalog.ts`)
 * only detects: when a live GitHub Copilot model is discovered that is absent
 * from the bundled/overlay catalog, this module synthesizes a schema-valid
 * `Model` entry for it and merges it into the *same* `models-catalog.json`
 * overlay that `gsd update --models` (`src/update-cmd.ts`) already writes and
 * that `ModelRegistry` already merges at runtime (bundled catalog < overlay <
 * `models.json`). No `packages/pi-ai` generator changes, no separate Pi repo,
 * no registry mutation code — this only ever produces/merges/writes the
 * existing overlay file format.
 *
 * Overlay entries are synthesized only from complete, authoritative metadata.
 * Existing overlay entries (in particular anything already
 * sourced from the `packages/pi-ai` generator via `models.dev`) are never
 * downgraded or overwritten by this module.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { type Api, isModelsCatalogOverlay, type Model, type ModelsCatalogOverlay } from "@gsd/pi-ai";
import { findStaticCopilotModel } from "./copilot-model-catalog.js";
import type { CopilotModelRecord } from "./copilot-model-catalog.js";

export {
  applyLastKnownGood,
  dedupeShellNotifications,
  diffCatalogSnapshots,
  fetchGitHubCopilotModels,
  findStaticCopilotModel,
  isSuspiciousCatalogShrink,
  sanitizeGitHubCopilotModels,
} from "./copilot-model-catalog.js";
export type { CopilotModelRecord, CopilotModelSnapshot } from "./copilot-model-catalog.js";

// Inline agentDir computation (mirrors `src/app-paths.ts`'s `agentDir`) —
// importing from `src/` pulls files outside `src/resources` and breaks the
// extensions build (see `onboarding-state.ts` for the same convention). This
// must resolve to the *exact* same directory `resolveModelsCatalogPath()`
// (src/models-resolver.ts) does, since `models-catalog.json` is only ever
// read by `ModelRegistry` from that one location.
function defaultModelsCatalogPath(): string {
  const appRoot = process.env.GSD_HOME || join(homedir(), ".gsd");
  return join(appRoot, "agent", "models-catalog.json");
}

/** Resolve the on-disk path to the models-catalog.json overlay. Accepts an override for tests. */
export function resolveGsdModelsCatalogPath(agentDirOverride?: string): string {
  return agentDirOverride ? join(agentDirOverride, "models-catalog.json") : defaultModelsCatalogPath();
}

/** Static request headers GitHub Copilot's API expects — mirrors `COPILOT_STATIC_HEADERS` in `packages/pi-ai/scripts/generate-models.ts`. */
export const COPILOT_OVERLAY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
});

const COPILOT_OVERLAY_BASE_URL = "https://api.individual.githubcopilot.com";

function isOpenAICompletionsModel(model: Model<Api> | undefined): model is Model<"openai-completions"> {
  return model?.api === "openai-completions";
}

function toPerMillion(valuePer1k: number): number {
  return valuePer1k * 1000;
}

function apiSpecificCompat(record: CopilotModelRecord): Model<Api>["compat"] | undefined {
  const staticModel = findStaticCopilotModel(record.id);
  if (record.execution.api === "openai-completions") {
    const staticCompletionsCompat = isOpenAICompletionsModel(staticModel) ? staticModel.compat : undefined;
    return {
      ...(staticCompletionsCompat ?? {}),
      supportsStore: staticCompletionsCompat?.supportsStore ?? false,
      supportsDeveloperRole: staticCompletionsCompat?.supportsDeveloperRole ?? false,
      supportsReasoningEffort: record.execution.reasoningEffortCompatible === true,
    };
  }
  if (staticModel && staticModel.api === record.execution.api && staticModel.compat) return staticModel.compat;

  return undefined;
}

function isRegistrationPreviewDisabled(record: CopilotModelRecord): boolean {
  return record.availability?.preview === true && record.availability?.pickerEnabled === false;
}

function registrationBlockers(record: CopilotModelRecord): string[] {
  const blockers: string[] = [];

  if ((record.conflicts?.length ?? 0) > 0) {
    blockers.push(...record.conflicts);
  }
  if (record.availability?.enabled === false) {
    blockers.push("provider reports the model as disabled");
  }
  if (record.availability?.policyState === "disabled") {
    blockers.push("provider policy disables the model");
  }
  if (record.availability?.policyState === "restricted") {
    blockers.push("provider policy restricts the model");
  }
  if (isRegistrationPreviewDisabled(record)) {
    blockers.push("preview model is not enabled in the model picker");
  }
  if (!record.execution?.api) {
    blockers.push("missing authoritative runtime API/endpoint mapping");
  }
  if (!record.execution?.reasoningLevelMap || record.execution.reasoningEffortCompatible === undefined) {
    blockers.push("missing normalized reasoning metadata; refresh the Copilot catalog");
  }
  if (record.execution?.toolCalls === false) {
    blockers.push("provider reports tool calling is unavailable");
  } else if (record.execution?.toolCalls === undefined) {
    blockers.push("tool-call support is unknown");
  }
  if (!record.execution?.contextWindow) {
    blockers.push("missing authoritative context window");
  }
  if (!record.execution?.maxTokens) {
    blockers.push("missing authoritative max output tokens");
  }
  if (record.execution?.reasoning === undefined) {
    blockers.push("missing authoritative reasoning support flag");
  }
  if (record.execution?.vision === undefined) {
    blockers.push("missing authoritative input modality");
  }
  if (record.billing?.inputPer1k === undefined) {
    blockers.push("missing authoritative input token price");
  }
  if (record.billing?.outputPer1k === undefined) {
    blockers.push("missing authoritative output token price");
  }
  if (record.billing?.cacheReadPer1k === undefined) {
    blockers.push("missing authoritative cache-read token price");
  }
  if (record.billing?.cacheWritePer1k === undefined) {
    blockers.push("missing authoritative cache-write token price");
  }

  return blockers;
}

/**
 * Build a schema-valid overlay entry from a COMPLETE normalized Copilot record.
 * Callers must only use this after `registrationBlockers()` returned no blockers.
 */
export function synthesizeCopilotOverlayEntry(record: CopilotModelRecord): Model<Api> {
  const blockers = registrationBlockers(record);
  if (blockers.length > 0) {
    throw new Error(`Cannot synthesize overlay entry for ${record.registryId}: ${blockers.join("; ")}.`);
  }
  const { api, reasoning, reasoningLevelMap, vision, contextWindow, maxTokens } = record.execution;
  const { inputPer1k, outputPer1k, cacheReadPer1k, cacheWritePer1k, longContextTiers } = record.billing;
  if (
    !api
    || reasoning === undefined
    || vision === undefined
    || !contextWindow
    || !maxTokens
    || inputPer1k === undefined
    || outputPer1k === undefined
    || cacheReadPer1k === undefined
    || cacheWritePer1k === undefined
  ) {
    throw new Error(`Cannot synthesize overlay entry for ${record.registryId} without complete authoritative metadata.`);
  }

  return {
    id: record.id,
    name: record.name || record.id,
    api,
    provider: "github-copilot",
    baseUrl: COPILOT_OVERLAY_BASE_URL,
    reasoning,
    thinkingLevelMap: reasoningLevelMap,
    input: vision ? ["text", "image"] : ["text"],
    cost: {
      input: toPerMillion(inputPer1k),
      output: toPerMillion(outputPer1k),
      cacheRead: toPerMillion(cacheReadPer1k),
      cacheWrite: toPerMillion(cacheWritePer1k),
      ...(longContextTiers?.length
        ? {
            tiers: longContextTiers.map((tier) => ({
              inputTokensAbove: tier.inputTokensAbove,
              ...(tier.inputPer1k !== undefined ? { input: toPerMillion(tier.inputPer1k) } : {}),
              ...(tier.outputPer1k !== undefined ? { output: toPerMillion(tier.outputPer1k) } : {}),
              ...(tier.cacheReadPer1k !== undefined ? { cacheRead: toPerMillion(tier.cacheReadPer1k) } : {}),
              ...(tier.cacheWritePer1k !== undefined ? { cacheWrite: toPerMillion(tier.cacheWritePer1k) } : {}),
            })),
          }
        : {}),
    },
      contextWindow,
      maxTokens,
    headers: { ...COPILOT_OVERLAY_HEADERS },
    ...(apiSpecificCompat(record) ? { compat: apiSpecificCompat(record) } : {}),
  };
}

/**
 * Merge newly-synthesized `github-copilot` models into an existing (or
 * absent) overlay. Never touches any other provider's entries. Never
 * overwrites an existing `github-copilot` entry for the same model id —
 * an entry already present (e.g. sourced from the `packages/pi-ai` generator
 * via `gsd update --models`) is strictly more authoritative than a synthesized
 * placeholder and must win.
 */
export function mergeIntoModelsCatalogOverlay(
  existing: ModelsCatalogOverlay | null,
  newModels: Model<Api>[],
): ModelsCatalogOverlay {
  const baseModels = existing?.models ?? {};
  const existingCopilotModels = baseModels["github-copilot"] ?? {};

  const mergedCopilotModels = { ...existingCopilotModels };
  for (const model of newModels) {
    if (mergedCopilotModels[model.id]) continue; // never downgrade an existing entry
    mergedCopilotModels[model.id] = model;
  }

  return {
    version: 1,
    fetchedAt: new Date().toISOString(),
    source: existing?.source ?? "gsd:copilot-models --register",
    models: {
      ...baseModels,
      "github-copilot": mergedCopilotModels,
    },
  };
}

/** Best-effort read of an existing overlay. Returns null for missing/malformed/invalid files — never throws. */
export function readModelsCatalogOverlay(path: string): ModelsCatalogOverlay | null {
  try {
    if (!existsSync(path)) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!isModelsCatalogOverlay(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Distinguish "file exists but is corrupt/invalid" from "no file yet" — the two
 * cases `readModelsCatalogOverlay()` intentionally collapses into `null` for
 * read-only callers. Registration must NOT conflate them: merging on top of a
 * `null` "existing" overlay starts from an empty `models` map, so if the file
 * actually exists with unrelated provider entries, writing the merge result
 * would silently delete them. This lets the registration path fail closed.
 */
function overlayFileIsMalformed(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return !isModelsCatalogOverlay(parsed);
  } catch {
    return true;
  }
}

/**
 * Atomic write: temp file in the same directory, then rename — mirrors the
 * exact pattern already used by `gsd update --models` (`src/update-cmd.ts`'s
 * `runModelsUpdate()`), so a crash mid-write never corrupts the overlay.
 */
export function writeModelsCatalogOverlay(path: string, overlay: ModelsCatalogOverlay): void {
  const tmpPath = `${path}.tmp-${process.pid}`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmpPath, `${JSON.stringify(overlay, null, 2)}\n`);
    renameSync(tmpPath, path);
  } catch (err) {
    rmSync(tmpPath, { force: true });
    throw err;
  }
}

export interface CatalogRegistrationCandidate extends CopilotModelRecord {
  complete: boolean;
  blockers: string[];
  reason: string;
}

export interface RegisterCopilotModelsResult {
  registeredIds: string[];
  candidates: CatalogRegistrationCandidate[];
  quarantined: CatalogRegistrationCandidate[];
  overlayPath: string;
  /** Set when the existing overlay file could not be read; registration was skipped to avoid data loss. */
  overlayError?: string;
}

/**
 * Compute remote-only Copilot candidates as the set difference:
 * live remote catalog - effective local catalog.
 *
 * The effective local catalog is the authoritative runtime truth. Remote-only
 * entries are never materialized into the overlay as fabricated metadata; they
 * stay quarantined until a real generator or user-authored custom model entry
 * exists for them.
 */
export function computeCatalogRegistrationCandidates(
  remoteModels: CopilotModelRecord[],
  localModels: Array<{ id: string; provider?: string }>,
): CatalogRegistrationCandidate[] {
  const localIds = new Set(
    localModels
      .filter((model) => !model.provider || model.provider === "github-copilot")
      .map((model) => model.id),
  );

  return remoteModels
    .filter((model) => !localIds.has(model.id))
    .map((model) => {
      const blockers = registrationBlockers(model);
      const complete = blockers.length === 0;
      return {
        ...model,
        complete,
        blockers,
        reason: complete
          ? "remote-only GitHub Copilot model has complete authoritative metadata and can be registered safely"
          : `remote-only GitHub Copilot model kept quarantined: ${blockers.join("; ")}`,
      };
    });
}

/**
 * Safe registration path: keep remote-only models quarantined instead of writing
 * placeholder metadata into `models-catalog.json`.
 */
export function registerCopilotModelsInOverlay(
  overlayPath: string,
  discovered: CopilotModelRecord[],
  localModels: Array<{ id: string; provider?: string }> = [],
): RegisterCopilotModelsResult {
  if (overlayFileIsMalformed(overlayPath)) {
    return {
      registeredIds: [],
      candidates: [],
      quarantined: [],
      overlayPath,
      overlayError: `${overlayPath} exists but is not valid JSON or does not match the expected models-catalog.json schema. Registration was skipped to avoid overwriting its contents — fix or remove the file, then retry.`,
    };
  }

  const existingOverlay = readModelsCatalogOverlay(overlayPath);
  const overlayLocalModels = existingOverlay
    ? Object.entries(existingOverlay.models).flatMap(([provider, entries]) =>
        provider === "github-copilot"
          ? Object.keys(entries).map((id) => ({ id, provider: "github-copilot" }))
          : [],
      )
    : [];

  const effectiveLocalModels = [...localModels, ...overlayLocalModels];
  const candidates = computeCatalogRegistrationCandidates(discovered, effectiveLocalModels);
  const quarantined = candidates.filter((candidate) => !candidate.complete);
  const complete = candidates.filter((candidate) => candidate.complete);

  if (complete.length > 0) {
    const entries = complete.map((candidate) => synthesizeCopilotOverlayEntry(candidate));
    const merged = mergeIntoModelsCatalogOverlay(existingOverlay, entries);
    writeModelsCatalogOverlay(overlayPath, merged);
  }

  return {
    registeredIds: complete.map((candidate) => candidate.id),
    candidates,
    quarantined,
    overlayPath,
  };
}
