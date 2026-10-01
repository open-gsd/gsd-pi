/**
 * Dynamic routing default — verifies routing is enabled by default, and pins
 * the routing defaults contract (#2397 stage 1): the router default for
 * `capability_routing` is ON (runtime gate: enabled unless explicitly false),
 * and token-profile synthesis never asserts its own capability_routing value.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { defaultRoutingConfig, resolveModelForComplexity } from "../model-router.js";
import type { DynamicRoutingConfig } from "../model-router.js";
import { resolveProfileDefaults } from "../preferences-models.ts";
import { handlePrefsWizard } from "../commands-prefs-wizard.ts";

test("defaultRoutingConfig returns enabled: true", () => {
  const config = defaultRoutingConfig();
  assert.equal(config.enabled, true, "dynamic routing should be enabled by default");
});

test("defaultRoutingConfig enables all routing features", () => {
  const config = defaultRoutingConfig();
  assert.equal(config.escalate_on_failure, true);
  assert.equal(config.budget_pressure, true);
  assert.equal(config.cross_provider, true);
  assert.equal(config.hooks, true);
});

test("defaultRoutingConfig enables capability_routing (#2397)", () => {
  const config = defaultRoutingConfig();
  assert.equal(
    config.capability_routing,
    true,
    "capability_routing must default to true — the runtime gate routes unless it is explicitly false",
  );
});

test("runtime gate treats an absent capability_routing value as enabled (#2397)", () => {
  // A user block that omits the key (as resolveDynamicRoutingConfig merges it)
  // must hit the gate's omission semantics — capability scoring stays ON even
  // though no explicit true is present.
  const userBlock = { enabled: true } as DynamicRoutingConfig;
  assert.equal("capability_routing" in userBlock, false);

  const result = resolveModelForComplexity(
    { tier: "standard", reason: "test", downgraded: false },
    { primary: "claude-opus-4-6", fallbacks: [] },
    userBlock,
    ["claude-opus-4-6", "claude-sonnet-4-6", "gpt-4o", "gemini-2.5-pro", "claude-haiku-4-5", "gpt-4o-mini"],
    "execute-task",
    { tags: [], complexityKeywords: [], fileCount: 3, estimatedLines: 100, codeBlockCount: 0 },
  );
  assert.equal(result.selectionMethod, "capability-scored", "absent capability_routing must keep capability scoring ON");
});

test("token-profile synthesis never asserts its own capability_routing default (#2397)", () => {
  // The router's defaultRoutingConfig() is the single source of truth for
  // capability_routing. Token profiles express cost/quality strategy and phase
  // skip defaults; burn-max additionally disables routing entirely (preserving
  // explicit model selection) — but none of them may write a capability_routing
  // property that competes with the router default.
  for (const profile of ["budget", "balanced", "quality", "burn-max"] as const) {
    const defaults = resolveProfileDefaults(profile);
    const dr = defaults.dynamic_routing as Record<string, unknown> | undefined;
    assert.equal(
      dr === undefined || !("capability_routing" in dr),
      true,
      `${profile} profile must not synthesize a capability_routing property`,
    );
  }
  // burn-max's routing touch is enabled: false only.
  assert.deepEqual(resolveProfileDefaults("burn-max").dynamic_routing, { enabled: false });
});

test("preferences wizard shows the runtime default (true) for Capability-aware routing (#2397)", async (t) => {
  // Pre-fix, the wizard hint advertised "(default: false)" — inviting users to
  // persist an explicit false that switches OFF what the runtime default
  // enables. Drive the Models category (which owns the routing prompts) with
  // every prompt kept as-is, and assert the Capability-aware routing hint
  // advertises the runtime default.
  const dir = mkdtempSync(join(tmpdir(), "gsd-routing-default-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const capabilityLabels: string[] = [];
  let topMenuVisits = 0;

  const ctx = {
    modelRegistry: {
      getAvailable: () => [{ provider: "test-provider", id: "test-model" }],
    },
    ui: {
      notify() {},
      select: async (label: string, options: string[]) => {
        if (label === "GSD Preferences") {
          topMenuVisits += 1;
          if (topMenuVisits === 1) {
            const models = options.find((o) => o.startsWith("Models"));
            assert.ok(models, "wizard menu must offer a Models category");
            return models;
          }
          return "── Save & Exit ──";
        }
        if (label.startsWith("Capability-aware routing")) capabilityLabels.push(label);
        if (options.includes("(keep current)")) return "(keep current)";
        if (options.includes("Done")) return "Done";
        return options[options.length - 1];
      },
      input: async () => null,
    },
    waitForIdle: async () => {},
    reload: async () => {},
  } as any;

  // Prefill an empty dynamic_routing block so any dynamic_routing values on
  // disk in the surrounding checkout cannot turn the prompt into a
  // "(current: …)" hint and make this test environment-dependent.
  await handlePrefsWizard(ctx, "project", { dynamic_routing: {} }, { pathOverride: join(dir, "PREFERENCES.md") });

  assert.equal(capabilityLabels.length, 1, `Capability-aware routing must be prompted exactly once; all prompts:\n${capabilityLabels.join("\n")}`);
  assert.match(
    capabilityLabels[0],
    /\(default: true\)/,
    `Capability-aware routing hint must advertise the runtime default (true); got: ${capabilityLabels[0]}`,
  );

  // Keeping current on an unset value persists nothing — no capability_routing
  // property at all may appear in the saved file (the router default governs).
  const saved = readFileSync(join(dir, "PREFERENCES.md"), "utf-8");
  assert.doesNotMatch(saved, /capability_routing/);
});
