import assert from "node:assert/strict";
import test from "node:test";

import {
  BUNDLED_COST_TABLE,
  compareModelCost,
  lookupModelCost,
  resolveModelEconomics,
} from "../model-cost-table.js";

// ─── lookupModelCost ─────────────────────────────────────────────────────────

test("lookupModelCost finds exact match", () => {
  const entry = lookupModelCost("claude-opus-4-6");
  assert.ok(entry);
  assert.equal(entry.id, "claude-opus-4-6");
  assert.ok(entry.inputPer1k > 0);
  assert.ok(entry.outputPer1k > 0);
});

test("lookupModelCost strips provider prefix", () => {
  const entry = lookupModelCost("anthropic/claude-opus-4-6");
  assert.ok(entry);
  assert.equal(entry.id, "claude-opus-4-6");
});

test("lookupModelCost returns undefined for unknown model", () => {
  const entry = lookupModelCost("totally-unknown-model");
  assert.equal(entry, undefined);
});

test("lookupModelCost finds haiku", () => {
  const entry = lookupModelCost("claude-haiku-4-5");
  assert.ok(entry);
  assert.ok(entry.inputPer1k < 0.001, "haiku should be cheap");
});

test("lookupModelCost finds Claude Sonnet 5 pricing", () => {
  const entry = lookupModelCost("github-copilot/claude-sonnet-5");
  assert.ok(entry);
  assert.equal(entry.inputPer1k, 0.003);
  assert.equal(entry.outputPer1k, 0.015);
});

test("lookupModelCost finds MAI Code 1.1 Flash pricing", () => {
  const entry = lookupModelCost("github-copilot/mai-code-1.1-flash");
  assert.ok(entry);
  assert.equal(entry.inputPer1k, 0.0002);
  assert.equal(entry.outputPer1k, 0.0012);
});
test("lookupModelCost finds GPT-6 Astra pricing", () => {
  const entry = lookupModelCost("github-copilot/gpt-6-astra");
  assert.ok(entry);
  assert.equal(entry.inputPer1k, 0.01);
  assert.equal(entry.outputPer1k, 0.05);
});

test("resolveModelEconomics keeps provider-qualified identities separate from same bare model IDs", () => {
  const openai = resolveModelEconomics({
    provider: "openai",
    modelId: "openai/gpt-5.5",
    liveEconomics: {
      provider: "openai",
      modelId: "gpt-5.5",
      billingUnit: "tokens",
      tokenPrices: {
        default: { inputPer1k: 0.006, outputPer1k: 0.035 },
      },
      stale: false,
    },
  });

  const copilot = resolveModelEconomics({
    provider: "github-copilot",
    modelId: "github-copilot/gpt-5.5",
    liveEconomics: {
      provider: "github-copilot",
      modelId: "gpt-5.5",
      billingUnit: "tokens",
      tokenPrices: {
        default: { inputPer1k: 0.0005, outputPer1k: 0.0025 },
      },
      stale: false,
    },
  });

  assert.equal(openai.modelId, "gpt-5.5");
  assert.equal(copilot.modelId, "gpt-5.5");
  assert.equal(openai.provider, "openai");
  assert.equal(copilot.provider, "github-copilot");
  assert.notEqual(openai.tokenPrices?.default.inputPer1k, copilot.tokenPrices?.default.inputPer1k);
  assert.equal(openai.source, "provider-live");
  assert.equal(copilot.source, "provider-live");
});

test("resolveModelEconomics treats unknown costs as unknown rather than zero", () => {
  const resolved = resolveModelEconomics({
    provider: "github-copilot",
    modelId: "github-copilot/brand-new-unreleased-model",
  });

  assert.equal(resolved.provider, "github-copilot");
  assert.equal(resolved.modelId, "brand-new-unreleased-model");
  assert.equal(resolved.source, "unknown");
  assert.equal(resolved.billingUnit, "unknown");
  assert.equal(resolved.tokenPrices, undefined);
});

test("resolveModelEconomics applies the implicit bundled-fallback by bare ID by default", () => {
  // "gpt-5.5" is bundled under the openai-codex entries; a github-copilot model
  // reusing the same bare ID with no live/static data of its own would silently
  // inherit that price unless the caller opts out via disableImplicitFallback.
  const resolved = resolveModelEconomics({
    provider: "github-copilot",
    modelId: "github-copilot/gpt-5.5",
  });

  assert.equal(resolved.source, "bundled-fallback");
  assert.equal(resolved.tokenPrices?.default.inputPer1k, 0.005);
});

test("resolveModelEconomics disableImplicitFallback reports unknown instead of a cross-provider bundled price", () => {
  const resolved = resolveModelEconomics({
    provider: "github-copilot",
    modelId: "github-copilot/gpt-5.5",
    disableImplicitFallback: true,
  });

  assert.equal(resolved.source, "unknown");
  assert.equal(resolved.tokenPrices, undefined);
});

test("resolveModelEconomics disableImplicitFallback still honors an explicit fallbackEconomics candidate", () => {
  const resolved = resolveModelEconomics({
    provider: "github-copilot",
    modelId: "gpt-5.5",
    disableImplicitFallback: true,
    fallbackEconomics: {
      source: "bundled-fallback",
      tokenPrices: { default: { inputPer1k: 0.0002, outputPer1k: 0.0012 } },
      stale: true,
    },
  });

  assert.equal(resolved.source, "bundled-fallback");
  assert.equal(resolved.tokenPrices?.default.inputPer1k, 0.0002);
});

test("resolveModelEconomics applies per-field precedence and reports mixed provenance", () => {
  const resolved = resolveModelEconomics({
    provider: "github-copilot",
    modelId: "gpt-5.6-sol",
    userOverride: {
      billingUnit: "tokens",
      tokenPrices: { default: { inputPer1k: 0.0004, outputPer1k: 0.002 } },
      stale: false,
    },
    liveEconomics: {
      requestMultiplier: 0.25,
      stale: false,
      fetchedAt: 123,
    },
  });

  assert.equal(resolved.source, "mixed");
  assert.equal(resolved.tokenPrices?.default.inputPer1k, 0.0004);
  assert.equal(resolved.provenance.defaultTokenPrices?.source, "user");
  assert.equal(resolved.requestMultiplier, 0.25);
  assert.equal(resolved.provenance.requestMultiplier?.source, "provider-live");
  assert.equal(resolved.provenance.longContextTiers?.source, "bundled-fallback");
  assert.ok((resolved.tokenPrices?.longContextTiers?.length ?? 0) > 0);
});

test("resolveModelEconomics keeps request billing separate from token pricing", () => {
  const resolved = resolveModelEconomics({
    provider: "github-copilot",
    modelId: "mai-code-1.1-flash",
    liveEconomics: {
      billingUnit: "request",
      requestMultiplier: 0.25,
      stale: false,
    },
  });

  assert.equal(resolved.billingUnit, "request");
  assert.equal(resolved.requestMultiplier, 0.25);
  assert.equal(resolved.provenance.requestMultiplier?.source, "provider-live");
});

test("resolveModelEconomics keeps promotion lifecycle metadata without mutating prices", () => {
  const resolved = resolveModelEconomics({
    provider: "github-copilot",
    modelId: "mai-code-1.1-flash",
    liveEconomics: {
      billingUnit: "tokens",
      tokenPrices: { default: { inputPer1k: 0.0002, outputPer1k: 0.0012 } },
      promotion: {
        discountPercent: 50,
        endsAt: "2000-01-01T00:00:00Z",
        message: "Expired promo",
      },
      stale: false,
    },
  });

  assert.equal(resolved.tokenPrices?.default.inputPer1k, 0.0002);
  assert.equal(resolved.promotion?.status, "expired");
  assert.equal(resolved.provenance.promotion?.source, "provider-live");
});

// ─── compareModelCost ────────────────────────────────────────────────────────

test("haiku is cheaper than opus", () => {
  assert.ok(compareModelCost("claude-haiku-4-5", "claude-opus-4-6") < 0);
});

test("opus is more expensive than sonnet", () => {
  assert.ok(compareModelCost("claude-opus-4-6", "claude-sonnet-4-6") > 0);
});

test("same model has equal cost", () => {
  assert.equal(compareModelCost("claude-opus-4-6", "claude-opus-4-6"), 0);
});

// ─── BUNDLED_COST_TABLE ──────────────────────────────────────────────────────

test("cost table has entries for all major providers", () => {
  const ids = BUNDLED_COST_TABLE.map(e => e.id);
  // Anthropic
  assert.ok(ids.includes("claude-opus-4-6"));
  assert.ok(ids.includes("claude-sonnet-4-6"));
  assert.ok(ids.includes("claude-haiku-4-5"));
  // OpenAI
  assert.ok(ids.includes("gpt-4o"));
  assert.ok(ids.includes("gpt-4o-mini"));
  // Google
  assert.ok(ids.includes("gemini-2.0-flash"));
});

test("all cost table entries have valid data", () => {
  for (const entry of BUNDLED_COST_TABLE) {
    assert.ok(entry.id, `entry missing id`);
    assert.ok(entry.inputPer1k >= 0, `${entry.id} inputPer1k should be >= 0`);
    assert.ok(entry.outputPer1k >= 0, `${entry.id} outputPer1k should be >= 0`);
    assert.ok(entry.updatedAt, `${entry.id} missing updatedAt`);
  }
});

// ─── #2885: openai-codex and modern OpenAI models in cost table ──────────────

test("#2885: cost table includes openai-codex provider models", () => {
  const ids = BUNDLED_COST_TABLE.map(e => e.id);
  const codexModels = [
    "gpt-5.1", "gpt-5.1-codex-max", "gpt-5.1-codex-mini",
    "gpt-5.2", "gpt-5.2-codex", "gpt-5.3-codex", "gpt-5.3-codex-spark", "gpt-5.4", "gpt-5.4-mini", "gpt-5.5",
    "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
  ];
  for (const model of codexModels) {
    assert.ok(ids.includes(model), `cost table should include openai-codex model "${model}"`);
  }
});

test("#2885: cost table includes modern OpenAI models", () => {
  const ids = BUNDLED_COST_TABLE.map(e => e.id);
  const newModels = [
    "o4-mini", "o4-mini-deep-research",
    "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano",
    "gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-5-pro",
  ];
  for (const model of newModels) {
    assert.ok(ids.includes(model), `cost table should include modern OpenAI model "${model}"`);
  }
});

test("#2885: lookupModelCost returns costs for new models (not 999 fallback)", () => {
  const newModels = ["o4-mini", "gpt-4.1", "gpt-5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.1-codex-mini"];
  for (const model of newModels) {
    const entry = lookupModelCost(model);
    assert.ok(entry, `lookupModelCost should find "${model}"`);
    assert.ok(entry.inputPer1k < 999, `${model} should have a real cost, not the 999 fallback`);
  }
});

test("gpt-5.5 uses official OpenAI list pricing", () => {
  const entry = lookupModelCost("gpt-5.5");
  assert.ok(entry, "lookupModelCost should find gpt-5.5");
  assert.equal(entry.inputPer1k, 0.005);
  assert.equal(entry.outputPer1k, 0.03);
  assert.equal(entry.updatedAt, "2026-04-23");
});

test("gpt-5.6 bare alias is not treated as a real cost-table model", () => {
  assert.equal(lookupModelCost("gpt-5.6"), undefined);
});

test("gpt-5.6 variants use published pricing", () => {
  const sol = lookupModelCost("openai-codex/gpt-5.6-sol");
  assert.ok(sol, "lookupModelCost should find gpt-5.6-sol");
  assert.equal(sol.inputPer1k, 0.005);
  assert.equal(sol.outputPer1k, 0.03);
  assert.deepEqual(sol.tiers?.[0], { inputTokensAbove: 272000, inputPer1k: 0.01, outputPer1k: 0.045 });

  const terra = lookupModelCost("gpt-5.6-terra");
  assert.ok(terra, "lookupModelCost should find gpt-5.6-terra");
  assert.equal(terra.inputPer1k, 0.0025);
  assert.equal(terra.outputPer1k, 0.015);

  const luna = lookupModelCost("gpt-5.6-luna");
  assert.ok(luna, "lookupModelCost should find gpt-5.6-luna");
  assert.equal(luna.inputPer1k, 0.001);
  assert.equal(luna.outputPer1k, 0.006);
});
