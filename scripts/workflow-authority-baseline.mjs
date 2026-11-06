#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { isAbsolute, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SCRIPT_DIR, "..");

export const WORKFLOW_AUTHORITY_INVARIANTS = Object.freeze([
  {
    id: "db-authority-fixture",
    name: "DB authority fixture",
    file: "src/resources/extensions/gsd/tests/workflow-authority-fixture.test.ts",
  },
  {
    id: "projection-conflict",
    name: "Projection conflict",
    file: "src/resources/extensions/gsd/tests/workflow-authority-projection-conflict.test.ts",
  },
  {
    id: "fault-harness-contract",
    name: "Fault harness contract",
    file: "src/resources/extensions/gsd/tests/workflow-fault-harness.test.ts",
  },
  {
    id: "fault-boundary-matrix",
    name: "Fault boundary matrix",
    file: "src/resources/extensions/gsd/tests/workflow-authority-faults.test.ts",
  },
]);

export function parseArgs(argv = process.argv.slice(2)) {
  for (const arg of argv) {
    if (arg !== "--" && arg !== "--json") throw new Error(`Unknown argument: ${arg}`);
  }
  return { json: argv.includes("--json") };
}

function commandText(executable, args) {
  return [executable, ...args].map((part) => JSON.stringify(part)).join(" ");
}

function commandForInvariant(invariant) {
  const resolverFile = "src/resources/extensions/gsd/tests/resolve-ts.mjs";
  const reportedArgs = [
    "--import",
    `./${resolverFile}`,
    "--experimental-strip-types",
    "--test",
    invariant.file,
  ];
  const args = reportedArgs.map((arg, index) => {
    if (index === 1) return join(REPO_ROOT, resolverFile);
    if (index === 4 && !isAbsolute(arg)) return join(REPO_ROOT, arg);
    return arg;
  });
  return {
    executable: process.execPath,
    args,
    text: commandText("node", reportedArgs),
  };
}

// Per-invariant hang watchdog. The fault-boundary matrix passed in 147s on
// this developer host and exceeded 180s in a sabotage run; retain headroom with
// a matrix-specific 240s budget while other invariants retain 90s. The full
// 510s worst case stays within the outer baseline-test budget.
export const INVARIANT_TIMEOUT_ENV = "GSD_BASELINE_INVARIANT_TIMEOUT_MS";
const DEFAULT_INVARIANT_TIMEOUT_MS = 90_000;
const FAULT_BOUNDARY_MATRIX_TIMEOUT_MS = 240_000;

export function invariantTimeoutMs(invariant, env = process.env) {
  return Number(env[INVARIANT_TIMEOUT_ENV]) || (
    invariant.id === "fault-boundary-matrix"
      ? FAULT_BOUNDARY_MATRIX_TIMEOUT_MS
      : DEFAULT_INVARIANT_TIMEOUT_MS
  );
}

export function runInvariant(
  invariant,
  {
    now = () => performance.now(),
    spawnSyncImpl = spawnSync,
  } = {},
) {
  const command = commandForInvariant(invariant);
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const timeout = invariantTimeoutMs(invariant);
  const startedAt = now();
  const child = spawnSyncImpl(command.executable, command.args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: childEnv,
    maxBuffer: 50 * 1024 * 1024,
    timeout,
  });
  const durationMs = Math.max(0, Math.round(now() - startedAt));
  const exitCode = Number.isInteger(child.status) ? child.status : null;
  const error = child.error?.code === "ETIMEDOUT"
    ? `invariant "${invariant.id}" timed out after ${timeout}ms; raise ${INVARIANT_TIMEOUT_ENV} to allow more time on slower machines`
    : (child.error?.message ?? null);

  return {
    id: invariant.id,
    name: invariant.name,
    command: command.text,
    verdict: exitCode === 0 && error === null ? "pass" : "fail",
    exitCode,
    durationMs,
    signal: child.signal ?? null,
    error,
  };
}

export function runWorkflowAuthorityBaseline({
  now = () => performance.now(),
  spawnSyncImpl = spawnSync,
} = {}) {
  const results = WORKFLOW_AUTHORITY_INVARIANTS.map(
    (invariant) => runInvariant(invariant, { now, spawnSyncImpl }),
  );
  return {
    schemaVersion: 1,
    verdict: results.every((result) => result.verdict === "pass") ? "pass" : "fail",
    durationMs: results.reduce((total, result) => total + result.durationMs, 0),
    invariants: results,
  };
}

export function exitCodeForReport(report) {
  const failure = report.invariants.find((invariant) => invariant.verdict === "fail");
  if (!failure) return 0;
  return typeof failure.exitCode === "number" && failure.exitCode !== 0
    ? failure.exitCode
    : 1;
}

export function renderWorkflowAuthoritySummary(report) {
  const passed = report.invariants.filter((invariant) => invariant.verdict === "pass").length;
  const lines = [
    "Workflow authority baseline",
    `Status: ${report.verdict.toUpperCase()} (${passed}/${report.invariants.length})`,
    "",
  ];
  for (const invariant of report.invariants) {
    const mark = invariant.verdict === "pass" ? "PASS" : "FAIL";
    lines.push(`${invariant.id}: ${mark} (${invariant.durationMs}ms)`);
    lines.push(`  ${invariant.name}`);
    lines.push(`  ${invariant.command}`);
    if (invariant.error) lines.push(`  ${invariant.error}`);
  }
  lines.push("", `Total: ${report.durationMs}ms`, "");
  return lines.join("\n");
}

function main() {
  try {
    const options = parseArgs();
    const report = runWorkflowAuthorityBaseline();
    process.stdout.write(options.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : renderWorkflowAuthoritySummary(report));
    process.exitCode = exitCodeForReport(report);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
