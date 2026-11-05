import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const baselinePath = join(process.cwd(), "scripts/workflow-authority-baseline.mjs");
const baseline = await import(pathToFileURL(baselinePath).href);
const BASELINE_SPAWN_TIMEOUT_MS = 540_000; // 3 x 90s + 240s matrix budget + headroom
const BASELINE_TEST_TIMEOUT_MS = 560_000;

test("workflow authority baseline reports four fixed invariants in stable order", () => {
  const calls: Array<{ executable: string; args: string[] }> = [];
  let now = 0;
  const report = baseline.runWorkflowAuthorityBaseline({
    invariants: [{ id: "override", name: "Override", file: "override.test.ts" }],
    now: () => now += 5,
    spawnSyncImpl: (executable: string, args: string[]) => {
      calls.push({ executable, args });
      return { status: 0, signal: null, stdout: "", stderr: "" };
    },
  });

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.verdict, "pass");
  const expected = [
    ["db-authority-fixture", "workflow-authority-fixture.test.ts"],
    ["projection-conflict", "workflow-authority-projection-conflict.test.ts"],
    ["fault-harness-contract", "workflow-fault-harness.test.ts"],
    ["fault-boundary-matrix", "workflow-authority-faults.test.ts"],
  ].map(([id, filename]) => {
    const file = `src/resources/extensions/gsd/tests/${filename}`;
    const reportedArgs = [
      "--import",
      "./src/resources/extensions/gsd/tests/resolve-ts.mjs",
      "--experimental-strip-types",
      "--test",
      file,
    ];
    return {
      id,
      executable: process.execPath,
      args: [
        "--import",
        join(baseline.REPO_ROOT, "src/resources/extensions/gsd/tests/resolve-ts.mjs"),
        "--experimental-strip-types",
        "--test",
        join(baseline.REPO_ROOT, file),
      ],
      command: ["node", ...reportedArgs].map((part) => JSON.stringify(part)).join(" "),
    };
  });

  assert.deepEqual(
    report.invariants.map((entry: { id: string; command: string }, index: number) => ({
      id: entry.id,
      executable: calls[index].executable,
      args: calls[index].args,
      command: entry.command,
    })),
    expected,
    "each accepted invariant must retain its exact ID, execution path, and reported command",
  );
  assert.equal(baseline.exitCodeForReport(report), 0);
});

test("workflow authority baseline preserves the first failing child status", () => {
  let call = 0;
  const report = baseline.runWorkflowAuthorityBaseline({
    now: () => 0,
    spawnSyncImpl: () => {
      call += 1;
      return { status: call === 2 ? 7 : 0, signal: null, stdout: "", stderr: "failed" };
    },
  });

  assert.equal(report.verdict, "fail");
  assert.equal(report.invariants[1].exitCode, 7);
  assert.equal(report.invariants[1].verdict, "fail");
  assert.equal(baseline.exitCodeForReport(report), 7);
  assert.match(baseline.renderWorkflowAuthoritySummary(report), /projection-conflict.*FAIL.*node/s);
});

test("workflow authority baseline gives the measured fault-boundary matrix a 240s watchdog", (t) => {
  const original = process.env.GSD_BASELINE_INVARIANT_TIMEOUT_MS;
  t.after(() => {
    if (original === undefined) delete process.env.GSD_BASELINE_INVARIANT_TIMEOUT_MS;
    else process.env.GSD_BASELINE_INVARIANT_TIMEOUT_MS = original;
  });
  delete process.env.GSD_BASELINE_INVARIANT_TIMEOUT_MS;

  const timeouts: number[] = [];
  const report = baseline.runWorkflowAuthorityBaseline({
    now: () => 0,
    spawnSyncImpl: (_executable: string, _args: string[], options: { timeout: number }) => {
      timeouts.push(options.timeout);
      return { status: 0, signal: null, stdout: "", stderr: "" };
    },
  });

  assert.equal(report.verdict, "pass");
  assert.deepEqual(timeouts, [90000, 90000, 90000, 240000]);
});

test("workflow authority baseline per-invariant timeout honors GSD_BASELINE_INVARIANT_TIMEOUT_MS", (t) => {
  const original = process.env.GSD_BASELINE_INVARIANT_TIMEOUT_MS;
  t.after(() => {
    if (original === undefined) delete process.env.GSD_BASELINE_INVARIANT_TIMEOUT_MS;
    else process.env.GSD_BASELINE_INVARIANT_TIMEOUT_MS = original;
  });
  process.env.GSD_BASELINE_INVARIANT_TIMEOUT_MS = "90000";

  const timeouts: number[] = [];
  const report = baseline.runWorkflowAuthorityBaseline({
    now: () => 0,
    spawnSyncImpl: (_executable: string, _args: string[], options: { timeout: number }) => {
      timeouts.push(options.timeout);
      const error = Object.assign(new Error("spawnSync node ETIMEDOUT"), { code: "ETIMEDOUT" });
      return { status: null, signal: "SIGTERM", stdout: "", stderr: "", error };
    },
  });

  assert.deepEqual(timeouts, [90000, 90000, 90000, 90000]);
  assert.equal(report.verdict, "fail");
  assert.match(report.invariants[0].error, /timed out after 90000ms/);
  assert.match(report.invariants[0].error, /GSD_BASELINE_INVARIANT_TIMEOUT_MS/);
});

test(
  "workflow authority baseline controlled sabotage exits nonzero",
  { timeout: BASELINE_TEST_TIMEOUT_MS },
  (t) => {
    const root = mkdtempSync(join(tmpdir(), "workflow-authority-baseline-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const sabotageModule = join(root, "controlled-sabotage.mjs");
    writeFileSync(
      sabotageModule,
      `if (process.argv.some((arg) => arg.endsWith("workflow-authority-projection-conflict.test.ts"))) {
  process.exit(7);
}
`,
    );

    const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    const nodeOptions = [
      process.env.NODE_OPTIONS,
      `--import=${pathToFileURL(sabotageModule).href}`,
    ]
      .filter(Boolean)
      .join(" ");
    const child = spawnSync(
      pnpm,
      ["--silent", "run", "baseline:workflow-authority", "--", "--json"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, NODE_OPTIONS: nodeOptions },
        timeout: BASELINE_SPAWN_TIMEOUT_MS,
      },
    );

    assert.equal(child.status, 1, child.stderr || child.stdout);
    const report = JSON.parse(child.stdout);
    assert.equal(report.verdict, "fail");
    assert.deepEqual(
      report.invariants.map((invariant: { id: string }) => invariant.id),
      baseline.WORKFLOW_AUTHORITY_INVARIANTS.map(
        (invariant: { id: string }) => invariant.id,
      ),
    );
    assert.equal(report.invariants[1].exitCode, 1);
    assert.equal(report.invariants[1].verdict, "fail");
    const passingInvariants = report.invariants.filter(
      (invariant: { verdict: string }) => invariant.verdict === "pass",
    );
    const failedInvariants = report.invariants.filter(
      (invariant: { verdict: string }) => invariant.verdict !== "pass",
    );
    assert.equal(passingInvariants.length, 3, JSON.stringify(failedInvariants, null, 2));
  },
);

test("workflow authority baseline CLI emits the v1 JSON report", {
  timeout: BASELINE_TEST_TIMEOUT_MS,
}, () => {
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const child = spawnSync(pnpm, ["--silent", "run", "baseline:workflow-authority", "--", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: BASELINE_SPAWN_TIMEOUT_MS,
  });

  assert.equal(child.status, 0, child.stderr || child.stdout);
  const report = JSON.parse(child.stdout);
  assert.deepEqual(Object.keys(report), ["schemaVersion", "verdict", "durationMs", "invariants"]);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.verdict, "pass");
  assert.equal(report.invariants.length, 4);
  for (const invariant of report.invariants) {
    assert.deepEqual(
      Object.keys(invariant),
      ["id", "name", "command", "verdict", "exitCode", "durationMs", "signal", "error"],
    );
  }
});
