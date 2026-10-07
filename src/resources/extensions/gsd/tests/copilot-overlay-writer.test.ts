// Tests for the Phase H first vertical slice — registering newly-discovered
// GitHub Copilot models into the runtime `models-catalog.json` overlay.
// Mirrors the fixture/harness style of `src/tests/update-models-cmd.test.ts`.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Api, Model } from "../../../../../packages/pi-ai/src/types.js";
import { type CopilotModelRecord, sanitizeGitHubCopilotModels } from "../copilot-model-catalog.js";
import {
  mergeIntoModelsCatalogOverlay,
  readModelsCatalogOverlay,
  registerCopilotModelsInOverlay,
  synthesizeCopilotOverlayEntry,
  writeModelsCatalogOverlay,
} from "../copilot-overlay-writer.js";

function completeRecord(id: string, name = id, overrides: Record<string, unknown> = {}): CopilotModelRecord {
  const [record] = sanitizeGitHubCopilotModels({
    data: [
      {
        id,
        name,
        tool_call: true,
        supported_endpoints: ["/responses"],
        vision: false,
        reasoning: true,
        limit: { context: 400_000, output: 128_000 },
        cost: { input: 0.2, output: 1.2, cache_read: 0, cache_write: 0 },
        ...overrides,
      },
    ],
  });
  if (!record) throw new Error("sanitizeGitHubCopilotModels returned no records for completeRecord fixture");
  return record;
}

function incompleteRecord(id: string, name = id, overrides: Record<string, unknown> = {}): CopilotModelRecord {
  const [record] = sanitizeGitHubCopilotModels({
    data: [
      {
        id,
        name,
        tool_call: true,
        ...overrides,
      },
    ],
  });
  if (!record) throw new Error("sanitizeGitHubCopilotModels returned no records for incompleteRecord fixture");
  return record;
}

function assertCompletionsModel(model: Model<Api>): asserts model is Model<"openai-completions"> {
  if (model.api !== "openai-completions") throw new Error(`Unexpected synthesized API: ${model.api}`);
}

test("synthesizeCopilotOverlayEntry produces a schema-valid entry from a complete live/static record", () => {
  const entry = synthesizeCopilotOverlayEntry(completeRecord("brand-new-model", "Brand New Model"));

  assert.equal(entry.id, "brand-new-model");
  assert.equal(entry.name, "Brand New Model");
  assert.equal(entry.api, "openai-responses");
  assert.equal(entry.provider, "github-copilot");
  assert.equal(entry.baseUrl, "https://api.individual.githubcopilot.com");
  assert.equal(entry.reasoning, true);
  assert.deepEqual(entry.input, ["text"]);
  assert.deepEqual(entry.cost, { input: 0.2, output: 1.2, cacheRead: 0, cacheWrite: 0 });
  assert.equal(entry.contextWindow, 400_000);
  assert.equal(entry.maxTokens, 128_000);
  assert.equal(entry.headers?.["User-Agent"], "GitHubCopilotChat/0.35.0");
});

test("synthesizeCopilotOverlayEntry falls back to id when name is blank", () => {
  const entry = synthesizeCopilotOverlayEntry(completeRecord("no-name-model", ""));
  assert.equal(entry.name, "no-name-model");
});

test("legacy normalized records are quarantined until reasoning metadata is refreshed", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-copilot-legacy-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const record = completeRecord("legacy-completions", "Legacy", {
    supported_endpoints: ["/chat/completions"],
  });
  delete record.execution.reasoningLevelMap;
  delete record.execution.reasoningEffortCompatible;
  const legacy: CopilotModelRecord = JSON.parse(JSON.stringify(record));
  assert.throws(() => synthesizeCopilotOverlayEntry(legacy), /refresh the Copilot catalog/);
  const plan = registerCopilotModelsInOverlay(join(tmp, "models-catalog.json"), [legacy], []);
  assert.deepEqual(plan.registeredIds, []);
  assert.match(plan.quarantined[0].blockers.join("; "), /refresh the Copilot catalog/);
});

test("synthesizeCopilotOverlayEntry keeps only live efforts and enables their matching Completions wire field", () => {
  const entry = synthesizeCopilotOverlayEntry(completeRecord("limited-completions-efforts", "Limited Completions Efforts", {
    supported_endpoints: ["/chat/completions"],
    supportedReasoningEfforts: ["low", "high"],
    capabilities: { supports: { reasoning_effort: true } },
  }));

  assertCompletionsModel(entry);
  assert.deepEqual(entry.thinkingLevelMap, {
    off: null,
    minimal: null,
    low: "low",
    medium: null,
    high: "high",
    xhigh: null,
    max: null,
  });
  assert.equal(entry.compat?.supportsReasoningEffort, true);
});

test("mergeIntoModelsCatalogOverlay: starting from nothing produces a valid overlay with only github-copilot", () => {
  const merged = mergeIntoModelsCatalogOverlay(null, [synthesizeCopilotOverlayEntry(completeRecord("new-model"))]);
  const githubCopilotModels = merged.models["github-copilot"] as Record<string, unknown>;

  assert.equal(merged.version, 1);
  assert.ok(typeof merged.fetchedAt === "string" && !Number.isNaN(Date.parse(merged.fetchedAt)));
  assert.deepEqual(Object.keys(merged.models), ["github-copilot"]);
  assert.deepEqual(Object.keys(githubCopilotModels), ["new-model"]);
});

test("mergeIntoModelsCatalogOverlay never touches unrelated providers", () => {
  const existing = {
    version: 1 as const,
    fetchedAt: "2026-01-01T00:00:00.000Z",
    source: "https://example.com/catalog.json",
    models: {
      anthropic: {
        "claude-opus-4-6": synthesizeCopilotOverlayEntry(completeRecord("claude-opus-4-6")),
      },
      "github-copilot": {
        "existing-model": synthesizeCopilotOverlayEntry(completeRecord("existing-model")),
      },
    },
  };

  const merged = mergeIntoModelsCatalogOverlay(existing, [synthesizeCopilotOverlayEntry(completeRecord("new-model"))]);
  const githubCopilotModels = merged.models["github-copilot"] as Record<string, unknown>;

  assert.ok(merged.models.anthropic["claude-opus-4-6"], "unrelated provider entry must survive untouched");
  assert.ok(githubCopilotModels["existing-model"], "existing copilot entry must survive");
  assert.ok(githubCopilotModels["new-model"], "new copilot entry must be added");
});

test("mergeIntoModelsCatalogOverlay never downgrades an existing entry (e.g. a richer models.dev-sourced one)", () => {
  const richEntry = {
    ...synthesizeCopilotOverlayEntry(completeRecord("gpt-5.4")),
    reasoning: true,
    cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
    contextWindow: 400_000,
  };
  const existing = {
    version: 1 as const,
    models: { "github-copilot": { "gpt-5.4": richEntry } },
  };

  const merged = mergeIntoModelsCatalogOverlay(existing, [synthesizeCopilotOverlayEntry(completeRecord("gpt-5.4"))]);
  const githubCopilotModels = merged.models["github-copilot"] as Record<string, unknown>;

  assert.deepEqual(
    githubCopilotModels["gpt-5.4"],
    richEntry,
    "a placeholder synth must never overwrite a richer existing entry for the same model id",
  );
});

test("writeModelsCatalogOverlay writes atomically and leaves no temp-file leftovers", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-copilot-overlay-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const path = join(tmp, "models-catalog.json");

  const overlay = mergeIntoModelsCatalogOverlay(null, [synthesizeCopilotOverlayEntry(completeRecord("m1"))]);
  writeModelsCatalogOverlay(path, overlay);

  const onDisk = JSON.parse(readFileSync(path, "utf-8"));
  assert.deepEqual(onDisk, overlay);

  const leftovers = readdirSync(tmp).filter((name) => name.includes(".tmp-"));
  assert.deepEqual(leftovers, [], "atomic write must leave no temp files");
});

test("readModelsCatalogOverlay returns null for a missing file", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-copilot-overlay-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  assert.equal(readModelsCatalogOverlay(join(tmp, "does-not-exist.json")), null);
});

test("readModelsCatalogOverlay returns null for a malformed/invalid file", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-copilot-overlay-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const path = join(tmp, "models-catalog.json");

  writeFileSync(path, "not json");
  assert.equal(readModelsCatalogOverlay(path), null, "malformed JSON must not throw");

  writeFileSync(path, JSON.stringify({ version: 1, models: {} }));
  assert.equal(readModelsCatalogOverlay(path), null, "empty catalog must fail isModelsCatalog validation");
});

test("registerCopilotModelsInOverlay: safe containment quarantines incomplete remote-only models instead of persisting placeholders", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-copilot-overlay-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const overlayPath = join(tmp, "models-catalog.json");

  const first = registerCopilotModelsInOverlay(overlayPath, [incompleteRecord("model-a"), incompleteRecord("model-b")]);
  assert.deepEqual(first.registeredIds, [], "incomplete remote-only entries are quarantined, never registered as concrete metadata");
  assert.deepEqual(first.quarantined.map((model) => model.id).sort(), ["model-a", "model-b"]);
  assert.equal(first.overlayPath, overlayPath);
  assert.equal(readModelsCatalogOverlay(overlayPath), null, "no placeholder metadata may be written to the on-disk overlay");

  const second = registerCopilotModelsInOverlay(overlayPath, [incompleteRecord("model-a"), incompleteRecord("model-c")]);
  assert.deepEqual(second.registeredIds, [], "the safe path never materializes incomplete remote-only models as registered");
  assert.deepEqual(second.quarantined.map((model) => model.id).sort(), ["model-a", "model-c"]);
  assert.equal(readModelsCatalogOverlay(overlayPath), null, "repeated quarantine checks must not write any placeholder overlay");
});

test("registerCopilotModelsInOverlay registers complete remote-only models idempotently", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-copilot-overlay-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const overlayPath = join(tmp, "models-catalog.json");

  const first = registerCopilotModelsInOverlay(overlayPath, [completeRecord("model-complete")]);
  assert.deepEqual(first.registeredIds, ["model-complete"]);
  assert.deepEqual(first.quarantined, []);
  const onDisk = readModelsCatalogOverlay(overlayPath);
  assert.ok(onDisk?.models["github-copilot"]?.["model-complete"]);

  const second = registerCopilotModelsInOverlay(overlayPath, [completeRecord("model-complete")]);
  assert.deepEqual(second.registeredIds, []);
  assert.deepEqual(second.quarantined, []);
});

test("registerCopilotModelsInOverlay quarantines preview-disabled or policy-restricted models", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-copilot-overlay-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const overlayPath = join(tmp, "models-catalog.json");

  const result = registerCopilotModelsInOverlay(overlayPath, [
    incompleteRecord("preview-disabled", "Preview Disabled", {
      preview: true,
      model_picker_enabled: false,
      policy_state: "restricted",
      supported_endpoints: ["/responses"],
      vision: false,
      reasoning: true,
      limit: { context: 400000, output: 128000 },
      cost: { input: 0.2, output: 1.2, cache_read: 0, cache_write: 0 },
    }),
  ]);

  assert.deepEqual(result.registeredIds, []);
  assert.deepEqual(result.quarantined.map((candidate) => candidate.id), ["preview-disabled"]);
  assert.ok(result.quarantined[0]?.blockers.some((blocker) => /preview model/i.test(blocker)));
  assert.ok(result.quarantined[0]?.blockers.some((blocker) => /policy restricts/i.test(blocker)));
});

test("registerCopilotModelsInOverlay does not clobber a pre-existing overlay written by gsd update --models", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-copilot-overlay-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const overlayPath = join(tmp, "models-catalog.json");
  mkdirSync(tmp, { recursive: true });

  const preexisting = {
    version: 1,
    fetchedAt: "2026-01-01T00:00:00.000Z",
    source: "https://raw.githubusercontent.com/open-gsd/gsd-pi/main/packages/pi-ai/src/models.generated.json",
    models: {
      anthropic: { "claude-opus-4-6": { ...synthesizeCopilotOverlayEntry(completeRecord("claude-opus-4-6")), provider: "anthropic" } },
      "github-copilot": { "gpt-5.4": synthesizeCopilotOverlayEntry(completeRecord("gpt-5.4")) },
    },
  };
  writeFileSync(overlayPath, JSON.stringify(preexisting, null, 2));

  const result = registerCopilotModelsInOverlay(overlayPath, [completeRecord("gpt-5.4"), incompleteRecord("brand-new")]);
  assert.deepEqual(result.registeredIds, [], "existing authoritative entries and remote-only candidates are not written to disk");
  assert.deepEqual(result.quarantined.map((model) => model.id).sort(), ["brand-new"]);

  const onDisk = readModelsCatalogOverlay(overlayPath);
  const onDiskGitHubCopilotModels = (onDisk?.models["github-copilot"] ?? {}) as Record<string, unknown>;
  assert.deepEqual(onDisk, preexisting, "pre-existing overlay must be left intact and never overwritten with placeholders");
  assert.ok(onDisk?.models.anthropic["claude-opus-4-6"], "unrelated provider from gsd update --models survives");
  assert.ok(onDiskGitHubCopilotModels["gpt-5.4"], "existing copilot entry survives");
  assert.equal(onDiskGitHubCopilotModels["brand-new"], undefined, "remote-only model stays quarantined and is never materialized");
});

test("registerCopilotModelsInOverlay fails closed instead of overwriting a malformed existing overlay", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-copilot-overlay-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const overlayPath = join(tmp, "models-catalog.json");
  mkdirSync(tmp, { recursive: true });

  // Not valid JSON at all — indistinguishable from "missing" if read via
  // readModelsCatalogOverlay() alone, which would otherwise let registration
  // silently start a merge from an empty overlay and overwrite this file.
  writeFileSync(overlayPath, "not json at all");
  const rawBefore = readFileSync(overlayPath, "utf-8");

  const result = registerCopilotModelsInOverlay(overlayPath, [completeRecord("model-complete")]);

  assert.deepEqual(result.registeredIds, [], "registration must be skipped, not silently succeed against a corrupt file");
  assert.deepEqual(result.quarantined, []);
  assert.ok(result.overlayError, "a malformed existing overlay must be reported, not silently treated as absent");
  assert.equal(readFileSync(overlayPath, "utf-8"), rawBefore, "the corrupt file on disk must be left completely untouched");
});
