import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import YAML from "yaml";

const workflow = YAML.parse(readFileSync(".github/workflows/ci.yml", "utf8"));
const nativeJob = workflow.jobs["native-attended"];
const gate = workflow.jobs["ci-gate"];

test("native attended CI is opt-in by PR label or manual dispatch", () => {
  assert.equal(
    nativeJob.if.trim(),
    "github.event_name == 'workflow_dispatch' || contains(github.event.pull_request.labels.*.name, 'native-harness')",
  );
  assert.equal(nativeJob["runs-on"], "macos-14");
  assert.ok(
    nativeJob.steps.some(
      (step) => step.uses === "./.github/actions/pre-review-node-setup",
    ),
  );
});

test("native attended CI passes the built temporary fixture package to the attended test", () => {
  const build = nativeJob.steps.find((step) => step.name === "Build native attended fixture package");
  assert.ok(
    build.run.includes(
      'fixture_package="$(node scripts/build-native-fixture-package.mjs)"',
    ),
  );
  assert.ok(build.run.includes("W067_NATIVE_FIXTURE_PACKAGE=$fixture_package"));
  assert.ok(build.run.includes("$GITHUB_ENV"));
  const run = nativeJob.steps.find((step) => step.name === "Run native attended fixtures");
  assert.match(
    run.run,
    /node --import tsx --test (?:--test-concurrency=1 )?src\/tests\/coordination-maintenance-attended\.test\.ts/,
  );
});

test("ci-gate accepts a skipped native job but rejects native failures and cancellations", () => {
  assert.ok(gate.needs.includes("native-attended"));
  assert.equal(gate.if, "always()");
  const step = gate.steps.find(
    (step) => step.name === "Assert no upstream job failed or was cancelled",
  );
  assert.equal(step.env.NATIVE_ATTENDED, "${{ needs.native-attended.result }}");
  for (const { result, expected } of [
    { result: "skipped", expected: 0 },
    { result: "success", expected: 0 },
    { result: "failure", expected: 1 },
    { result: "cancelled", expected: 1 },
  ]) {
    const env = Object.fromEntries(
      Object.keys(step.env).map((name) => [
        name,
        name === "NATIVE_ATTENDED" ? result : "success",
      ]),
    );
    const check = spawnSync("bash", ["-c", step.run], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    assert.equal(check.status, expected, `native result ${result}: ${check.stderr}`);
  }
});
