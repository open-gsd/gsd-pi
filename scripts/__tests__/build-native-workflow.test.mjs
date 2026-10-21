// Project/App: GSD-2
// File Purpose: Regression tests for native binary publish workflow resilience.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import YAML from "yaml";

const workflow = YAML.parse(
  readFileSync(".github/workflows/build-native.yml", "utf8"),
);
const publishJob = workflow.jobs.publish;

test("build-native publish uses GitHub-hosted runners for npm provenance", () => {
  assert.equal(publishJob["runs-on"], "ubuntu-latest");
});

test("build-native exposes platform_packages_only bootstrap input", () => {
  const input = workflow.on.workflow_dispatch.inputs.platform_packages_only;

  assert.equal(input.default, "false");
  assert.deepEqual(input.options, ["false", "true"]);
});

test("build-native publish uses resilient engine package script", () => {
  const step = publishJob.steps.find(
    (entry) => entry.name === "Publish platform packages",
  );

  assert.ok(step, "publish job must publish platform packages");
  assert.match(step.run, /publish-engine-packages\.sh/);
  assert.equal(step.env.TAG_FLAG, "${{ steps.version-check.outputs.tag_flag }}");
});

test("build-native can skip main package when bootstrapping engine packages", () => {
  const gatedSteps = [
    "Install dependencies",
    "Build",
    "Verify dist exists",
    "Validate package is installable",
    "Publish workspace packages",
    "Publish main package",
    "Post-publish smoke test",
    "Post-publish MCP server smoke test",
  ];

  for (const name of gatedSteps) {
    const step = publishJob.steps.find((entry) => entry.name === name);
    assert.ok(step, `expected publish job step ${name}`);
    assert.match(
      step.if,
      /platform_packages_only != 'true'/,
      `${name} must skip when platform_packages_only=true`,
    );
  }
});

test("build-native requires token auth when engine packages are missing from npm", () => {
  const step = publishJob.steps.find(
    (entry) => entry.name === "Require token auth for packages not on npm yet",
  );
  const tokenCheck = publishJob.steps.find(
    (entry) => entry.name === "Verify NPM_TOKEN is configured for token bootstrap",
  );

  assert.ok(step, "publish job must guard trusted auth when packages are new");
  assert.equal(step.if, "github.event.inputs.publish_auth != 'token'");
  assert.match(step.run, /npm-release-packages\.cjs --workspace-dirs/);
  assert.match(step.run, /do not exist on npm yet/);
  assert.match(step.run, /publish_auth=token/);

  assert.ok(tokenCheck, "publish job must verify NPM_TOKEN for token bootstrap");
  assert.equal(tokenCheck.if, "github.event.inputs.publish_auth == 'token'");
  assert.match(tokenCheck.run, /NPM_TOKEN/);
});

test("build-native publishes MCP server workspace to npm before the main package", () => {
  const steps = publishJob.steps;
  const workspacePublish = steps.find(
    (entry) => entry.name === "Publish workspace packages",
  );
  const mainPublishIndex = steps.findIndex(
    (entry) => entry.name === "Publish main package",
  );
  const workspacePublishIndex = steps.indexOf(workspacePublish);
  const smoke = steps.find(
    (entry) => entry.name === "Post-publish MCP server smoke test",
  );

  assert.ok(workspacePublish, "workflow must publish workspace packages");
  assert.ok(workspacePublishIndex > -1 && workspacePublishIndex < mainPublishIndex);
  // Publishing goes through the shared, derived-list script so this path can't
  // drift from the production release path (and can't re-introduce the hardcoded
  // list that omitted publishable workspace packages).
  assert.match(workspacePublish.run, /publish-workspace-packages\.sh/);
  assert.match(workspacePublish.run, /prepack-resolve-workspace\.cjs/);
  assert.match(workspacePublish.run, /postpack-restore-workspace\.cjs/);

  const mainPublish = steps.find((entry) => entry.name === "Publish main package");
  assert.ok(mainPublish, "workflow must publish the main package");
  assert.match(mainPublish.run, /prepack-resolve-workspace\.cjs/);
  assert.match(mainPublish.run, /postpack-restore-workspace\.cjs/);

  assert.ok(smoke, "workflow must smoke-test the standalone MCP server package");
  assert.match(smoke.run, /npm install "@opengsd\/mcp-server@\$\{VERSION\}"/);
  assert.match(smoke.run, /gsd-mcp-server/);
});

test("publish-engine-packages script continues through all platforms", () => {
  const script = readFileSync("scripts/publish-engine-packages.sh", "utf8");

  assert.match(script, /FAILED=\(\)/);
  assert.match(script, /for platform in "\$\{PLATFORMS\[@\]\}"/);
  assert.doesNotMatch(script, /exit 1\s*\n\s*fi\s*\n\s*cd "\$GITHUB_WORKSPACE"/);
  assert.match(script, /already on npm, skipping/);
});
