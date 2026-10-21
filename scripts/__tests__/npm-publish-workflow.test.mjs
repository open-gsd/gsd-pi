// Project/App: gsd-pi
// File Purpose: Regression tests for npm publish workflow channel policy.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import YAML from "yaml";

const workflow = YAML.parse(
  readFileSync(".github/workflows/npm-publish.yml", "utf8"),
);
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

const latestCondition = "${{ github.event.inputs.channel == 'latest' }}";
const prereleaseChannel =
  "${{ github.event.inputs.channel == 'latest' && 'dev' || github.event.inputs.channel }}";
const prereleaseRef =
  "${{ github.event.inputs.channel == 'latest' && 'main' || github.event.inputs.ref || (github.event.inputs.channel == 'next' && 'next' || 'main') }}";
const prereleasePublishStep = `Publish @${prereleaseChannel}`;

test("npm publish exposes only supported npm channels", () => {
  const channel = workflow.on.workflow_dispatch.inputs.channel;

  assert.equal(channel.required, true);
  assert.equal(channel.default, "dev");
  assert.deepEqual(channel.options, ["dev", "next", "latest"]);
});

test("prerelease publish gates through the effective prerelease GitHub Environment", () => {
  assert.equal(workflow.jobs["prerelease-publish"].environment, prereleaseChannel);
});

test("production publish keeps the prod approval gate", () => {
  assert.equal(workflow.jobs["prod-release"].if, latestCondition);
  assert.deepEqual(workflow.jobs["prod-release"].needs, [
    "prod-release-plan",
    "prod-native-build",
  ]);
  assert.equal(workflow.jobs["prod-release"].environment, "prod");
});

test("prerelease publish preserves channel-specific default refs", () => {
  const checkout = workflow.jobs["prerelease-publish"].steps.find(
    (step) => step.uses?.startsWith("actions/checkout@"),
  );

  assert.equal(workflow.on.workflow_dispatch.inputs.ref.default, "");
  assert.equal(checkout.with.token, "${{ github.token }}");
  assert.equal(checkout.with.ref, prereleaseRef);
  assert.match(checkout.with.ref, /github\.event\.inputs\.channel == 'latest'/);
  assert.match(checkout.with.ref, /github\.event\.inputs\.channel == 'next'/);
  assert.match(checkout.with.ref, /'next'/);
  assert.match(checkout.with.ref, /'main'/);
});

test("npm publish supports token auth fallback for prerelease", () => {
  const input = workflow.on.workflow_dispatch.inputs.publish_auth;

  assert.equal(input.default, "trusted");
  assert.deepEqual(input.options, ["trusted", "token"]);

  const setupNode = workflow.jobs["prerelease-publish"].steps.find(
    (step) => step.uses?.startsWith("actions/setup-node@"),
  );
  assert.equal(
    setupNode.env.NODE_AUTH_TOKEN,
    "${{ github.event.inputs.publish_auth == 'token' && secrets.NPM_TOKEN || '' }}",
  );
});

test("publish jobs use GitHub-hosted runners for npm provenance", () => {
  assert.equal(workflow.jobs["prerelease-publish"]["runs-on"], "ubuntu-latest");
  assert.equal(workflow.jobs["prod-release"]["runs-on"], "ubuntu-latest");
});

test("production publish plans the release and builds native artifacts in the same workflow", () => {
  const plan = workflow.jobs["prod-release-plan"];
  const nativeBuild = workflow.jobs["prod-native-build"];

  assert.ok(plan, "production publish must plan the release version");
  assert.equal(plan.if, latestCondition);
  assert.equal(plan.needs, "prerelease-verify");
  assert.equal(plan.outputs.version, "${{ steps.release.outputs.version }}");
  assert.equal(plan.outputs.source_sha, "${{ steps.release.outputs.source_sha }}");
  assert.ok(
    plan.steps.some((step) => step.uses?.startsWith("actions/upload-artifact@")),
    "release metadata must be passed to the gated publish job",
  );

  assert.ok(nativeBuild, "production publish must build native binaries");
  assert.equal(nativeBuild.needs, "prod-release-plan");
  assert.deepEqual(
    nativeBuild.strategy.matrix.include.map((entry) => entry.platform).sort(),
    [
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64-gnu",
      "linux-x64-gnu",
      "win32-x64-msvc",
    ],
  );
  assert.ok(
    nativeBuild.steps.some((step) => step.uses?.startsWith("actions/upload-artifact@")),
    "native artifacts must be uploaded for the production release job",
  );
});

test("npm publish opts into Node 24 actions runtime and quiet npm install noise", () => {
  assert.equal(workflow.env.FORCE_JAVASCRIPT_ACTIONS_TO_NODE24, "true");
  assert.equal(workflow.env.NPM_CONFIG_AUDIT, "false");
  assert.equal(workflow.env.NPM_CONFIG_FUND, "false");
  assert.equal(workflow.env.NPM_CONFIG_LOGLEVEL, "error");
});

test("main package publish verifies native engine packages first", () => {
  const prereleaseSteps = workflow.jobs["prerelease-publish"].steps;
  const prereleaseVerify = prereleaseSteps.find(
    (step) => step.name === "Verify native platform packages exist",
  );
  const prereleasePublishIndex = prereleaseSteps.findIndex(
    (step) => step.name === prereleasePublishStep,
  );
  const prereleaseVerifyIndex = prereleaseSteps.indexOf(prereleaseVerify);

  assert.ok(prereleaseVerify, "prerelease publish must verify native packages");
  assert.match(prereleaseVerify.run, /npm run verify:native-platform-packages/);
  assert.doesNotMatch(prereleaseVerify.run, /--any-version/);
  assert.ok(prereleaseVerifyIndex > -1 && prereleaseVerifyIndex < prereleasePublishIndex);

  const prodSteps = workflow.jobs["prod-release"].steps;
  const prodNativePublish = prodSteps.find(
    (step) => step.name === "Publish native platform packages for release version",
  );
  const prodVerify = prodSteps.find(
    (step) => step.name === "Verify native platform packages for release version",
  );
  const prodPublishIndex = prodSteps.findIndex(
    (step) => step.name === "Publish release to npm @latest",
  );
  const prodNativePublishIndex = prodSteps.indexOf(prodNativePublish);
  const prodVerifyIndex = prodSteps.indexOf(prodVerify);

  assert.ok(prodNativePublish, "production publish must publish native packages");
  assert.match(prodNativePublish.run, /publish-engine-packages\.sh/);
  assert.equal(
    prodNativePublish.env.ENGINE_VERSION,
    "${{ needs.prod-release-plan.outputs.version }}",
  );
  assert.ok(prodVerify, "production publish must verify native packages");
  assert.match(prodVerify.run, /npm run verify:native-platform-packages/);
  assert.ok(
    prodNativePublishIndex > -1 && prodNativePublishIndex < prodVerifyIndex,
  );
  assert.ok(prodVerifyIndex > -1 && prodVerifyIndex < prodPublishIndex);
});

test("main package publish validates tarball before publishing", () => {
  const prereleaseSteps = workflow.jobs["prerelease-publish"].steps;
  const prereleaseValidate = prereleaseSteps.find(
    (step) => step.name === "Validate package is installable",
  );
  const prereleasePublishIndex = prereleaseSteps.findIndex(
    (step) => step.name === prereleasePublishStep,
  );

  assert.ok(prereleaseValidate, "prerelease publish must run validate-pack");
  assert.match(prereleaseValidate.run, /pnpm run validate-pack/);
  assert.ok(prereleaseSteps.indexOf(prereleaseValidate) < prereleasePublishIndex);

  const prodSteps = workflow.jobs["prod-release"].steps;
  const prodValidate = prodSteps.find(
    (step) => step.name === "Validate package is installable",
  );
  const prodPublishIndex = prodSteps.findIndex(
    (step) => step.name === "Publish release to npm @latest",
  );

  assert.ok(prodValidate, "production publish must run validate-pack");
  assert.match(prodValidate.run, /pnpm run validate-pack/);
  assert.ok(prodSteps.indexOf(prodValidate) < prodPublishIndex);
});

test("production release runs optional live workflow test on the configured OpenAI model", () => {
  const steps = workflow.jobs["prod-release"].steps;
  const idx = (name) => steps.findIndex((step) => step.name === name);

  const buildRelease = idx("Build release");
  const liveWorkflow = idx("Run live workflow LLM tests (optional)");
  const liveRegression = idx("Run live regression tests (against release build)");

  assert.ok(liveWorkflow > -1, "prod-release must include optional live workflow coverage");
  assert.ok(buildRelease > -1 && buildRelease < liveWorkflow, "live workflow must use the built release binary");
  assert.ok(liveWorkflow < liveRegression, "live workflow should run before non-LLM live regression checks");

  const step = steps[liveWorkflow];
  assert.equal(step["continue-on-error"], true);
  assert.match(step.run, /GSD_SMOKE_BINARY="\$\(pwd\)\/dist\/loader\.js"/);
  assert.match(step.run, /pnpm run test:live-workflow/);
  assert.equal(step.env.OPENAI_API_KEY, "${{ secrets.OPENAI_API_KEY }}");
  assert.equal(step.env.GSD_LIVE_TESTS, "1");
  assert.equal(step.env.GSD_LIVE_WORKFLOW_MODEL, "openai/gpt-5.4-mini");
});

test("prerelease verification blocks release planning on the auto-mode acceptance bed", () => {
  const steps = workflow.jobs["prerelease-verify"].steps;
  const buildHelpersIndex = steps.findIndex(
    (step) => step.name === "Build auto-mode acceptance bed helpers",
  );
  const acceptanceBedIndex = steps.findIndex(
    (step) => step.name === "Run auto-mode acceptance bed (against installed binary)",
  );
  const acceptanceBed = steps.find(
    (step) => step.name === "Run auto-mode acceptance bed (against installed binary)",
  );

  assert.ok(buildHelpersIndex > -1, "prerelease verification must build the acceptance bed helpers");
  assert.match(steps[buildHelpersIndex].run, /pnpm run build:core/);
  assert.ok(buildHelpersIndex < acceptanceBedIndex, "acceptance bed helpers must exist before the bed runs");
  assert.ok(acceptanceBed, "prerelease verification must run the auto-mode acceptance bed");
  assert.notEqual(
    acceptanceBed["continue-on-error"],
    true,
    "a wedged acceptance bed must block the release",
  );
  assert.match(acceptanceBed.run, /GSD_SMOKE_BINARY=\$\(which gsd\)/);
  assert.match(acceptanceBed.run, /pnpm run test:auto-acceptance/);
  assert.equal(
    packageJson.scripts["test:auto-acceptance"],
    "node tests/acceptance-bed/auto-milestone-bed.mjs",
  );
  assert.equal(workflow.jobs["prod-release-plan"].needs, "prerelease-verify");
});

test("production release publishes workspace packages and verifies ALL packages before cutting the GitHub release", () => {
  const steps = workflow.jobs["prod-release"].steps;
  const idx = (name) => steps.findIndex((s) => s.name === name);

  const workspacePublish = idx("Publish workspace packages to npm");
  const mainPublish = idx("Publish release to npm @latest");
  const verifyAll = idx("Verify all required packages are published on npm");
  const pushTag = idx("Push release tag");
  const pushMain = idx("Push release commit to main");
  const ghRelease = idx("Create GitHub Release");

  // Workspace packages publish before the main package.
  assert.ok(workspacePublish > -1, "prod-release must publish workspace packages");
  assert.ok(workspacePublish < mainPublish, "workspace packages must publish before the main package");
  assert.match(steps[workspacePublish].run, /publish-workspace-packages\.sh/);
  assert.match(steps[workspacePublish].run, /prepack-resolve-workspace\.cjs/);

  // The full verification gate runs AFTER all publishing and BEFORE the release is cut.
  assert.ok(verifyAll > -1, "prod-release must verify all required packages on npm");
  assert.match(steps[verifyAll].run, /verify-npm-release\.mjs/);
  assert.ok(verifyAll > mainPublish, "verify must run after the main package is published");
  assert.ok(verifyAll < pushTag, "verify must run before the release tag is pushed");
  assert.ok(verifyAll < ghRelease, "verify must run before the GitHub release is created");

  // The tag is pushed on its own and first. Branch rulesets do not apply to
  // tags but do apply to main, so chaining both pushes in one step lets a
  // rejected main push take the tag down with it - which is how v1.16.0
  // reached npm with no tag and no GitHub release.
  assert.ok(pushTag > -1, "prod-release must push the release tag");
  assert.ok(pushMain > -1, "prod-release must push the release commit to main");
  assert.ok(pushTag < pushMain, "the release tag must be pushed before the main branch push");
  assert.doesNotMatch(steps[pushTag].run, /push origin main/, "the tag push must not also push main");
});

test("production release updates README highlights in the release commit", () => {
  const steps = workflow.jobs["prod-release"].steps;
  const idx = (name) => steps.findIndex((s) => s.name === name);

  const updateChangelog = idx("Update CHANGELOG.md");
  const updateReadme = idx("Update README release highlights");
  const commitRelease = idx("Commit and tag release");

  assert.ok(updateReadme > updateChangelog, "README highlights should use generated release notes");
  assert.ok(updateReadme < commitRelease, "README highlights must be staged into the release commit");
  assert.match(steps[updateReadme].run, /update-readme-release-highlights\.mjs/);
  assert.match(steps[updateReadme].run, /release-metadata\/release-notes\.md/);
  assert.match(steps[commitRelease].run, /git add .*README\.md/);
});

test("main package publish uses explicit prepack and disables npm lifecycle reruns", () => {
  const prereleasePublish = workflow.jobs["prerelease-publish"].steps.find(
    (step) => step.name === prereleasePublishStep,
  );
  assert.match(prereleasePublish.run, /prepack-resolve-workspace\.cjs/);
  assert.match(prereleasePublish.run, /postpack-restore-workspace\.cjs/);
  assert.match(prereleasePublish.run, /npm publish --ignore-scripts --tag "\$\{CHANNEL\}"/);

  const prodPublish = workflow.jobs["prod-release"].steps.find(
    (step) => step.name === "Publish release to npm @latest",
  );
  assert.match(prodPublish.run, /prepack-resolve-workspace\.cjs/);
  assert.match(prodPublish.run, /postpack-restore-workspace\.cjs/);
  assert.match(prodPublish.run, /npm publish --ignore-scripts --tag latest/);
});

test("production release stages bundled open-gsd-hermes version files", () => {
  const steps = workflow.jobs["prod-release"].steps;
  const commitRelease = steps.find((step) => step.name === "Commit and tag release");

  assert.ok(commitRelease, "prod-release must create a release commit");
  assert.match(commitRelease.run, /integrations\/hermes\/pyproject\.toml/);
  assert.match(commitRelease.run, /integrations\/hermes\/open_gsd_hermes\/gsd_client\.py/);
});

test("production release stages open-gsd-openclaw version files", () => {
  const steps = workflow.jobs["prod-release"].steps;
  const commitRelease = steps.find((step) => step.name === "Commit and tag release");

  assert.ok(commitRelease, "prod-release must create a release commit");
  // integrations/openclaw is outside the packages/*/package.json glob, and its
  // manifest is a second version surface synced by version-sync.cjs.
  assert.match(commitRelease.run, /integrations\/openclaw\/package\.json/);
  assert.match(commitRelease.run, /integrations\/openclaw\/openclaw\.plugin\.json/);
});
