// Project/App: gsd-pi
// File Purpose: Runs the ADR-046 performance baseline (Migration step 8)
// against the committed baseline file: p50/p95 of deriveState, one Domain
// Operation commit and a projection drain, measured on the fixed corpus, may
// not exceed twice the recorded values. Also pins the comparison logic.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const scriptModule = await import("../../scripts/workflow-performance-baseline.mjs");
const { compareAgainstBaseline, TOLERANCE } = scriptModule as {
  compareAgainstBaseline: (measured: Record<string, { p50: number; p95: number }>, baseline: Record<string, { p50: number; p95: number }>) => string[];
  TOLERANCE: number;
};

const REPO_ROOT = process.cwd();
const BASELINE_FILE = join(REPO_ROOT, "scripts", "baselines", "workflow-performance-baseline.json");
const SCRIPT = join(REPO_ROOT, "scripts", "workflow-performance-baseline.mjs");
const RESOLVER = join(REPO_ROOT, "src", "resources", "extensions", "gsd", "tests", "resolve-ts.mjs");

test("the committed performance baseline exists and is complete", () => {
  assert.ok(existsSync(BASELINE_FILE), `missing ${BASELINE_FILE}; generate with --update-baseline`);
  const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf-8"));
  for (const metric of ["deriveState", "domainOperationCommit", "projectionDrain"]) {
    const recorded = baseline[metric] as { p50: number; p95: number; samples: number } | undefined;
    assert.ok(recorded, `baseline metric ${metric} missing`);
    assert.ok(recorded!.p50 > 0, `${metric}.p50 must be a measured value`);
    assert.ok(recorded!.p95 >= recorded!.p50, `${metric}.p95 must be >= p50`);
    assert.equal(recorded!.samples > 0, true, `${metric}.samples must be recorded`);
  }
});

test("compareAgainstBaseline fails only beyond the declared tolerance", () => {
  const baseline = {
    deriveState: { p50: 1, p95: 2 },
    domainOperationCommit: { p50: 10, p95: 20 },
    projectionDrain: { p50: 10, p95: 20 },
  };

  const clean = compareAgainstBaseline(
    { deriveState: { p50: 2, p95: 4 }, domainOperationCommit: { p50: 20, p95: 40 }, projectionDrain: { p50: 5, p95: 10 } },
    baseline,
  );
  assert.deepEqual(clean, [], "values exactly at the tolerance are not regressions");

  const faster = compareAgainstBaseline(
    { deriveState: { p50: 0.1, p95: 0.2 }, domainOperationCommit: { p50: 1, p95: 2 }, projectionDrain: { p50: 1, p95: 2 } },
    baseline,
  );
  assert.deepEqual(faster, [], "being faster never fails");

  const regressed = compareAgainstBaseline(
    { deriveState: { p50: 1, p95: 2 }, domainOperationCommit: { p50: 21, p95: 20 }, projectionDrain: { p50: 10, p95: 41 } },
    baseline,
  );
  assert.equal(regressed.length, 2, "p50 and p95 regressions beyond the tolerance both fail");
  assert.match(regressed[0]!, /domainOperationCommit\.p50: 21ms > 10ms x 2/);
  assert.match(regressed[1]!, /projectionDrain\.p95: 41ms > 20ms x 2/);

  const undeclared = compareAgainstBaseline(
    { deriveState: { p50: 1, p95: 2 } },
    baseline,
  );
  assert.equal(undeclared.length, 2, "a metric this run did not measure is a block, not a pass");

  const unrecorded = compareAgainstBaseline(
    { ...baseline },
    { deriveState: baseline.deriveState },
  );
  assert.equal(unrecorded.length, 2, "a metric the baseline does not record is a block, not a pass");
});

test("the measured corpus does not regress against the committed baseline", { timeout: 300_000 }, () => {
  const result = spawnSync(process.execPath, [
    "--import", `./${join("src/resources/extensions/gsd/tests/resolve-ts.mjs")}`,
    "--experimental-strip-types", SCRIPT,
  ], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 280_000,
    env: { ...process.env, GSD_NATIVE_PREFER_LOCAL: process.env.GSD_NATIVE_PREFER_LOCAL ?? "1" },
  });

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  assert.equal(
    result.status, 0,
    `performance baseline gate failed (${result.status}):\n${output.slice(-4000)}`,
  );
  assert.match(output, new RegExp(`tolerance ${TOLERANCE}x`));
});
