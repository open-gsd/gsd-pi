// Regression/behavior tests for the production wiring of the GitHub Copilot
// model catalog check (/gsd copilot-models). Exercises the real entry point —
// ctx.modelRegistry gating, last-known-good preservation, and deduped diff
// notifications — as opposed to the pure-function fixtures in
// copilot-model-catalog.test.ts.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { getGsdArgumentCompletions } from "../commands/catalog.js";
import {
  _resetCopilotModelsSessionStateForTests,
  handleCopilotModels,
} from "../commands/handlers/copilot-models.js";
import { showHelp } from "../commands/handlers/core.js";
import { readModelsCatalogOverlay } from "../copilot-overlay-writer.js";

interface FakeModel {
  id: string;
  provider: string;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

function createFakeCtx(options: {
  models?: FakeModel[];
  apiKey?: string | undefined;
  /** Simulate auth resolved outside authStorage (e.g. an env var or a models.json provider key). */
  credentialOutsideAuthStorage?: boolean;
  modelsJsonPath?: string;
}): { ctx: ExtensionCommandContext; notifications: Array<{ message: string; level: string }>; refreshCallCount: () => number } {
  const notifications: Array<{ message: string; level: string }> = [];
  const models = options.models ?? [];
  let refreshCalls = 0;
  const ctx = {
    modelRegistry: {
      getAll: () => models.map((model) => ({ ...model, api: "openai-completions", name: model.id, baseUrl: "https://example.test", provider: model.provider, reasoning: false, input: ["text"], cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096, compat: {} })),
      getAvailable: () => models,
      getApiKey: async (_model: FakeModel) => options.apiKey,
      hasConfiguredAuth: (_model: FakeModel) => options.apiKey !== undefined,
      getProviderAuthStatus: (_provider: string) => ({
        configured: options.apiKey !== undefined,
        source: options.apiKey !== undefined ? ("environment" as const) : undefined,
        label: options.apiKey !== undefined ? "FAKE_ENV_VAR" : undefined,
      }),
      authStorage: {
        get: (_provider: string) =>
          options.apiKey !== undefined && !options.credentialOutsideAuthStorage
            ? { type: "api_key" as const, key: options.apiKey }
            : undefined,
      },
      refresh: () => {
        refreshCalls += 1;
      },
      modelsJsonPath: options.modelsJsonPath,
    },
    ui: {
      notify: (message: string, level: string = "info") => {
        notifications.push({ message, level });
      },
    },
  };
  return { ctx: ctx as unknown as ExtensionCommandContext, notifications, refreshCallCount: () => refreshCalls };
}

function jsonResponse(data: Array<Record<string, unknown>>) {
  return async () => ({ ok: true, json: async () => ({ data }) }) as unknown as Response;
}

test("handleCopilotModels: no Copilot model available makes zero network requests", async () => {
  _resetCopilotModelsSessionStateForTests();
  let fetchCalled = false;
  const { ctx, notifications } = createFakeCtx({ models: [] });

  await handleCopilotModels("", ctx, {
    fetchImpl: (async () => {
      fetchCalled = true;
      throw new Error("must not be called");
    }) as unknown as typeof fetch,
  });

  assert.equal(fetchCalled, false, "no network request without a configured Copilot credential");
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /not configured/);
  assert.equal(notifications[0].level, "info");
});

test("handleCopilotModels: missing API key warns without a network request", async () => {
  _resetCopilotModelsSessionStateForTests();
  let fetchCalled = false;
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: undefined,
  });

  await handleCopilotModels("", ctx, {
    fetchImpl: (async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({ data: [] }) } as unknown as Response;
    }) as unknown as typeof fetch,
  });

  assert.equal(fetchCalled, false);
  assert.equal(notifications[0].level, "warning");
  assert.match(notifications[0].message, /no access token/);
});

test("handleCopilotModels: first successful check reports model count and caches snapshot", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([
      { id: "gpt-5.4", name: "GPT-5.4", tool_call: true },
      { id: "claude-sonnet-5", name: "Claude Sonnet 5", tool_call: true },
    ]) as unknown as typeof fetch,
  });

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "info");
  assert.match(notifications[0].message, /2 model\(s\) available/);
});

test("handleCopilotModels: reports added/removed/changed drift and dedupes repeats", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([
      { id: "gpt-5.4", name: "GPT-5.4", tool_call: true },
      { id: "claude-sonnet-5", name: "Claude Sonnet 5", tool_call: true },
    ]) as unknown as typeof fetch,
  });

  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([
      { id: "gpt-5.4", name: "GPT-5.4", tool_call: true },
      { id: "mai-code-1.1-flash", name: "MAI Code 1.1 Flash", tool_call: true },
    ]) as unknown as typeof fetch,
  });

  const drift = notifications[1];
  assert.equal(drift.level, "info");
  assert.match(drift.message, /\+ github-copilot\/mai-code-1\.1-flash added/);
  assert.match(drift.message, /- github-copilot\/claude-sonnet-5 removed/);

  // Re-running the identical fetch should not repeat the same drift notice.
  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([
      { id: "gpt-5.4", name: "GPT-5.4", tool_call: true },
      { id: "mai-code-1.1-flash", name: "MAI Code 1.1 Flash", tool_call: true },
    ]) as unknown as typeof fetch,
  });
  assert.equal(notifications.length, 3);
  assert.match(notifications[2].message, /no new changes/);
});

test("handleCopilotModels: a model added, removed, then re-added is reported again, not suppressed by the first add notice", async () => {
  // Dedup only suppresses an exact repeat of the immediately-preceding
  // notification's content, not a permanent record of every message ever
  // shown, so the second "added" occurrence for the same model (whose
  // content differs from what was shown just before it, the "removed"
  // notice) must not be silently dropped.
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([
      { id: "gpt-5.4", name: "GPT-5.4", tool_call: true },
      { id: "claude-sonnet-5", name: "Claude Sonnet 5", tool_call: true },
    ]) as unknown as typeof fetch,
  });

  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([{ id: "gpt-5.4", name: "GPT-5.4", tool_call: true }]) as unknown as typeof fetch,
  });
  assert.match(notifications[1].message, /- github-copilot\/claude-sonnet-5 removed/);

  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([
      { id: "gpt-5.4", name: "GPT-5.4", tool_call: true },
      { id: "claude-sonnet-5", name: "Claude Sonnet 5", tool_call: true },
    ]) as unknown as typeof fetch,
  });

  assert.equal(notifications.length, 3);
  assert.doesNotMatch(notifications[2].message, /no new changes/);
  assert.match(
    notifications[2].message,
    /\+ github-copilot\/claude-sonnet-5 added/,
    "re-adding a previously-removed model must be reported again, not suppressed by the earlier add notice",
  );
});

test("handleCopilotModels: an add/remove cycle that repeats an earlier snapshot transition still reports the second occurrence", async () => {
  // A permanent (previous -> new) snapshot-transition record would wrongly
  // suppress this: the second A -> B transition reuses the exact same
  // snapshot-hash pair as the first A -> B transition, even though a B -> A
  // transition (a different, freshly-shown notice) happened in between.
  // Dedup must compare against what was shown *immediately before*, not
  // against a permanent history of transition hashes.
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  const withoutExtra = jsonResponse([{ id: "gpt-5.4", name: "GPT-5.4", tool_call: true }]) as unknown as typeof fetch;
  const withExtra = jsonResponse([
    { id: "gpt-5.4", name: "GPT-5.4", tool_call: true },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5", tool_call: true },
  ]) as unknown as typeof fetch;

  await handleCopilotModels("", ctx, { fetchImpl: withoutExtra }); // baseline: A
  await handleCopilotModels("", ctx, { fetchImpl: withExtra }); // A -> B (1st time)
  assert.match(notifications[1].message, /\+ github-copilot\/claude-sonnet-5 added/);

  await handleCopilotModels("", ctx, { fetchImpl: withoutExtra }); // B -> A
  assert.match(notifications[2].message, /- github-copilot\/claude-sonnet-5 removed/);

  await handleCopilotModels("", ctx, { fetchImpl: withExtra }); // A -> B (2nd time, same hash pair as the 1st)
  assert.equal(notifications.length, 4);
  assert.doesNotMatch(
    notifications[3].message,
    /no new changes/,
    "a snapshot transition repeating an earlier hash pair must still be reported when it wasn't the immediately-preceding notice",
  );
  assert.match(notifications[3].message, /\+ github-copilot\/claude-sonnet-5 added/);
});

test("handleCopilotModels: --register reports registration output even when an earlier plain sync already marked the unchanged catalog as notified", async (t) => {
  // A permanent per-transition notified-set would mark the unchanged (A -> A)
  // transition as "already notified" from the plain `sync` call below, then
  // wrongly suppress the *different*, registration-specific content that a
  // later `sync --register` call produces for that same unchanged catalog.
  _resetCopilotModelsSessionStateForTests();
  const tmp = mkdtempSync(join(tmpdir(), "gsd-copilot-models-handler-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const overlayPath = join(tmp, "models-catalog.json");

  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });
  const fetchImpl = jsonResponse([
    { id: "gpt-5.4", name: "GPT-5.4", tool_call: true },
    { id: "brand-new-model", name: "Brand New Model", tool_call: true },
  ]) as unknown as typeof fetch;

  await handleCopilotModels("", ctx, { fetchImpl, overlayPath }); // establishes the baseline snapshot
  await handleCopilotModels("", ctx, { fetchImpl, overlayPath }); // unchanged (A -> A): "no new changes"
  assert.match(notifications[1].message, /no new changes/);

  await handleCopilotModels("--register", ctx, { fetchImpl, overlayPath }); // same unchanged catalog, but registers
  assert.doesNotMatch(
    notifications[2].message,
    /no new changes/,
    "registration output for the same unchanged catalog must not be suppressed by the earlier no-diff sync",
  );
  assert.match(notifications[2].message, /quarantined|registered/i);
});

test("handleCopilotModels: fetch failure preserves last-known-good snapshot", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([{ id: "gpt-5.4", name: "GPT-5.4", tool_call: true }]) as unknown as typeof fetch,
  });

  await handleCopilotModels("", ctx, {
    fetchImpl: (async () => ({ ok: false, status: 500 }) as unknown as Response) as unknown as typeof fetch,
  });
  assert.equal(notifications[1].level, "warning");
  assert.match(notifications[1].message, /refresh failed/);

  // A subsequent successful call must diff against the pre-failure baseline,
  // proving the failed attempt never clobbered the cached snapshot.
  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([
      { id: "gpt-5.4", name: "GPT-5.4", tool_call: true },
      { id: "gpt-5.5", name: "GPT-5.5", tool_call: true },
    ]) as unknown as typeof fetch,
  });
  assert.match(notifications[2].message, /\+ github-copilot\/gpt-5\.5 added/);
});

test("handleCopilotModels: empty response never overwrites the cached catalog", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([{ id: "gpt-5.4", name: "GPT-5.4", tool_call: true }]) as unknown as typeof fetch,
  });

  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([]) as unknown as typeof fetch,
  });
  assert.equal(notifications[1].level, "warning");
  assert.match(notifications[1].message, /suspicious/);
});

test("handleCopilotModels: failure with no cached catalog yet reports clearly", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("", ctx, {
    fetchImpl: (async () => ({ ok: false, status: 401 }) as unknown as Response) as unknown as typeof fetch,
  });

  assert.equal(notifications[0].level, "warning");
  assert.match(notifications[0].message, /no cached catalog yet/);
});

// ─── why <model>: strict parsing, registry analysis, routing eligibility ────

test("handleCopilotModels: why with no model argument reports usage and never touches auth or network", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({ models: [], apiKey: undefined });
  let fetchCalled = false;
  let apiKeyCalled = false;
  ctx.modelRegistry.getApiKey = async () => { apiKeyCalled = true; return "token-abc"; };

  await handleCopilotModels("why", ctx, {
    fetchImpl: (async () => { fetchCalled = true; throw new Error("must not be called"); }) as unknown as typeof fetch,
  });
  await handleCopilotModels("why   ", ctx, {
    fetchImpl: (async () => { fetchCalled = true; throw new Error("must not be called"); }) as unknown as typeof fetch,
  });

  assert.equal(fetchCalled, false);
  assert.equal(apiKeyCalled, false);
  assert.equal(notifications.length, 2);
  assert.equal(notifications[0].message, "Usage: /gsd copilot-models why <model>");
  assert.equal(notifications[0].level, "warning");
  assert.equal(notifications[1].message, "Usage: /gsd copilot-models why <model>");
});

test("handleCopilotModels: placeholder syntax is never completed or accepted as a model ID", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({ models: [], apiKey: undefined });

  const completions = getGsdArgumentCompletions("copilot-models ");
  assert.ok(completions.some((entry) => entry.label === "pricing" && entry.value === "copilot-models pricing"));
  assert.ok(completions.some((entry) => entry.label === "why" && entry.value === "copilot-models why"));
  assert.ok(completions.every((entry) => !/[\[<]model[\]>]/i.test(entry.value)));

  await handleCopilotModels("pricing [model]", ctx, {});
  await handleCopilotModels("why <model>", ctx, {});

  assert.deepEqual(
    notifications.map((notification) => notification.message),
    [
      "Usage: /gsd copilot-models pricing <model>",
      "Usage: /gsd copilot-models why <model>",
    ],
  );
});

test("getGsdArgumentCompletions: copilot-models pricing and why complete real model IDs after the subcommand", () => {
  const pricing = getGsdArgumentCompletions("copilot-models pricing gpt-5");
  const why = getGsdArgumentCompletions("copilot-models why kimi");

  assert.ok(
    pricing.some((entry) => entry.value === "copilot-models pricing gpt-5.3-codex"),
    "pricing subcommand should complete concrete GitHub Copilot model IDs",
  );
  assert.ok(
    why.some((entry) => entry.value === "copilot-models why kimi-k3"),
    "why subcommand should complete concrete GitHub Copilot model IDs",
  );
  assert.ok(pricing.every((entry) => !/[\[<]model[\]>]/i.test(entry.value)));
  assert.ok(why.every((entry) => !/[\[<]model[\]>]/i.test(entry.value)));
});

test("handleCopilotModels: help subcommand prints usage without auth or network", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({ models: [], apiKey: undefined });
  let fetchCalled = false;
  let apiKeyCalled = false;
  ctx.modelRegistry.getApiKey = async () => { apiKeyCalled = true; return "token-abc"; };

  await handleCopilotModels("help", ctx, {
    fetchImpl: (async () => { fetchCalled = true; throw new Error("must not be called"); }) as unknown as typeof fetch,
  });
  await handleCopilotModels("--help", ctx, {
    fetchImpl: (async () => { fetchCalled = true; throw new Error("must not be called"); }) as unknown as typeof fetch,
  });
  await handleCopilotModels("-h", ctx, {
    fetchImpl: (async () => { fetchCalled = true; throw new Error("must not be called"); }) as unknown as typeof fetch,
  });

  assert.equal(fetchCalled, false);
  assert.equal(apiKeyCalled, false);
  assert.equal(notifications.length, 3);
  for (const notification of notifications) {
    assert.equal(notification.level, "info");
    assert.match(notification.message, /GitHub Copilot model catalog/);
    assert.match(notification.message, /sync/);
    assert.match(notification.message, /why/);
  }
});

test("handleCopilotModels: unknown subcommand now includes full usage in warning", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({ models: [], apiKey: undefined });

  await handleCopilotModels("unknown", ctx, {});

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "warning");
  assert.match(notifications[0].message, /Unknown \/gsd copilot-models subcommand "unknown"/);
  assert.match(notifications[0].message, /sync/);
  assert.match(notifications[0].message, /why/);
});

test("handleCopilotModels: 'whywhatever' and 'why-gpt-5.4' are not recognized as the why command", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({ models: [], apiKey: undefined });

  await handleCopilotModels("whywhatever", ctx, {});
  await handleCopilotModels("why-gpt-5.4", ctx, {});

  // Both are rejected as unknown subcommands rather than silently falling
  // through to sync -- a typo must never trigger authenticated network I/O.
  assert.equal(notifications.length, 2);
  assert.match(notifications[0].message, /Unknown \/gsd copilot-models subcommand "whywhatever"/);
  assert.match(notifications[1].message, /Unknown \/gsd copilot-models subcommand "why-gpt-5\.4"/);
});

test("handleCopilotModels: unrecognized subcommand is rejected without any network request", async () => {
  _resetCopilotModelsSessionStateForTests();
  let fetchCalled = false;
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("anything --register", ctx, {
    fetchImpl: (async () => {
      fetchCalled = true;
      throw new Error("must not be called");
    }) as unknown as typeof fetch,
  });

  assert.equal(fetchCalled, false, "an unrecognized subcommand must never reach the overlay-writing sync path");
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /Unknown \/gsd copilot-models subcommand "anything"/);
});

test("handleCopilotModels: a bare --register flag still defaults to sync", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: undefined,
  });

  await handleCopilotModels("--register", ctx, {});

  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /no access token/);
});

test("handleCopilotModels: why accepts a bare Copilot model ID", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("why gpt-5.4", ctx, {
    fetchImpl: (async () => { throw new Error("must not be called"); }) as unknown as typeof fetch,
  });

  assert.match(notifications[0].message, /^GitHub Copilot: why github-copilot\/gpt-5\.4$/m);
  assert.match(notifications[0].message, /^- identity: github-copilot\/gpt-5\.4$/m);
});

test("handleCopilotModels: why accepts a provider-qualified Copilot model ID", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("why github-copilot/gpt-5.4", ctx, {});

  assert.match(notifications[0].message, /^- identity: github-copilot\/gpt-5\.4$/m);
});

test("handleCopilotModels: why rejects non-GitHub-Copilot provider-qualified model IDs", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  let fetchCalled = false;
  await handleCopilotModels("why anthropic/claude-sonnet-5", ctx, {
    fetchImpl: (async () => {
      fetchCalled = true;
      return jsonResponse([{ id: "claude-sonnet-5", name: "Claude Sonnet 5", tool_call: true }])() as unknown as Response;
    }) as unknown as typeof fetch,
  });

  assert.equal(fetchCalled, false, "wrong-provider why requests must not trigger fetches");
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /github copilot.*anthropic|only accepts github-copilot|wrong provider/i);
});

test("handleCopilotModels: why never matches a bare ID that only exists under a different provider", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "claude-sonnet-5", provider: "anthropic" }],
    apiKey: undefined,
  });

  await handleCopilotModels("why claude-sonnet-5", ctx, {});

  assert.match(notifications[0].message, /^- effective local: no$/m);
  assert.match(notifications[0].message, /^- session available: no$/m);
  assert.match(notifications[0].message, /^- last known live catalog: unknown$/m);
});

test("handleCopilotModels: why reports effective-local and session-available as yes when both hold", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: undefined,
  });

  await handleCopilotModels("why gpt-5.4", ctx, {});

  assert.match(notifications[0].message, /^- effective local: yes$/m);
  assert.match(notifications[0].message, /^- session available: yes$/m);
});

test("handleCopilotModels: why reports session-available as no when the model is local but not session-ready", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: undefined,
  });
  ctx.modelRegistry.getAvailable = () => [];

  await handleCopilotModels("why gpt-5.4", ctx, {});

  assert.match(notifications[0].message, /^- effective local: yes$/m);
  assert.match(notifications[0].message, /^- session available: no$/m);
  assert.match(notifications[0].message, /^- automatic routing eligible: no$/m);
  assert.match(notifications[0].message, /^- reason: unavailable in this session$/m);
});

test("handleCopilotModels: why flags a remote-only snapshot model as quarantined and non-routable", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  // Establish a live snapshot that includes a model absent from the local registry.
  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([
      { id: "gpt-5.4", name: "GPT-5.4", tool_call: true },
      { id: "remote-only-model", name: "Remote Only Model", tool_call: true },
    ]) as unknown as typeof fetch,
  });

  await handleCopilotModels("why remote-only-model", ctx, {
    fetchImpl: (async () => { throw new Error("must not be called"); }) as unknown as typeof fetch,
  });

  const explanation = notifications[notifications.length - 1].message;
  assert.match(explanation, /^- effective local: no$/m);
  assert.match(explanation, /^- last known live catalog: yes$/m);
  assert.match(explanation, /^- automatic routing eligible: no$/m);
  assert.match(explanation, /^- reason: remote-only and quarantined$/m);
});

test("handleCopilotModels: why reports last known live catalog as yes when the snapshot contains the model", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([{ id: "gpt-5.4", name: "GPT-5.4", tool_call: true }]) as unknown as typeof fetch,
  });
  await handleCopilotModels("why gpt-5.4", ctx, {});

  assert.match(notifications[1].message, /^- last known live catalog: yes$/m);
});

test("handleCopilotModels: why reports last known live catalog as no when the snapshot exists but omits the model", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([{ id: "gpt-5.4", name: "GPT-5.4", tool_call: true }]) as unknown as typeof fetch,
  });
  await handleCopilotModels("why totally-different-model", ctx, {});

  assert.match(notifications[1].message, /^- last known live catalog: no$/m);
});

test("handleCopilotModels: why reports last known live catalog as unknown when no snapshot exists yet", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("why gpt-5.4", ctx, {});

  assert.match(notifications[0].message, /^- last known live catalog: unknown$/m);
  assert.match(notifications[0].message, /^- tool calls: unknown$/m);
});

test("handleCopilotModels: why preserves unknown live tool-call support", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("sync", ctx, {
    fetchImpl: jsonResponse([{ id: "gpt-5.4", name: "GPT-5.4" }]) as unknown as typeof fetch,
  });
  await handleCopilotModels("why gpt-5.4", ctx, {});

  assert.match(notifications[1].message, /^- tool calls: unknown$/m);
});

test("handleCopilotModels: why marks an unknown capability tier/confidence as not routing-eligible", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "totally-custom-model-x", provider: "github-copilot" }],
    apiKey: undefined,
  });

  await handleCopilotModels("why totally-custom-model-x", ctx, {});

  assert.match(notifications[0].message, /^- capability tier: unknown$/m);
  assert.match(notifications[0].message, /^- profile confidence: unknown$/m);
  assert.match(notifications[0].message, /^- automatic routing eligible: no$/m);
  assert.match(notifications[0].message, /^- reason: capability profile unknown$/m);
});

test("handleCopilotModels: why reports known economics with source and freshness", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "mai-code-1.1-flash", provider: "github-copilot" }],
    apiKey: undefined,
  });

  await handleCopilotModels("why mai-code-1.1-flash", ctx, {});

  assert.match(notifications[0].message, /^- economics: \$0\.0002 per 1K input \/ \$0\.0012 per 1K output$/m);
  assert.match(notifications[0].message, /^- source: provider-static$/m);
  assert.match(notifications[0].message, /^- freshness: stale$/m);
});

test("handleCopilotModels: why reports unknown economics without a synthetic zero placeholder", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "totally-custom-model-x", provider: "github-copilot" }],
    apiKey: undefined,
  });

  await handleCopilotModels("why totally-custom-model-x", ctx, {});

  assert.match(notifications[0].message, /^- economics: unknown$/m);
  assert.match(notifications[0].message, /^- source: unknown$/m);
  assert.match(notifications[0].message, /^- freshness: unknown$/m);
  assert.doesNotMatch(notifications[0].message, /\$0\.0000/);
  assert.doesNotMatch(notifications[0].message, /\bstandard\b/);
});

test("handleCopilotModels: why reports a meaningful local cost as provider-static, not a fresh user override", async () => {
  // The effective local model can be bundled/overlay-sourced, not necessarily
  // user-authored — it must still win over this module's separate hardcoded
  // static reference list, but must NOT be reported as fresh "user" data.
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{
      id: "totally-custom-model-x",
      provider: "github-copilot",
      cost: { input: 500, output: 2500, cacheRead: 0, cacheWrite: 0 },
    }],
    apiKey: undefined,
  });

  await handleCopilotModels("why totally-custom-model-x", ctx, {});

  assert.match(notifications[0].message, /^- economics: \$0\.5000 per 1K input \/ \$2\.5000 per 1K output$/m);
  assert.match(notifications[0].message, /^- source: provider-static$/m);
  assert.match(notifications[0].message, /^- freshness: stale$/m);
});

test("handleCopilotModels: why reports a genuine models.json cost override as fresh user data, beating live pricing", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-copilot-models-json-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const modelsJsonPath = join(tmp, "models.json");
  writeFileSync(
    modelsJsonPath,
    JSON.stringify({
      providers: {
        "github-copilot": {
          modelOverrides: {
            "gpt-5.4": { cost: { input: 111, output: 222 } },
          },
        },
      },
    }),
  );

  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
    modelsJsonPath,
  });

  await handleCopilotModels("sync", ctx, {
    fetchImpl: jsonResponse([
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        tool_call: true,
        cost: { input_cost_per_token: 0.000006, output_cost_per_token: 0.00003 },
      },
    ]) as unknown as typeof fetch,
  });

  await handleCopilotModels("why gpt-5.4", ctx, {});

  assert.match(notifications[1].message, /^- economics: \$0\.1110 per 1K input \/ \$0\.2220 per 1K output$/m, "the models.json override must win over the accepted live snapshot's pricing");
  assert.match(notifications[1].message, /^- source: user$/m);
  assert.match(notifications[1].message, /^- freshness: fresh$/m);
});

test("handleCopilotModels: why succeeds even when getApiKey() throws", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: undefined,
  });
  ctx.modelRegistry.getApiKey = async () => { throw new Error("token resolution boom"); };

  await assert.doesNotReject(handleCopilotModels("why gpt-5.4", ctx, {}));
  assert.match(notifications[0].message, /^GitHub Copilot: why github-copilot\/gpt-5\.4$/m);
});

test("handleCopilotModels: why finds the session state a prior sync recorded even when auth is resolved outside authStorage (e.g. an env var)", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-from-env",
    credentialOutsideAuthStorage: true,
  });

  await handleCopilotModels("sync", ctx, {
    fetchImpl: jsonResponse([
      { id: "gpt-5.4", name: "GPT-5.4", tool_call: true },
    ]) as unknown as typeof fetch,
  });
  assert.match(notifications[0].message, /1 model\(s\) available/);

  await handleCopilotModels("why gpt-5.4", ctx, {});
  assert.match(notifications[1].message, /^- last known live catalog: yes$/m, "why must find the snapshot sync just recorded, not report it as unknown");
});

test("handleCopilotModels: why finds the session state a prior sync recorded even when the resolved credential rotates on every call", async () => {
  // A models.json command-backed apiKey can legitimately emit a different
  // short-lived token on every getApiKey() call. The account-key fingerprint
  // must be derived from the credential's stable source (env var name /
  // models.json marker), never the resolved value itself, or state recorded
  // under one fingerprint becomes unreachable under the next.
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-rotates",
    credentialOutsideAuthStorage: true,
  });
  let callCount = 0;
  ctx.modelRegistry.getApiKey = async () => `rotating-token-${callCount++}`;

  await handleCopilotModels("sync", ctx, {
    fetchImpl: jsonResponse([
      { id: "gpt-5.4", name: "GPT-5.4", tool_call: true },
    ]) as unknown as typeof fetch,
  });
  assert.match(notifications[0].message, /1 model\(s\) available/);

  await handleCopilotModels("why gpt-5.4", ctx, {});
  assert.match(
    notifications[1].message,
    /^- last known live catalog: yes$/m,
    "a rotating resolved token must not fragment the account fingerprint across calls",
  );
});

test("handleCopilotModels: two different projects with unstored credentials from the same source get distinct account keys, not shared session state", async () => {
  // Module-level session/notification state is keyed by account fingerprint
  // and shared by every session in the process. Two different projects that
  // both resolve GitHub Copilot auth as an unstored "environment" credential
  // must not collapse onto the same fingerprint just because they share that
  // coarse source label — modelsJsonPath (stable per project) must also
  // factor into the key, or project B's `why` would wrongly report project
  // A's cached snapshot as its own.
  _resetCopilotModelsSessionStateForTests();
  const { ctx: ctxProjectA } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-from-env",
    credentialOutsideAuthStorage: true,
    modelsJsonPath: "/projects/project-a/models.json",
  });
  const { ctx: ctxProjectB, notifications: notificationsB } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-from-env",
    credentialOutsideAuthStorage: true,
    modelsJsonPath: "/projects/project-b/models.json",
  });

  await handleCopilotModels("sync", ctxProjectA, {
    fetchImpl: jsonResponse([{ id: "gpt-5.4", name: "GPT-5.4", tool_call: true }]) as unknown as typeof fetch,
  });

  await handleCopilotModels("why gpt-5.4", ctxProjectB, {});
  assert.match(
    notificationsB[0].message,
    /^- last known live catalog: unknown$/m,
    "a different project's unstored credential must not inherit another project's cached session state",
  );
});

test("handleCopilotModels: why succeeds even when fetchImpl throws", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await assert.doesNotReject(handleCopilotModels("why gpt-5.4", ctx, {
    fetchImpl: (async () => { throw new Error("network boom"); }) as unknown as typeof fetch,
  }));
  assert.match(notifications[0].message, /^GitHub Copilot: why github-copilot\/gpt-5\.4$/m);
});

test("handleCopilotModels: why never writes to the models-catalog.json overlay", async (t) => {
  _resetCopilotModelsSessionStateForTests();
  const tmp = mkdtempSync(join(tmpdir(), "gsd-copilot-why-overlay-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const overlayPath = join(tmp, "models-catalog.json");

  const { ctx } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("why gpt-5.4", ctx, { overlayPath });

  assert.equal(readModelsCatalogOverlay(overlayPath), null, "why must never write the overlay");
});

test("handleCopilotModels: why output never includes a token or API key", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("why gpt-5.4", ctx, {});

  assert.doesNotMatch(notifications[0].message, /token-abc/);
});

test("handleCopilotModels: sync still works unaffected by the stricter why parser", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([{ id: "gpt-5.4", name: "GPT-5.4", tool_call: true }]) as unknown as typeof fetch,
  });

  assert.equal(notifications[0].level, "info");
  assert.match(notifications[0].message, /1 model\(s\) available/);
});

test("handleCopilotModels: --register quarantine still works unaffected by the stricter why parser", async (t) => {
  _resetCopilotModelsSessionStateForTests();
  const tmp = mkdtempSync(join(tmpdir(), "gsd-copilot-register-still-works-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const overlayPath = join(tmp, "models-catalog.json");

  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("--register", ctx, {
    fetchImpl: jsonResponse([{ id: "gpt-5.4", name: "GPT-5.4", tool_call: true }]) as unknown as typeof fetch,
    overlayPath,
  });
  await handleCopilotModels("--register", ctx, {
    fetchImpl: jsonResponse([
      { id: "gpt-5.4", name: "GPT-5.4", tool_call: true },
      { id: "another-remote-model", name: "Another Remote Model", tool_call: true },
    ]) as unknown as typeof fetch,
    overlayPath,
  });

  assert.equal(readModelsCatalogOverlay(overlayPath), null);
  assert.match(notifications[1].message, /quarantined|remote-only|not persisted/i);
});

test("handleCopilotModels: newly added model with a known GSD capability tier is annotated", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([{ id: "gpt-5.4", name: "GPT-5.4", tool_call: true }]) as unknown as typeof fetch,
  });

  // claude-sonnet-5 has a real, existing "standard" entry in MODEL_CAPABILITY_TIER.
  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([
      { id: "gpt-5.4", name: "GPT-5.4", tool_call: true },
      { id: "claude-sonnet-5", name: "Claude Sonnet 5", tool_call: true },
    ]) as unknown as typeof fetch,
  });

  assert.match(notifications[1].message, /\+ github-copilot\/claude-sonnet-5 added.*\(known capability tier: standard\)/);
});

test("handleCopilotModels: newly added model without a GSD capability profile is flagged as manual-only", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([{ id: "gpt-5.4", name: "GPT-5.4", tool_call: true }]) as unknown as typeof fetch,
  });

  // "brand-new-unreleased-model" has no entry in MODEL_CAPABILITY_TIER.
  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([
      { id: "gpt-5.4", name: "GPT-5.4", tool_call: true },
      { id: "brand-new-unreleased-model", name: "Brand New Unreleased Model", tool_call: true },
    ]) as unknown as typeof fetch,
  });

  assert.match(
    notifications[1].message,
    /\+ github-copilot\/brand-new-unreleased-model added.*\(no GSD capability profile yet — manual selection only, not auto-routed\)/,
  );
});

test("handleCopilotModels: without --register, newly added models are never written to the overlay", async (t) => {
  _resetCopilotModelsSessionStateForTests();
  const tmp = mkdtempSync(join(tmpdir(), "gsd-copilot-models-handler-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const overlayPath = join(tmp, "models-catalog.json");

  const { ctx } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([{ id: "gpt-5.4", name: "GPT-5.4", tool_call: true }]) as unknown as typeof fetch,
    overlayPath,
  });
  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([
      { id: "gpt-5.4", name: "GPT-5.4", tool_call: true },
      { id: "brand-new-model", name: "Brand New Model", tool_call: true },
    ]) as unknown as typeof fetch,
    overlayPath,
  });

  assert.equal(readModelsCatalogOverlay(overlayPath), null, "no --register flag means no overlay file is ever written");
});

test("handleCopilotModels: --register quarantines remote-only models instead of persisting placeholders", async (t) => {
  _resetCopilotModelsSessionStateForTests();
  const tmp = mkdtempSync(join(tmpdir(), "gsd-copilot-models-handler-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const overlayPath = join(tmp, "models-catalog.json");

  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("--register", ctx, {
    fetchImpl: jsonResponse([{ id: "gpt-5.4", name: "GPT-5.4", tool_call: true }]) as unknown as typeof fetch,
    overlayPath,
  });
  await handleCopilotModels("--register", ctx, {
    fetchImpl: jsonResponse([
      { id: "gpt-5.4", name: "GPT-5.4", tool_call: true },
      { id: "brand-new-model", name: "Brand New Model", tool_call: true },
    ]) as unknown as typeof fetch,
    overlayPath,
  });

  const onDisk = readModelsCatalogOverlay(overlayPath);
  assert.equal(onDisk, null, "remote-only models are quarantined instead of persisting placeholder metadata");
  assert.match(notifications[1].message, /brand-new-model.*quarantined|remote-only.*quarantined|not persisted/i);
});

test("handleCopilotModels: --register on a no-diff run makes no overlay writes", async (t) => {
  _resetCopilotModelsSessionStateForTests();
  const tmp = mkdtempSync(join(tmpdir(), "gsd-copilot-models-handler-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const overlayPath = join(tmp, "models-catalog.json");

  const { ctx } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  // First call establishes the cached snapshot (no diff computed yet).
  await handleCopilotModels("--register", ctx, {
    fetchImpl: jsonResponse([{ id: "gpt-5.4", name: "GPT-5.4", tool_call: true }]) as unknown as typeof fetch,
    overlayPath,
  });
  assert.equal(readModelsCatalogOverlay(overlayPath), null, "first-run report has no diff.added, so nothing to register yet");
});

test("handleCopilotModels: --register keeps remote-only models quarantined and never persists placeholders", async (t) => {
  _resetCopilotModelsSessionStateForTests();
  const tmp = mkdtempSync(join(tmpdir(), "gsd-copilot-register-quarantine-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const overlayPath = join(tmp, "models-catalog.json");

  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("--register", ctx, {
    fetchImpl: jsonResponse([{ id: "gpt-5.4", name: "GPT-5.4", tool_call: true }]) as unknown as typeof fetch,
    overlayPath,
  });

  await handleCopilotModels("--register", ctx, {
    fetchImpl: jsonResponse([
      { id: "gpt-5.4", name: "GPT-5.4", tool_call: true },
      { id: "brand-new-model", name: "Brand New Model", tool_call: true },
    ]) as unknown as typeof fetch,
    overlayPath,
  });

  assert.equal(readModelsCatalogOverlay(overlayPath), null, "no placeholder metadata may be persisted for remote-only models");
  assert.match(notifications[1].message, /brand-new-model.*quarantined|remote-only.*quarantined|not persisted/i);
});

test("handleCopilotModels: changes reports the last accepted diff without another network request", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([{ id: "gpt-5.4", name: "GPT-5.4", tool_call: true }]) as unknown as typeof fetch,
  });
  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([
      { id: "gpt-5.4", name: "GPT-5.4", tool_call: true },
      { id: "mai-code-1.1-flash", name: "MAI Code 1.1 Flash", tool_call: true },
    ]) as unknown as typeof fetch,
  });

  await handleCopilotModels("changes", ctx, {});

  assert.match(notifications[2].message, /GitHub Copilot model catalog changes:/);
  assert.match(notifications[2].message, /github-copilot\/mai-code-1\.1-flash/);
});

test("handleCopilotModels: pricing rejects non-GitHub-Copilot provider-qualified model IDs before touching auth", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  let apiKeyCalled = false;
  ctx.modelRegistry.getApiKey = async () => { apiKeyCalled = true; return "token-abc"; };

  await handleCopilotModels("pricing anthropic/claude-sonnet-5", ctx, {});

  assert.equal(apiKeyCalled, false, "wrong-provider pricing requests must be rejected before resolving auth");
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /github copilot.*anthropic|only accepts github-copilot|wrong provider/i);
});

test("handleCopilotModels: pricing explains provider-aware economics locally", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "mai-code-1.1-flash", provider: "github-copilot" }],
    apiKey: undefined,
  });

  await handleCopilotModels("pricing mai-code-1.1-flash", ctx, {});

  assert.match(notifications[0].message, /^GitHub Copilot pricing: github-copilot\/mai-code-1\.1-flash$/m);
  assert.match(notifications[0].message, /^- source: provider-static$/m);
  assert.match(notifications[0].message, /^- freshness: stale$/m);
});

test("handleCopilotModels: pricing suggests a cheaper same-tier Copilot model when one is available", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [
      { id: "claude-sonnet-4-5", provider: "github-copilot", cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 } },
      { id: "claude-sonnet-4", provider: "github-copilot", cost: { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 } },
    ],
    apiKey: undefined,
  });

  await handleCopilotModels("pricing claude-sonnet-4-5", ctx, {});

  assert.match(notifications[0].message, /^- cheaper same-tier option: github-copilot\/claude-sonnet-4 /m);
  assert.match(notifications[0].message, /saves \$0\.0010 input \/ \$0\.0070 output per 1K/i);
});

test("handleCopilotModels: pricing reports long-context tiers and request multipliers when live data supplies them", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "special-priced-model", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([
      {
        id: "special-priced-model",
        name: "Special Priced Model",
        tool_call: true,
        supported_endpoints: ["/responses"],
        reasoning: true,
        limit: { context: 400000, output: 128000 },
        pricing: {
          input: 0.2,
          output: 1.2,
          cache_read: 0.02,
          cache_write: 0.01,
          tiers: [{ input_tokens_above: 200000, input: 0.4, output: 2.4, cache_read: 0.03, cache_write: 0.02 }],
        },
        request_multiplier: 0.25,
      },
    ]) as unknown as typeof fetch,
  });

  await handleCopilotModels("pricing special-priced-model", ctx, {});

  assert.match(notifications[1].message, /^- source: provider-live$/m);
  assert.match(notifications[1].message, /^- freshness: fresh$/m);
  assert.match(notifications[1].message, /request multiplier: 0\.25x/);
  assert.match(notifications[1].message, /long-context tiers: >200000:/);
});

test("handleCopilotModels: promos separates active, future, and expired promotions", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        tool_call: true,
        promotion: { discountPercent: 20, endsAt: "2999-12-31T00:00:00Z", message: "Active promo" },
      },
      {
        id: "gpt-5.5",
        name: "GPT-5.5",
        tool_call: true,
        promotion: { discountPercent: 10, startsAt: "2999-01-01T00:00:00Z", message: "Future promo" },
      },
      {
        id: "mai-code-1.1-flash",
        name: "MAI Code 1.1 Flash",
        tool_call: true,
        promotion: { discountPercent: 5, endsAt: "2000-01-01T00:00:00Z", message: "Expired promo" },
      },
    ]) as unknown as typeof fetch,
  });

  await handleCopilotModels("promos", ctx, {});

  assert.match(notifications[1].message, /- active: 1/);
  assert.match(notifications[1].message, /- future: 1/);
  assert.match(notifications[1].message, /- expired: 1/);
});

test("handleCopilotModels: changes is isolated per authenticated account fingerprint", async () => {
  _resetCopilotModelsSessionStateForTests();
  const first = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-account-a",
  });
  const second = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-account-b",
  });

  await handleCopilotModels("", first.ctx, {
    fetchImpl: jsonResponse([{ id: "gpt-5.4", name: "GPT-5.4", tool_call: true }]) as unknown as typeof fetch,
  });
  await handleCopilotModels("", second.ctx, {
    fetchImpl: jsonResponse([{ id: "claude-sonnet-5", name: "Claude Sonnet 5", tool_call: true }]) as unknown as typeof fetch,
  });

  await handleCopilotModels("changes", first.ctx, {});
  await handleCopilotModels("changes", second.ctx, {});

  assert.match(first.notifications[1].message, /github-copilot\/gpt-5\.4/);
  assert.doesNotMatch(first.notifications[1].message, /claude-sonnet-5/);
  assert.match(second.notifications[1].message, /github-copilot\/claude-sonnet-5/);
});

test("handleCopilotModels: why reports preview and policy blockers as non-routable", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "preview-model", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([
      {
        id: "preview-model",
        name: "Preview Model",
        tool_call: true,
        preview: true,
        model_picker_enabled: false,
        policy_state: "restricted",
        supported_endpoints: ["/responses"],
        reasoning: true,
        limit: { context: 400000, output: 128000 },
        cost: { input: 0.2, output: 1.2, cache_read: 0, cache_write: 0 },
      },
    ]) as unknown as typeof fetch,
  });

  await handleCopilotModels("why preview-model", ctx, {});

  assert.match(notifications[1].message, /^- policy state: restricted$/m);
  assert.match(notifications[1].message, /^- preview: yes$/m);
  assert.match(notifications[1].message, /^- automatic routing eligible: no$/m);
  assert.match(
    notifications[1].message,
    /^- routing caveats: .*provider policy is restricted.*preview models are intended to stay manual-only.*$/m,
  );
});

test("handleCopilotModels: why reports a known-profile preview/policy-restricted model as routing-eligible with caveats, not a false ineligible verdict", async () => {
  // resolveModelForComplexity() never receives live availability metadata and
  // only gates automatic selection on capability-profile confidence, so a
  // curated model that happens to be preview/policy-restricted CAN still be
  // auto-selected by the real router — reporting "eligible: no" here would
  // be a false routing result. See STEP 2/3's confidence-only gating.
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "claude-sonnet-4-6", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("", ctx, {
    fetchImpl: jsonResponse([
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        tool_call: true,
        preview: true,
        policy_state: "restricted",
        supported_endpoints: ["/responses"],
        reasoning: true,
        limit: { context: 400000, output: 128000 },
        cost: { input: 3, output: 15, cache_read: 0, cache_write: 0 },
      },
    ]) as unknown as typeof fetch,
  });

  await handleCopilotModels("why claude-sonnet-4-6", ctx, {});

  assert.match(notifications[1].message, /^- policy state: restricted$/m);
  assert.match(notifications[1].message, /^- preview: yes$/m);
  assert.match(
    notifications[1].message,
    /^- automatic routing eligible: yes$/m,
    "a curated-profile model must not be reported ineligible just because of policy/preview state the router never checks",
  );
  assert.match(
    notifications[1].message,
    /^- routing caveats: .*provider policy is restricted.*preview models are intended to stay manual-only.*$/m,
  );
});

test("handleCopilotModels: why highlights a cheaper same-tier model when one is session-available", async () => {
  _resetCopilotModelsSessionStateForTests();
  const { ctx, notifications } = createFakeCtx({
    models: [
      { id: "claude-sonnet-4-5", provider: "github-copilot", cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 } },
      { id: "claude-sonnet-4", provider: "github-copilot", cost: { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 } },
    ],
    apiKey: undefined,
  });

  await handleCopilotModels("why claude-sonnet-4-5", ctx, {});

  assert.match(notifications[0].message, /^- cheaper same-tier option: github-copilot\/claude-sonnet-4 /m);
  assert.match(notifications[0].message, /saves \$0\.0010 input \/ \$0\.0070 output per 1K/i);
});

test("handleCopilotModels: doctor reports cache and quarantine state without a network request", async () => {
  _resetCopilotModelsSessionStateForTests();
  const tmp = mkdtempSync(join(tmpdir(), "gsd-copilot-doctor-"));
  const overlayPath = join(tmp, "models-catalog.json");
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("--register", ctx, {
    fetchImpl: jsonResponse([
      { id: "gpt-5.4", name: "GPT-5.4", tool_call: true },
      { id: "brand-new-model", name: "Brand New Model", tool_call: true },
    ]) as unknown as typeof fetch,
    overlayPath,
  });
  await handleCopilotModels("doctor", ctx, {});

  assert.match(notifications[1].message, /GitHub Copilot doctor:/);
  assert.match(notifications[1].message, /quarantined registration candidates: 1/);
  assert.match(notifications[1].message, /account isolation:/);
});

test("handleCopilotModels: --register on a first run writes complete remote-only candidates", async (t) => {
  _resetCopilotModelsSessionStateForTests();
  const tmp = mkdtempSync(join(tmpdir(), "gsd-copilot-register-complete-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const overlayPath = join(tmp, "models-catalog.json");
  const { ctx, notifications } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("sync --register", ctx, {
    fetchImpl: jsonResponse([
      { id: "gpt-5.4", name: "GPT-5.4", tool_call: true },
      {
        id: "brand-new-complete",
        name: "Brand New Complete",
        tool_call: true,
        supported_endpoints: ["/responses"],
        vision: false,
        reasoning: true,
        limit: { context: 400000, output: 128000 },
        cost: { input: 0.2, output: 1.2, cache_read: 0, cache_write: 0 },
      },
    ]) as unknown as typeof fetch,
    overlayPath,
  });

  const onDisk = readModelsCatalogOverlay(overlayPath);
  assert.ok(onDisk?.models["github-copilot"]?.["brand-new-complete"]);
  assert.match(notifications[0].message, /= github-copilot\/brand-new-complete registered into/);
});

test("handleCopilotModels: --register calls modelRegistry.refresh() so newly-registered models are immediately selectable in /gsd model", async (t) => {
  _resetCopilotModelsSessionStateForTests();
  const tmp = mkdtempSync(join(tmpdir(), "gsd-copilot-register-refresh-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const overlayPath = join(tmp, "models-catalog.json");
  const { ctx, refreshCallCount } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  await handleCopilotModels("sync --register", ctx, {
    fetchImpl: jsonResponse([
      { id: "gpt-5.4", name: "GPT-5.4", tool_call: true },
      {
        id: "brand-new-complete",
        name: "Brand New Complete",
        tool_call: true,
        supported_endpoints: ["/responses"],
        vision: false,
        reasoning: true,
        limit: { context: 400000, output: 128000 },
        cost: { input: 0.2, output: 1.2, cache_read: 0, cache_write: 0 },
      },
    ]) as unknown as typeof fetch,
    overlayPath,
  });

  assert.equal(
    refreshCallCount(),
    1,
    "ctx.modelRegistry.refresh() must run after a successful registration, or the newly-registered model stays unavailable to /gsd model for the rest of the session",
  );
});

test("handleCopilotModels: --register does not call modelRegistry.refresh() when nothing new was registered", async (t) => {
  _resetCopilotModelsSessionStateForTests();
  const tmp = mkdtempSync(join(tmpdir(), "gsd-copilot-register-no-refresh-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const overlayPath = join(tmp, "models-catalog.json");
  const { ctx, refreshCallCount } = createFakeCtx({
    models: [{ id: "gpt-5.4", provider: "github-copilot" }],
    apiKey: "token-abc",
  });

  // Already-local model only -- registerCopilotModelsInOverlay has nothing
  // remote-only to add, so registeredIds stays empty.
  await handleCopilotModels("sync --register", ctx, {
    fetchImpl: jsonResponse([{ id: "gpt-5.4", name: "GPT-5.4", tool_call: true }]) as unknown as typeof fetch,
    overlayPath,
  });

  assert.equal(refreshCallCount(), 0, "refresh() is an avoidable no-op reload when there is nothing new to pick up");
});

test("getGsdArgumentCompletions: /gsd copilot-models completions include the expanded subcommand surface", () => {
  const completions = getGsdArgumentCompletions("copilot-models ");
  const labels = completions.map((entry) => entry.label);
  assert.ok(labels.includes("sync"));
  assert.ok(labels.includes("changes"));
  assert.ok(labels.includes("pricing"));
  assert.ok(labels.includes("promos"));
  assert.ok(labels.includes("doctor"));
  assert.ok(labels.includes("why"));
  assert.ok(labels.includes("--register"));
  assert.ok(completions.every((entry) => !/[\[<]model[\]>]/i.test(entry.value)));
});

test("showHelp: full help lists the expanded copilot-models subcommands", () => {
  const lines: string[] = [];
  const mockCtx = {
    ui: {
      notify(message: string) {
        lines.push(...message.split("\n"));
      },
      custom: async () => {},
    },
  };

  showHelp(mockCtx as unknown as ExtensionCommandContext, "full");

  assert.ok(lines.some((line) => line.includes("/gsd copilot-models sync")));
  assert.ok(lines.some((line) => line.includes("/gsd copilot-models changes")));
  assert.ok(lines.some((line) => line.includes("/gsd copilot-models pricing")));
  assert.ok(lines.every((line) => !/pricing \[model\]/i.test(line)));
  assert.ok(lines.some((line) => line.includes("/gsd copilot-models promos")));
  assert.ok(lines.some((line) => line.includes("/gsd copilot-models doctor")));
});
