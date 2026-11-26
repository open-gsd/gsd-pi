// Project/App: gsd-pi
// File Purpose: Behavioral proof for the claim made by
// describeCapabilityTier() in commands/handlers/copilot-models.ts — that a
// GitHub Copilot model with no MODEL_CAPABILITY_TIER entry is "manual
// selection only, not auto-routed" rather than unusable.
//
// This does NOT exercise the read-only /gsd copilot-models notification
// pipeline (see copilot-models-handler.test.ts for that). It exercises the
// real, independent, pre-existing production mechanism a user actually has
// for making such a model selectable: adding it to their own models.json
// (documented in @gsd/pi-coding-agent's ModelRegistry custom-model merge
// behavior). If this ever stopped working, the "manual selection only"
// wording in the notification would become an unproven/false claim.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthStorage, ModelRegistry } from "@gsd/pi-coding-agent";

import { MODEL_CAPABILITY_TIER } from "../model-router.js";

test("a github-copilot model absent from MODEL_CAPABILITY_TIER is still genuinely selectable via models.json", async (t) => {
  // Any id that is guaranteed not to already be a GSD capability-tier entry
  // or a real Copilot catalog id.
  const unprofiledModelId = "copilot-hypothetical-preview-not-in-tier-table";
  assert.equal(
    MODEL_CAPABILITY_TIER[unprofiledModelId],
    undefined,
    "precondition: this fixture id must have no GSD capability profile",
  );

  const tempDir = mkdtempSync(join(tmpdir(), "gsd-copilot-manual-selection-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));

  const modelsJsonPath = join(tempDir, "models.json");
  // This is exactly the mechanism a user has available today: hand-editing
  // models.json to add a model id to an existing built-in provider. It
  // inherits api/baseUrl/headers from the provider's other (bundled) models,
  // the same way @gsd/pi-coding-agent's own model-registry test suite proves
  // for other built-in providers (see
  // packages/pi-coding-agent/test/model-registry.test.ts, "custom models
  // merge behavior").
  writeFileSync(
    modelsJsonPath,
    JSON.stringify({
      providers: {
        "github-copilot": {
          models: [
            {
              id: unprofiledModelId,
              name: "Copilot Hypothetical Preview",
              reasoning: false,
              input: ["text"],
            },
          ],
        },
      },
    }),
  );

  const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
  const registry = await ModelRegistry.create(authStorage, modelsJsonPath);

  assert.equal(registry.getError(), undefined, "manually adding the model must not produce a config error");

  const manuallyAdded = registry.find("github-copilot", unprofiledModelId);
  assert.ok(
    manuallyAdded,
    "a model with no capability tier must still be resolvable through the real ModelRegistry once a user adds it to models.json",
  );
  assert.equal(manuallyAdded?.provider, "github-copilot");

  // It inherits transport details from the bundled github-copilot models,
  // proving it is wired as a first-class model rather than a special case —
  // it is genuinely usable, just never auto-routed by capability tier.
  const bundledCopilotModels = registry.getAll().filter((m) => m.provider === "github-copilot" && m.id !== unprofiledModelId);
  assert.ok(bundledCopilotModels.length > 0, "expected bundled github-copilot models to exist for comparison");
  assert.equal(manuallyAdded?.baseUrl, bundledCopilotModels[0]?.baseUrl);

  // Re-confirm the capability-tier absence after registration, closing the
  // loop the notification message describes: selectable, but not tiered.
  assert.equal(MODEL_CAPABILITY_TIER[unprofiledModelId], undefined);
});
