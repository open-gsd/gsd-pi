// Open GSD - GitHub workflow runner contract tests.
// File Purpose: Ensure active workflows use approved runners and cache actions.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import YAML from "yaml";

const WORKFLOW_DIR = ".github/workflows";
const APPROVED_RUNNERS = new Set([
  "ubuntu-latest",
  "windows-latest",
  "macos-14",
  "macos-15",
  "blacksmith-4vcpu-ubuntu-2404",
  "blacksmith-4vcpu-ubuntu-2404-arm",
  "blacksmith-4vcpu-windows-2025",
]);

function loadWorkflows() {
  return readdirSync(WORKFLOW_DIR)
    .filter((entry) => entry.endsWith(".yml") || entry.endsWith(".yaml"))
    .map((entry) => {
      const path = join(WORKFLOW_DIR, entry);
      return {
        path,
        document: YAML.parse(readFileSync(path, "utf8")),
      };
    });
}

function visit(value, onValue) {
  onValue(value);
  if (Array.isArray(value)) {
    for (const item of value) visit(item, onValue);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) visit(item, onValue);
  }
}

test("active workflows use approved runners", () => {
  for (const workflow of loadWorkflows()) {
    const jobs = workflow.document.jobs ?? {};
    for (const [jobName, job] of Object.entries(jobs)) {
      const runner = job["runs-on"];
      if (!runner || String(runner).includes("${{")) continue;

      assert.ok(
        APPROVED_RUNNERS.has(runner),
        `${workflow.path} job ${jobName} uses unapproved runner ${runner}`,
      );
    }
  }
});

test("active workflows use the standard cache action", () => {
  for (const workflow of loadWorkflows()) {
    visit(workflow.document, (value) => {
      if (!value || typeof value !== "object" || !("uses" in value)) return;

      assert.notEqual(
        value.uses,
        "useblacksmith/cache@v5",
        `${workflow.path} still uses the custom cache action`,
      );
    });
  }
});

test("ci workflow checkout does not depend on actor-scoped GitHub token auth", () => {
  const workflow = YAML.parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  const checkoutSteps = [];

  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      assert.doesNotMatch(
        String(step.uses ?? ""),
        /^actions\/checkout@/,
        `.github/workflows/ci.yml job ${jobName} uses token-authenticated checkout`,
      );

      if (step.name === "Checkout repository without GITHUB_TOKEN") {
        checkoutSteps.push({ jobName, step });
      }
    }
  }

  assert.ok(checkoutSteps.length > 0, "CI workflow has explicit checkout steps");

  for (const { jobName, step } of checkoutSteps) {
    assert.equal(step.shell, "bash", `CI job ${jobName} checkout runs under bash`);
    assert.match(
      step.run,
      /https:\/\/github\.com\/\$\{GITHUB_REPOSITORY\}\.git/,
      `CI job ${jobName} checkout uses the public HTTPS repository URL`,
    );
    assert.doesNotMatch(
      step.run,
      /github\.token|\$\{\{\s*github\.token\s*\}\}|GITHUB_TOKEN/,
      `CI job ${jobName} checkout script does not reference GitHub token auth`,
    );
  }
});

test("ci workflow opts into Node 24 actions runtime", () => {
  const workflow = YAML.parse(readFileSync(".github/workflows/ci.yml", "utf8"));

  assert.equal(workflow.env.FORCE_JAVASCRIPT_ACTIONS_TO_NODE24, "true");
});

test("node22 smoke installs the strictest workspace engine floor", () => {
  const workflow = YAML.parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  const setupNode = workflow.jobs["node22-smoke"].steps.find(
    (step) => step.name === "Setup Node.js 22 (engines floor)",
  );
  const manifests = [
    "package.json",
    ...readdirSync("packages", { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join("packages", entry.name, "package.json")),
  ].filter(existsSync);
  const engineFloors = manifests
    .map((path) => JSON.parse(readFileSync(path, "utf8")).engines?.node)
    .filter((value) => typeof value === "string")
    .map((range) => {
      const match = /^>=(\d+\.\d+\.\d+)$/.exec(range);
      assert.ok(match, `unsupported Node engine range ${range}`);
      return match[1];
    });
  const strictestFloor = engineFloors.sort((left, right) => left.localeCompare(right, undefined, { numeric: true })).at(-1);

  assert.equal(setupNode.with["node-version"], strictestFloor);
});

test("native Linux ARM64 build matrix uses a Rust target triple", () => {
  const workflow = YAML.parse(readFileSync(".github/workflows/build-native.yml", "utf8"));
  const entries = workflow.jobs.build.strategy.matrix.include;
  const linuxArm64 = entries.find((entry) => entry.platform === "linux-arm64-gnu");

  assert.equal(linuxArm64.target, "aarch64-unknown-linux-gnu");
  assert.equal(linuxArm64.os, "blacksmith-4vcpu-ubuntu-2404-arm");
});
