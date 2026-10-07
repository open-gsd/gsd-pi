#!/usr/bin/env node
// Project/App: gsd-pi
// File Purpose: ADR-046 Migration step 8 performance baseline. Measures p50
// and p95 of three hot paths on a fixed, deterministically built corpus
// database — deriveState, one Domain Operation commit (capture.register) and
// a projection drain — and fails against the committed baseline in
// scripts/baselines/workflow-performance-baseline.json when a measurement
// regresses beyond twice the recorded value.
//
// The 2x tolerance protects against algorithmic regressions (an accidental
// N+1, a missing index, a full-file rewrite in a hot loop), not against
// machine noise: it must absorb the difference between a developer laptop
// and a slower CI runner. Regression means `measured > baseline * 2` on p50
// or p95; being faster never fails.
//
// Run: node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs
//      --experimental-strip-types scripts/workflow-performance-baseline.mjs
// Pass --update-baseline to rewrite the committed baseline from this run.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_FILE = join(REPO_ROOT, "scripts", "baselines", "workflow-performance-baseline.json");

// Fixed corpus shape. Deterministic: same row counts and statuses every run,
// so the measurements describe one workload, not a random one.
const MILESTONES = 6;
const SLICES_PER_MILESTONE = 6;
const TASKS_PER_SLICE = 5;
const DERIVE_SAMPLES = 60;
const OPERATION_SAMPLES = 40;
const DRAIN_SAMPLES = 20;

export const TOLERANCE = 2;

function git(args, cwd) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function buildCorpus() {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-perf-corpus-"));
  writeFileSync(join(basePath, ".gitignore"), ".gsd/\n");
  writeFileSync(join(basePath, "source.ts"), "export const source = 'performance-corpus';\n");
  git(["init"], basePath);
  git(["config", "user.email", "perf@example.com"], basePath);
  git(["config", "user.name", "Perf Corpus"], basePath);
  git(["add", "."], basePath);
  git(["commit", "-m", "corpus"], basePath);
  mkdirSync(join(basePath, ".gsd"), { recursive: true });

  const { openDatabase, insertMilestone, insertSlice, insertTask } = await import(
    "../src/resources/extensions/gsd/gsd-db.ts"
  );
  const { seedLifecycles } = await import("../src/resources/extensions/gsd/tests/helpers/authority-cutover.ts");

  if (openDatabase(join(basePath, ".gsd", "gsd.db")) !== true) {
    throw new Error("corpus database failed to open");
  }

  const lifecycleRows = [];
  let seq = 0;
  for (let m = 1; m <= MILESTONES; m += 1) {
    const milestoneId = `M${String(m).padStart(3, "0")}`;
    insertMilestone({
      id: milestoneId,
      title: `Performance corpus milestone ${m}`,
      status: m === 1 ? "active" : "queued",
      sequence: m,
    });
    lifecycleRows.push({ itemKind: "milestone", milestoneId, lifecycleStatus: m === 1 ? "ready" : "pending" });
    for (let s = 1; s <= SLICES_PER_MILESTONE; s += 1) {
      const sliceId = `${milestoneId}-S${String(s).padStart(2, "0")}`;
      insertSlice({
        id: sliceId,
        milestoneId,
        title: `Slice ${s}`,
        status: m === 1 && s === 1 ? "in_progress" : "pending",
        sequence: s,
      });
      lifecycleRows.push({
        itemKind: "slice", milestoneId, sliceId,
        lifecycleStatus: m === 1 && s === 1 ? "in_progress" : "pending",
      });
      for (let t = 1; t <= TASKS_PER_SLICE; t += 1) {
        const taskId = `${sliceId}-T${String(t).padStart(2, "0")}`;
        insertTask({
          id: taskId,
          milestoneId,
          sliceId,
          title: `Task ${t}`,
          status: "pending",
          sequence: t,
        });
        lifecycleRows.push({
          itemKind: "task", milestoneId, sliceId, taskId,
          lifecycleStatus: "pending",
        });
        seq += 1;
      }
    }
  }
  if (seq !== MILESTONES * SLICES_PER_MILESTONE * TASKS_PER_SLICE) {
    throw new Error("corpus row count diverged");
  }
  // Canonical lifecycle rows for every item, one seed transaction.
  for (let i = 0; i < lifecycleRows.length; i += 200) {
    seedLifecycles(`perf-corpus-${i}`, lifecycleRows.slice(i, i + 200));
  }
  return basePath;
}

function percentile(samples, fraction) {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[Math.max(0, index)];
}

function summarize(samples) {
  return {
    p50: Math.round(percentile(samples, 0.5) * 1000) / 1000,
    p95: Math.round(percentile(samples, 0.95) * 1000) / 1000,
    samples: samples.length,
  };
}

export async function measure() {
  const basePath = await buildCorpus();
  try {
    const { deriveState, invalidateStateCache } = await import("../src/resources/extensions/gsd/state.ts");
    const { appendCapture } = await import("../src/resources/extensions/gsd/captures.ts");
    const { drainProjectionWork } = await import("../src/resources/extensions/gsd/projection-worker.ts");
    const { closeDatabase } = await import("../src/resources/extensions/gsd/db/engine.ts");

    // Warmup: lazy imports, SQLite page cache.
    for (let i = 0; i < 5; i += 1) await deriveState(basePath);

    const deriveSamples = [];
    for (let i = 0; i < DERIVE_SAMPLES; i += 1) {
      // The snapshot cache must not answer the sample: the metric is the
      // cost of deriving state from the database, which is what every
      // post-mutation dispatch pays.
      invalidateStateCache();
      const start = performance.now();
      await deriveState(basePath);
      deriveSamples.push(performance.now() - start);
    }

    const operationSamples = [];
    for (let i = 0; i < OPERATION_SAMPLES; i += 1) {
      const start = performance.now();
      appendCapture(basePath, `performance corpus capture ${i}`);
      operationSamples.push(performance.now() - start);
    }

    const drainSamples = [];
    for (let i = 0; i < DRAIN_SAMPLES; i += 1) {
      // One fresh capture enqueues its projection row untimed; the sample is
      // the drain that renders the due work.
      appendCapture(basePath, `projection drain seed ${i}`);
      const start = performance.now();
      await drainProjectionWork(basePath);
      drainSamples.push(performance.now() - start);
    }
    await closeDatabase();

    return {
      deriveState: summarize(deriveSamples),
      domainOperationCommit: summarize(operationSamples),
      projectionDrain: summarize(drainSamples),
    };
  } finally {
    rmSync(basePath, { recursive: true, force: true });
  }
}

export function compareAgainstBaseline(measured, baseline) {
  const regressions = [];
  const metrics = new Set([...Object.keys(measured), ...Object.keys(baseline)]);
  for (const metric of metrics) {
    const recorded = baseline[metric];
    const sample = measured[metric];
    if (!sample || typeof sample.p50 !== "number" || typeof sample.p95 !== "number") {
      regressions.push(`${metric}: this run produced no measurement — fail loud instead of skipping the gate`);
      continue;
    }
    if (!recorded || typeof recorded.p50 !== "number" || typeof recorded.p95 !== "number") {
      regressions.push(`${metric}: baseline has no recorded p50/p95 — regenerate with --update-baseline`);
      continue;
    }
    if (sample.p50 > recorded.p50 * TOLERANCE) {
      regressions.push(`${metric}.p50: ${sample.p50}ms > ${recorded.p50}ms x ${TOLERANCE}`);
    }
    if (sample.p95 > recorded.p95 * TOLERANCE) {
      regressions.push(`${metric}.p95: ${sample.p95}ms > ${recorded.p95}ms x ${TOLERANCE}`);
    }
  }
  return regressions;
}

async function main() {
  const updateBaseline = process.argv.includes("--update-baseline");
  const measured = await measure();

  if (updateBaseline) {
    mkdirSync(dirname(BASELINE_FILE), { recursive: true });
    writeFileSync(BASELINE_FILE, `${JSON.stringify(measured, null, 2)}\n`, "utf-8");
    process.stdout.write(`baseline written: ${BASELINE_FILE}\n${JSON.stringify(measured, null, 2)}\n`);
    return;
  }

  if (!existsSync(BASELINE_FILE)) {
    process.stderr.write(`baseline file missing: ${BASELINE_FILE}. Generate it with --update-baseline on a quiet machine.\n`);
    process.exitCode = 1;
    return;
  }
  const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf-8"));
  const regressions = compareAgainstBaseline(measured, baseline);
  process.stdout.write(`performance baseline (tolerance ${TOLERANCE}x):\n${JSON.stringify(measured, null, 2)}\n`);
  if (regressions.length > 0) {
    process.stderr.write(`performance regressions vs ${BASELINE_FILE}:\n- ${regressions.join("\n- ")}\n`);
    process.exitCode = 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
