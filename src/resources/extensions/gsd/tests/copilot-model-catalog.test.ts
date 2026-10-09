import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getModels, getSupportedThinkingLevels } from "../../../../../packages/pi-ai/src/models.js";
import { streamSimpleOpenAICompletions } from "../../../../../packages/pi-ai/src/providers/openai-completions.js";
import type { Api, Model } from "../../../../../packages/pi-ai/src/types.js";
import {
  applyLastKnownGood,
  computeCatalogRegistrationCandidates,
  dedupeShellNotifications,
  diffCatalogSnapshots,
  fetchGitHubCopilotModels,
  registerCopilotModelsInOverlay,
  sanitizeGitHubCopilotModels,
  synthesizeCopilotOverlayEntry,
} from "../copilot-overlay-writer.js";

import {
  applyLastKnownGood as applyLastKnownGoodSnapshot,
  CopilotCatalogFetchError,
  dedupeShellNotifications as dedupeShellNotificationsSnapshot,
  diffCatalogSnapshots as diffCatalogSnapshotsSnapshot,
  fetchGitHubCopilotModels as fetchGitHubCopilotModelsSnapshot,
  sanitizeGitHubCopilotModels as sanitizeGitHubCopilotModelsSnapshot,
} from "../copilot-model-catalog.js";

function normalizedRecord(id: string, overrides: Record<string, unknown> = {}) {
  const record = sanitizeGitHubCopilotModels({
    data: [
      {
        id,
        name: id,
        tool_call: true,
        supported_endpoints: ["/responses"],
        vision: false,
        reasoning: true,
        limit: { context: 400000, output: 128000 },
        cost: { input: 0.2, output: 1.2, cache_read: 0, cache_write: 0 },
        ...overrides,
      },
    ],
  })[0];
  if (!record) throw new Error(`sanitizeGitHubCopilotModels returned no record for ${id}`);
  return record;
}

function isCompletionsModel(model: Model<Api>): model is Model<"openai-completions"> {
  return model.api === "openai-completions";
}

function assertCompletionsModel(model: Model<Api>): asserts model is Model<"openai-completions"> {
  if (!isCompletionsModel(model)) throw new Error(`Unexpected synthesized API: ${model.api}`);
}

async function captureCompletionsPayload(
  model: Model<"openai-completions">,
  reasoning: "minimal" | "low" | "high" | "xhigh" | "max",
): Promise<Record<string, unknown>> {
  let payload: unknown;
  const result = await streamSimpleOpenAICompletions(
    model,
    { systemPrompt: "", messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
    {
      apiKey: "test-key",
      reasoning,
      onPayload(value) {
        payload = structuredClone(value);
        throw new Error("COPILOT_TEST_PAYLOAD_CAPTURE");
      },
    },
  ).result();

  assert.ok(payload, result.errorMessage);
  assert.match(result.errorMessage ?? "", /COPILOT_TEST_PAYLOAD_CAPTURE/);
  return payload as Record<string, unknown>;
}

test("sanitizeGitHubCopilotModels parses the input_cost_per_token/output_cost_per_token per-token pricing shape", () => {
  const record = normalizedRecord("gpt-5.4-per-token-pricing", {
    cost: {
      input_cost_per_token: 0.000006,
      output_cost_per_token: 0.00003,
    },
  });

  assert.equal(record.billing.inputPer1k, 0.006);
  assert.ok(
    record.billing.outputPer1k !== undefined && Math.abs(record.billing.outputPer1k - 0.03) < 1e-9,
    `expected outputPer1k ~0.03, got ${record.billing.outputPer1k}`,
  );
  assert.equal(record.billing.billingUnit, "tokens");
});

test("fetchGitHubCopilotModels skips non-Copilot providers", async () => {
  let fetchCalled = false;
  const result = await fetchGitHubCopilotModels({
    provider: "openai",
    authToken: "token",
    fetchImpl: async () => {
      fetchCalled = true;
      return {
        ok: true,
        json: async () => ({ data: [] }),
      } as Response;
    },
  });

  assert.deepEqual(result, { skipped: true, reason: "provider-not-copilot", models: [] });
  assert.equal(fetchCalled, false);
});

test("fetchGitHubCopilotModels fetches GET /models and sanitizes data", async () => {
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];

  const result = await fetchGitHubCopilotModels({
    provider: "github-copilot",
    authToken: "abc123",
    baseUrl: "https://api.example.com",
    fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: String(init?.method ?? "GET"),
        headers: Object.fromEntries(Object.entries(init?.headers ?? {})),
      });

      return {
        ok: true,
        json: async () => ({
          data: [
            { id: "mai-code-1.1-flash", name: "MAI Code 1.1 Flash", tool_call: true },
            { id: "  ", name: "bad id" },
            { id: "claude-sonnet-5", name: " Claude Sonnet 5 ", tool_call: true },
            { id: "gpt-5.4", name: "gpt-5.4", tool_call: false },
          ],
        }),
      } as Response;
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://api.example.com/models");
  assert.equal(calls[0]?.method, "GET");
  assert.equal(calls[0]?.headers.Authorization, "Bearer abc123");

  assert.deepEqual(result.models.map((model) => model.id), [
    "claude-sonnet-5",
    "gpt-5.4",
    "mai-code-1.1-flash",
  ]);
  assert.equal(result.models[0]?.name, "Claude Sonnet 5");
});

test("fetchGitHubCopilotModels computes a provider-qualified registryId for each sanitized model", async () => {
  const result = await fetchGitHubCopilotModels({
    provider: "github-copilot",
    authToken: "abc123",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        data: [{ id: "mai-code-1.1-flash", name: "MAI Code 1.1 Flash", tool_call: true }],
      }),
    }) as Response,
  });

  assert.equal(result.models[0]?.registryId, "github-copilot/mai-code-1.1-flash");
});

test("fetchGitHubCopilotModels classifies 403 and 429 responses distinctly", async () => {
  await assert.rejects(
    fetchGitHubCopilotModels({
      provider: "github-copilot",
      fetchImpl: async () => ({ ok: false, status: 403 }) as Response,
    }),
    (error: unknown) => error instanceof CopilotCatalogFetchError && error.kind === "forbidden" && error.status === 403,
  );

  await assert.rejects(
    fetchGitHubCopilotModels({
      provider: "github-copilot",
      fetchImpl: async () => ({ ok: false, status: 429 }) as Response,
    }),
    (error: unknown) => error instanceof CopilotCatalogFetchError && error.kind === "rate-limited" && error.status === 429,
  );
});

test("fetchGitHubCopilotModels reports malformed JSON, timeout, and cancellation distinctly", async () => {
  await assert.rejects(
    fetchGitHubCopilotModels({
      provider: "github-copilot",
      fetchImpl: async () => ({ ok: true, json: async () => { throw new Error("bad json"); } }) as unknown as Response,
    }),
    (error: unknown) => error instanceof CopilotCatalogFetchError && error.kind === "malformed",
  );

  await assert.rejects(
    fetchGitHubCopilotModels({
      provider: "github-copilot",
      timeoutMs: 1,
      fetchImpl: async (_url: string | URL | Request, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
          init?.signal?.addEventListener("abort", () => reject(abortError), { once: true });
        }),
    }),
    (error: unknown) => error instanceof CopilotCatalogFetchError && error.kind === "timeout",
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    fetchGitHubCopilotModels({
      provider: "github-copilot",
      signal: controller.signal,
      fetchImpl: async (_url: string | URL | Request, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
          init?.signal?.addEventListener("abort", () => reject(abortError), { once: true });
        }),
    }),
    (error: unknown) => error instanceof CopilotCatalogFetchError && error.kind === "aborted",
  );
});

test("sanitizeGitHubCopilotModels preserves preview/disabled/policy metadata when supplied", () => {
  const record = sanitizeGitHubCopilotModels({
    data: [
      {
        id: "preview-model",
        name: "Preview Model",
        tool_call: true,
        enabled: false,
        preview: true,
        model_picker_enabled: false,
        policy_state: "restricted",
        supported_endpoints: ["/responses"],
        reasoning: true,
        limit: { context: 400000, output: 128000 },
        cost: { input: 0.2, output: 1.2, cache_read: 0, cache_write: 0 },
      },
    ],
  })[0]!;

  assert.equal(record.availability.enabled, false);
  assert.equal(record.availability.preview, true);
  assert.equal(record.availability.pickerEnabled, false);
  assert.equal(record.availability.policyState, "restricted");
});

test("sanitizeGitHubCopilotModels drops invalid and duplicate rows but keeps non-tool-capable records visible", () => {
  const sanitized = sanitizeGitHubCopilotModels({
    data: [
      { id: "mai-code-1.1-flash", name: "MAI Code 1.1 Flash", tool_call: true },
      { id: "mai-code-1.1-flash", name: "duplicate", tool_call: true },
      { id: "  ", name: "bad" },
      { id: "gpt-5.4", name: "gpt-5.4", tool_call: false },
      { id: "claude-sonnet-5", name: " Claude Sonnet 5 ", tool_call: true },
    ],
  });

  assert.deepEqual(sanitized.map((model) => model.id), [
    "claude-sonnet-5",
    "gpt-5.4",
    "mai-code-1.1-flash",
  ]);
  assert.equal(sanitized.find((model) => model.id === "gpt-5.4")?.execution.toolCalls, false);
});

test("sanitizeGitHubCopilotModels preserves missing tool-call metadata as unknown", () => {
  const record = sanitizeGitHubCopilotModels({
    data: [{ id: "unknown-tool-support", name: "Unknown Tool Support" }],
  })[0]!;

  assert.equal(record.execution.toolCalls, undefined);
});

test("sanitizeGitHubCopilotModels uses provider-qualified compatibility to resolve endpoint alternatives", () => {
  const record = sanitizeGitHubCopilotModels({
    data: [{
      id: "gpt-5.4",
      name: "GPT-5.4",
      supported_endpoints: ["/chat/completions", "/responses"],
    }],
  })[0]!;

  assert.equal(record.execution.api, "openai-responses");
  assert.deepEqual(record.conflicts, []);
});

test("sanitizeGitHubCopilotModels records a conflict when single live transport disagrees with provider-static transport", () => {
  const record = sanitizeGitHubCopilotModels({
    data: [{
      id: "gpt-5.4",
      name: "GPT-5.4",
      supported_endpoints: ["/chat/completions"],
    }],
  })[0]!;

  assert.equal(record.execution.api, "openai-completions");
  assert.deepEqual(record.conflicts, [
    "provider-live transport openai-completions conflicts with provider-static transport openai-responses",
  ]);
});

test("applyLastKnownGood preserves the prior valid snapshot on failure", () => {
  const previous = {
    generatedAt: "2026-08-14T00:00:00Z",
    models: ["mai-code-1.1-flash"],
  };

  const next = applyLastKnownGood(previous, {
    ok: false,
    error: "network error",
    snapshot: null,
  });

  assert.deepEqual(next, previous);
});

test("diffCatalogSnapshots reports adds, removals, and changes", () => {
  const diff = diffCatalogSnapshots(
    {
      generatedAt: "2026-08-14T00:00:00Z",
      hash: "previous",
      modelCount: 2,
      models: [
        normalizedRecord("mai-code-1.1-flash", { name: "MAI Code 1.1 Flash" }),
        normalizedRecord("claude-sonnet-5", { name: "Claude Sonnet 5" }),
      ],
    },
    {
      generatedAt: "2026-08-14T00:10:00Z",
      hash: "next",
      modelCount: 2,
      models: [
        normalizedRecord("mai-code-1.1-flash", { name: "MAI Code 1.1 Flash v2" }),
        normalizedRecord("gpt-5.4", { name: "GPT-5.4" }),
      ],
    },
  );

  assert.deepEqual(diff.added.map((model) => model.id), ["gpt-5.4"]);
  assert.deepEqual(diff.removed.map((model) => model.id), ["claude-sonnet-5"]);
  assert.deepEqual(diff.changed.map((model) => model.id), ["mai-code-1.1-flash"]);
});

test("dedupeShellNotifications collapses repeated alerts for the same model snapshot", () => {
  const deduped = dedupeShellNotifications([
    "copilot catalog updated",
    "copilot catalog updated",
    "copilot catalog updated",
    "copilot catalog changed",
    "copilot catalog changed",
  ]);

  assert.deepEqual(deduped, [
    "copilot catalog updated",
    "copilot catalog changed",
  ]);
});

test("computeCatalogRegistrationCandidates subtracts the effective local catalog", () => {
  const candidates = computeCatalogRegistrationCandidates(
    [
      normalizedRecord("mai-code-1.1-flash"),
      normalizedRecord("gpt-5.4"),
      normalizedRecord("brand-new-model", { supported_endpoints: [], reasoning: undefined, limit: {}, cost: {} }),
    ],
    [
      { id: "mai-code-1.1-flash", provider: "github-copilot" },
      { id: "gpt-5.4", provider: "github-copilot" },
    ],
  );

  assert.deepEqual(candidates.map((model) => model.id), ["brand-new-model"]);
});

test("registerCopilotModelsInOverlay quarantines remote-only candidates instead of writing fabricated metadata", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-copilot-quarantine-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const overlayPath = join(tmp, "models-catalog.json");
  const plan = registerCopilotModelsInOverlay(
    overlayPath,
    [normalizedRecord("brand-new-model", { supported_endpoints: [], reasoning: undefined, limit: {}, cost: {} })],
    [{ id: "gpt-5.4", provider: "github-copilot" }],
  );

  assert.deepEqual(plan.registeredIds, []);
  assert.deepEqual(plan.quarantined.map((model) => model.id), ["brand-new-model"]);
  assert.equal(plan.overlayPath, overlayPath);
});

test("registerCopilotModelsInOverlay quarantines candidates with unknown input modality", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-copilot-quarantine-vision-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const overlayPath = join(tmp, "models-catalog.json");
  const plan = registerCopilotModelsInOverlay(
    overlayPath,
    [normalizedRecord("brand-new-unknown-vision", { supports_vision: undefined, vision: undefined })],
    [],
  );

  assert.deepEqual(plan.registeredIds, []);
  assert.deepEqual(plan.quarantined.map((model) => model.id), ["brand-new-unknown-vision"]);
  assert.deepEqual(plan.quarantined[0]?.blockers, ["missing authoritative input modality"]);
});

test("registerCopilotModelsInOverlay writes complete remote-only candidates into the overlay", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-copilot-complete-candidate-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const overlayPath = join(tmp, "models-catalog.json");
  const plan = registerCopilotModelsInOverlay(
    overlayPath,
    [normalizedRecord("brand-new-complete", { name: "Brand New Complete" })],
    [{ id: "gpt-5.4", provider: "github-copilot" }],
  );

  assert.deepEqual(plan.registeredIds, ["brand-new-complete"]);
  assert.deepEqual(plan.quarantined, []);
});

test("normalizes SDK effort aliases and nested transport support through a real Completions payload", async () => {
  const record = normalizedRecord("live-completions-efforts", {
    supported_endpoints: ["/chat/completions"],
    supportedReasoningEfforts: ["low", "high"],
    capabilities: { supports: { reasoning_effort: true } },
  });

  assert.deepEqual(record.execution.reasoningLevels, ["low", "high"]);
  assert.equal(record.execution.reasoningEffortCompatible, true);

  const model = synthesizeCopilotOverlayEntry(record);
  assert.deepEqual(getSupportedThinkingLevels(model), ["low", "high"]);
  assert.deepEqual(model.thinkingLevelMap, {
    off: null,
    minimal: null,
    low: "low",
    medium: null,
    high: "high",
    xhigh: null,
    max: null,
  });
  assertCompletionsModel(model);
  assert.equal(model.compat?.supportsReasoningEffort, true);

  const payload = await captureCompletionsPayload(model, "xhigh");
  assert.equal(payload.reasoning_effort, "high");
});

test("explicitly empty live efforts suppress static fallback and synthesized efforts", () => {
  const staticModel = getModels("github-copilot").find(
    (model) => model.thinkingLevelMap
      && Object.entries(model.thinkingLevelMap).some(([level, mapped]) => mapped !== null && mapped !== level),
  );
  assert.ok(staticModel, "fixture requires a static Copilot model with a thinking-level alias");

  const record = normalizedRecord(staticModel.id, { supported_reasoning_efforts: [] });
  assert.deepEqual(record.execution.reasoningLevels, []);
  assert.deepEqual(record.execution.reasoningLevelMap, {
    off: null,
    minimal: null,
    low: null,
    medium: null,
    high: null,
    xhigh: null,
    max: null,
  });
  assert.equal(record.execution.reasoningEffortCompatible, false);

  const malformed = normalizedRecord(staticModel.id, { supported_reasoning_efforts: "high" });
  assert.deepEqual(malformed.execution.reasoningLevels, []);
});

test("conflicting live effort aliases are intersected instead of broadened", () => {
  const record = normalizedRecord("conflicting-effort-aliases", {
    supported_reasoning_efforts: ["low", "high"],
    supportedReasoningEfforts: ["low", "xhigh"],
  });

  test("live levels preserve static aliases and do not invent Anthropic adaptive compatibility", () => {
    const alias = synthesizeCopilotOverlayEntry(normalizedRecord("mai-code-1.1-flash", {
      supportedReasoningEfforts: ["minimal", "low", "high", "xhigh"],
    }));
    assert.equal(alias.thinkingLevelMap?.minimal, "low");
    assert.equal(alias.thinkingLevelMap?.xhigh, "high");

    const unknown = synthesizeCopilotOverlayEntry(normalizedRecord("unknown-anthropic-efforts", {
      supported_endpoints: ["/v1/messages"],
      supportedReasoningEfforts: ["high", "xhigh"],
    }));
    assert.deepEqual(getSupportedThinkingLevels(unknown), []);
    assert.equal(unknown.compat, undefined);
  });

  assert.deepEqual(record.execution.reasoningLevels, ["low"]);
});

test("a static Completions model stays disabled without live evidence but accepts matching live evidence", async () => {
  const staticModel = getModels("github-copilot").find(
    (model) => isCompletionsModel(model) && model.compat?.supportsReasoningEffort === false,
  );
  assert.ok(staticModel, "fixture requires a bundled Completions model with effort compatibility disabled");
  assertCompletionsModel(staticModel);

  const fallback = synthesizeCopilotOverlayEntry(normalizedRecord(staticModel.id, {
    supported_endpoints: ["/chat/completions"],
  }));
  assertCompletionsModel(fallback);
  assert.equal(fallback.compat?.supportsReasoningEffort, false);
  assert.deepEqual(getSupportedThinkingLevels(fallback), []);
  assert.deepEqual(fallback.thinkingLevelMap, {
    off: null,
    minimal: null,
    low: null,
    medium: null,
    high: null,
    xhigh: null,
    max: null,
  });

  const live = synthesizeCopilotOverlayEntry(normalizedRecord(staticModel.id, {
    supported_endpoints: ["/chat/completions"],
    supported_reasoning_efforts: ["low", "high"],
    capabilities: { supports: { reasoning_effort: true } },
  }));
  assertCompletionsModel(live);
  assert.equal(live.compat?.supportsReasoningEffort, true);
  assert.deepEqual(getSupportedThinkingLevels(live), ["low", "high"]);
  const payload = await captureCompletionsPayload(live, "high");
  assert.equal(payload.reasoning_effort, "high");
});

test("unknown-only live endpoints do not enable static Completions effort compatibility", async () => {
  // gpt-6-astra is now statically Responses-routed (catalog fix 173645ec); use
  // claude-opus-5, which is genuinely Completions-routed, to exercise the same
  // unknown-live-endpoint-evidence scenario this fixture was written for.
  for (const evidence of [
    { supported_reasoning_efforts: ["high"] },
    { capabilities: { supports: { reasoning_effort: true } } },
  ]) {
    const record = normalizedRecord("claude-opus-5", {
      supported_endpoints: ["/embeddings"],
      ...evidence,
    });
    assert.equal(record.execution.api, "openai-completions");
    assert.equal(record.execution.reasoningEffortCompatible, false);
    const model = synthesizeCopilotOverlayEntry(record);
    assertCompletionsModel(model);
    assert.equal(model.compat?.supportsReasoningEffort, false);
    assert.deepEqual(getSupportedThinkingLevels(model), []);
    assert.equal((await captureCompletionsPayload(model, "high")).reasoning_effort, undefined);
  }

  const recognized = normalizedRecord("claude-opus-5", {
    supported_endpoints: ["/embeddings", "/chat/completions"],
    supported_reasoning_efforts: ["high"],
  });
  assert.equal(recognized.execution.reasoningEffortCompatible, true);
  const model = synthesizeCopilotOverlayEntry(recognized);
  assertCompletionsModel(model);
  assert.equal((await captureCompletionsPayload(model, "high")).reasoning_effort, "high");
});

test("static fallback preserves mapped aliases and explicitly disables unsupported levels", () => {
  const staticModel = getModels("github-copilot").find(
    (model) => model.reasoning
      && model.thinkingLevelMap
      && Object.entries(model.thinkingLevelMap).some(([level, mapped]) => mapped !== null && mapped !== level),
  );
  assert.ok(staticModel, "fixture requires a static Copilot model with a thinking-level alias");

  const record = normalizedRecord(staticModel.id);
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
    const supported = getSupportedThinkingLevels(staticModel).includes(level);
    assert.equal(
      record.execution.reasoningLevelMap?.[level],
      supported ? staticModel.thinkingLevelMap?.[level] ?? level : null,
      `static fallback mapping for ${level}`,
    );
  }
});

test("nested effort lists are authoritative, including empty and conflicting declarations", async () => {
  const record = normalizedRecord("diagnostic-nested-effort", {
    supported_endpoints: ["/chat/completions"],
    capabilities: { supports: { reasoning_effort: ["low", "high", "xhigh", "max"] } },
  });
  assert.deepEqual(record.execution.reasoningLevels, ["low", "high", "xhigh", "max"]);
  const model = synthesizeCopilotOverlayEntry(record);
  assertCompletionsModel(model);
  for (const level of ["low", "high", "xhigh", "max"] as const) {
    assert.equal((await captureCompletionsPayload(model, level)).reasoning_effort, level);
  }

  for (const nested of [[], "high", null, ["high", 1], ["low", "future-effort"]]) {
    const empty = normalizedRecord("gpt-5.6-sol", {
      capabilities: { supports: { reasoning_effort: nested } },
    });
    assert.deepEqual(empty.execution.reasoningLevels, []);
  }
  const conflicting = normalizedRecord("nested-top-level-conflict", {
    supportedReasoningEfforts: ["low", "max"],
    capabilities: { supports: { reasoning_effort: ["high", "max"] } },
  });
  assert.deepEqual(conflicting.execution.reasoningLevels, ["max"]);
});

test("unknown or conflicting Completions effort evidence fails closed at the production adapter", async () => {
  for (const overrides of [
    { supported_endpoints: ["/chat/completions"] },
    {
      supported_endpoints: ["/chat/completions"],
      supported_reasoning_efforts: ["low", "high"],
      capabilities: { supports: { reasoning_effort: false } },
    },
    {
      supported_endpoints: ["/chat/completions"],
      supported_reasoning_efforts: ["future-effort"],
      capabilities: { supports: { reasoning_effort: true } },
    },
  ]) {
    const model = synthesizeCopilotOverlayEntry(normalizedRecord("unknown-completions-efforts", overrides));
    assertCompletionsModel(model);
    assert.equal(model.compat?.supportsReasoningEffort, false);
    assert.deepEqual(getSupportedThinkingLevels(model), []);
    const payload = await captureCompletionsPayload(model, "high");
    assert.equal(payload.reasoning_effort, undefined);
  }

  const responseModel = synthesizeCopilotOverlayEntry(normalizedRecord("responses-efforts", {
    supported_endpoints: ["/responses"],
    supported_reasoning_efforts: ["low", "high"],
    capabilities: { supports: { reasoning_effort: true } },
  }));
  assert.equal(responseModel.api, "openai-responses");
  assert.deepEqual(getSupportedThinkingLevels(responseModel), ["low", "high"]);
});
