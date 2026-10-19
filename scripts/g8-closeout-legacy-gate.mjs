#!/usr/bin/env node
// Project/App: gsd-pi
// File Purpose: Removal Gate G8 (ADR-046 Migration step 8). Runs the four
// closeout e2e scenarios (fake LLM, offline) and the auto-mode acceptance
// bed (also fake LLM — no real model needed) with legacy telemetry enabled,
// then asserts every cutover bridge counter is zero and that the deleted
// branch symbols stay deleted. Fails closed: a missing telemetry file, a
// crashed run, or a missing binary is a block, never a pass.
//
// The live-model acceptance bed (real LLM tokens) is not part of CI; it
// rides to the owner per the cutover program's evidence split. The bed run
// here is the deterministic fake-LLM bed.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectDeletedSymbolProof,
  evaluateBridgeEvidenceDeclared,
  evaluateLegacyCleanupGate,
  loadTelemetryEvidence,
  renderDeletedSymbolProofSummary,
  renderLegacyCleanupGateSummary,
} from "./legacy-cleanup-gate.mjs";
import {
  collectLegacyStatePathProof,
  renderLegacyStatePathProofSummary,
} from "./legacy-state-path-proof.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The closeout ladder e2e scenarios, fake LLM, offline.
export const CLOSEOUT_E2E_FILES = [
  "tests/e2e/tiny-milestone-completion.e2e.test.ts",
  "tests/e2e/multi-slice-milestone-closeout.e2e.test.ts",
  "tests/e2e/remediation-milestone-closeout.e2e.test.ts",
  "tests/e2e/multi-milestone-sequence.e2e.test.ts",
];

export const ACCEPTANCE_BED_SCRIPT = "tests/acceptance-bed/auto-milestone-bed.mjs";

export function parseArgs(argv = process.argv.slice(2)) {
  const opts = { skipBed: false, json: false };
  for (const arg of argv) {
    if (arg === "--skip-bed") opts.skipBed = true;
    else if (arg === "--json") opts.json = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

function runStep(name, command, args, env) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  });
  return { name, code: result.status, signal: result.signal, stdout: result.stdout ?? "", error: result.error };
}

export function requireSmokeBinary() {
  const binary = process.env.GSD_SMOKE_BINARY;
  if (!binary) {
    throw new Error(
      "GSD_SMOKE_BINARY is not set. Build the loader (pnpm run build:core) and export GSD_SMOKE_BINARY=\"$PWD/dist/loader.js\". The gate fails closed without it.",
    );
  }
  if (!existsSync(resolve(binary))) {
    throw new Error(`GSD_SMOKE_BINARY does not exist: ${binary}`);
  }
  return binary;
}

async function main() {
  const opts = parseArgs();
  requireSmokeBinary();

  for (const file of CLOSEOUT_E2E_FILES) {
    if (!existsSync(join(REPO_ROOT, file))) {
      throw new Error(`closeout e2e file missing: ${file}`);
    }
  }

  const evidenceDir = mkdtempSync(join(tmpdir(), "gsd-g8-gate-"));
  const e2eTelemetryFile = join(evidenceDir, "legacy-telemetry-e2e.json");
  const bedTelemetryFile = join(evidenceDir, "legacy-telemetry-bed.json");
  const e2eArgs = ["--experimental-strip-types", "--test", "--test-concurrency=1", ...CLOSEOUT_E2E_FILES];

  const steps = [
    runStep("closeout e2e (fake LLM)", process.execPath, e2eArgs, { GSD_LEGACY_TELEMETRY_FILE: e2eTelemetryFile }),
  ];
  if (!opts.skipBed) {
    steps.push(
      runStep("acceptance bed (fake LLM)", process.execPath, [ACCEPTANCE_BED_SCRIPT], {
        GSD_LEGACY_TELEMETRY_FILE: bedTelemetryFile,
      }),
    );
  }

  const failed = steps.filter((step) => step.code !== 0);
  let evaluation = null;
  let bedEvaluation = null;
  let telemetryMissing = false;
  try {
    const report = await loadTelemetryEvidence(e2eTelemetryFile, { maxAgeMs: 24 * 60 * 60 * 1000 });
    const proof = await collectLegacyStatePathProof({ root: REPO_ROOT });
    const deletedProof = await collectDeletedSymbolProof({ root: REPO_ROOT });
    evaluation = evaluateLegacyCleanupGate(report, proof, deletedProof);
    if (!opts.skipBed) {
      // The bed enters the recover import bridge by design (it seeds its
      // fixture through it), so its evidence is held to declared-and-finite,
      // not zero.
      const bedReport = await loadTelemetryEvidence(bedTelemetryFile, { maxAgeMs: 24 * 60 * 60 * 1000 });
      bedEvaluation = evaluateBridgeEvidenceDeclared(bedReport);
      if (!bedEvaluation.ok) evaluation = { ...evaluation, ok: false };
    }
    if (opts.json && evaluation) {
      process.stdout.write(`${JSON.stringify({ steps, evaluation, bedEvaluation }, null, 2)}\n`);
    } else {
      process.stdout.write(renderLegacyCleanupGateSummary(evaluation));
      if (bedEvaluation) {
        process.stdout.write(`Acceptance bed bridge counters (declared, may be nonzero): ${JSON.stringify(bedEvaluation.counters)}\n`);
      }
      process.stdout.write(renderDeletedSymbolProofSummary(deletedProof));
      process.stdout.write(renderLegacyStatePathProofSummary(proof));
    }
  } catch (error) {
    telemetryMissing = true;
    process.stderr.write(`G8 gate: telemetry evidence unusable: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  for (const file of [e2eTelemetryFile, bedTelemetryFile]) {
    if (file && existsSync(file)) {
      try {
        process.stdout.write(`Telemetry evidence: ${file}\n${readFileSync(file, "utf-8")}`);
      } catch {
        // evidence echo is best-effort
      }
    }
  }

  rmSync(evidenceDir, { recursive: true, force: true });

  if (failed.length > 0) {
    process.stderr.write(
      `G8 gate: ${failed.map((step) => `${step.name} exited ${step.code ?? step.signal}`).join("; ")}\n`,
    );
    process.exitCode = 2;
    return;
  }
  if (telemetryMissing || !evaluation?.ok) {
    process.exitCode = 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
