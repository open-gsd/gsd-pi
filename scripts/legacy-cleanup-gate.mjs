// Project/App: gsd-pi
// File Purpose: Checks persisted Phase 8 legacy telemetry plus the static
// state-path and deleted-symbol proofs before cleanup deletions. Fails
// closed: absent or stale evidence blocks, it never counts as proof of zero
// usage.

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { collectLegacyStatePathProof, renderLegacyStatePathProofSummary } from "./legacy-state-path-proof.mjs";

// Unrelated legacy surfaces (engine, alias, component format). Reported, not
// gate input: they count paths outside the ADR-046 cutover.
export const LEGACY_COUNTERS = [
  "legacy.workflowEngineUsed",
  "legacy.uokFallbackUsed",
  "legacy.mcpAliasUsed",
  "legacy.componentFormatUsed",
  "legacy.providerDefaultUsed",
];

// The ADR-046 cutover bridges (legacy-telemetry.ts CUTOVER_COUNTERS). Gate
// input: every counter must be present, finite, and zero in the closeout
// evidence run. The acceptance bed is NOT part of this zero assertion: it
// seeds its fixture through the recover import bridge by design, so its
// evidence is held to the declared-and-finite bar instead.
export const CUTOVER_COUNTERS = [
  "legacy.importApplied",
  "legacy.fileOverridesImported",
  "legacy.fileCapturesImported",
  "legacy.restoreExecuted",
  "legacy.migrateImported",
];

// Legacy writes on the canonical path (legacy-telemetry.ts MIRROR_COUNTERS):
// declared, reported, never zero-gated.
export const MIRROR_COUNTERS = [
  "legacy.legacyTaskStatusWrite",
];

// Branches the cutover deleted (wave 2, #2677, and earlier packages). They
// have no counters because they do not exist; the proof that they stay gone
// is structural: the symbols must grep to zero across code directories.
export const DELETED_SYMBOLS = [
  "gsd_verdict",
  "skipBrowserEvidenceGate",
  "allowPassThroughValidation",
  "passThroughValidation",
  "renderAssessmentFromDb",
  "writeGsdProjection",
];

const DELETED_SYMBOL_SCAN_DIRS = ["src", "packages", "tests", "extensions", "scripts", "web"];
const DELETED_SYMBOL_SKIP = new Set([
  "node_modules", "dist", "dist-test", ".git", "coverage", ".turbo", "build",
]);
// The proof sees its own declaration and test sites as text matches. A
// regression only matters in production code, so test files and the prover
// scripts are out of scope.
const DELETED_SYMBOL_SELF_FILES = new Set([
  "legacy-cleanup-gate.mjs",
  "g8-closeout-legacy-gate.mjs",
  "legacy-cleanup-evidence.mjs",
]);

// Persisted telemetry older than this no longer describes the current tree.
export const DEFAULT_MAX_TELEMETRY_AGE_MS = 24 * 60 * 60 * 1000;

export function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const opts = {
    file: env.GSD_LEGACY_TELEMETRY_FILE ?? "",
    json: false,
    maxAgeMs: DEFAULT_MAX_TELEMETRY_AGE_MS,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      opts.json = true;
      continue;
    }
    if (arg === "--file") {
      const value = argv[i + 1];
      if (!value) throw new Error("--file requires a path");
      opts.file = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--file=")) {
      opts.file = arg.slice("--file=".length);
      continue;
    }
    if (arg === "--max-age-ms" || arg.startsWith("--max-age-ms=")) {
      const value = arg.startsWith("--max-age-ms=") ? arg.slice("--max-age-ms=".length) : argv[++i];
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) throw new Error("--max-age-ms requires a non-negative number");
      opts.maxAgeMs = parsed;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!opts.file.trim()) {
    throw new Error("No telemetry file provided. Pass --file or set GSD_LEGACY_TELEMETRY_FILE.");
  }
  return opts;
}

export async function readTelemetryReport(file) {
  const raw = await readFile(file, "utf-8");
  const parsed = JSON.parse(raw);
  const counters = parsed?.counters;
  if (!counters || typeof counters !== "object") {
    throw new Error("Telemetry report is missing counters");
  }
  return {
    ts: typeof parsed.ts === "string" ? parsed.ts : "",
    counters,
  };
}

// Fail-closed loader: a missing file is not "zero usage", and a report that
// predates this run (or is older than maxAgeMs) is not evidence about the
// current tree. Both throw instead of yielding a green report.
export async function loadTelemetryEvidence(file, opts = {}) {
  let report;
  try {
    report = await readTelemetryReport(file);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`telemetry evidence missing — cannot prove zero usage: ${file}`);
    }
    throw error;
  }

  const ts = Date.parse(report.ts);
  if (!Number.isFinite(ts)) {
    throw new Error(`telemetry evidence stale — report has no parseable timestamp: ${file}`);
  }
  if (typeof opts.notBeforeMs === "number" && ts < opts.notBeforeMs) {
    throw new Error(`telemetry evidence stale — report ts ${report.ts} predates this evidence run`);
  }
  if (typeof opts.maxAgeMs === "number") {
    const now = typeof opts.now === "number" ? opts.now : Date.now();
    if (now - ts > opts.maxAgeMs) {
      throw new Error(`telemetry evidence stale — report ts ${report.ts} is older than ${opts.maxAgeMs}ms`);
    }
  }

  return report;
}

/**
 * Structural proof that the deleted cutover branches stay deleted: every
 * symbol in DELETED_SYMBOLS must appear zero times in the scanned code
 * directories. Text scan, code files only; docs are history, not code.
 */
export async function collectDeletedSymbolProof({ root = process.cwd(), symbols = DELETED_SYMBOLS } = {}) {
  const offenders = [];
  let scannedFiles = 0;
  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (DELETED_SYMBOL_SKIP.has(entry.name)) continue;
        await walk(full);
        continue;
      }
      if (!/\.(ts|tsx|mts|cts|mjs|cjs|js|jsx|vue|svelte)$/.test(entry.name)) continue;
      if (DELETED_SYMBOL_SELF_FILES.has(entry.name)) continue;
      if (/(^|[\\/])tests?([\\/]|$)/.test(full.slice(root.length)) || /\.test\./.test(entry.name)) continue;
      let content;
      try {
        content = await readFile(full, "utf-8");
      } catch {
        continue;
      }
      scannedFiles += 1;
      const lines = content.split("\n");
      for (const symbol of symbols) {
        lines.forEach((line, index) => {
          if (line.includes(symbol)) offenders.push({ symbol, file: full, line: index + 1 });
        });
      }
    }
  };
  for (const dir of DELETED_SYMBOL_SCAN_DIRS) {
    await walk(join(root, dir));
  }
  return { ok: offenders.length === 0, scannedFiles, offenders };
}

export function renderDeletedSymbolProofSummary(proof) {
  const lines = [
    "Deleted-symbol proof:",
    `- Scanned ${proof.scannedFiles} code files for ${DELETED_SYMBOLS.length} deleted symbols`,
  ];
  if (proof.offenders.length > 0) {
    lines.push("Offenders (deleted branch is back):");
    for (const offender of proof.offenders) {
      lines.push(`- ${offender.symbol} at ${offender.file}:${offender.line}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Lenient bar for evidence runs that legitimately enter a kept bridge (the
 * acceptance bed seeds its fixture through the recover import): every cutover
 * and mirror counter must be declared in the report and finite — declared, not
 * zero. Anything non-finite or missing is a block.
 */
export function evaluateBridgeEvidenceDeclared(report) {
  const counters = {};
  const missing = [];
  for (const counter of [...CUTOVER_COUNTERS, ...MIRROR_COUNTERS]) {
    const value = report.counters[counter];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      counters[counter] = 0;
      missing.push(counter);
      continue;
    }
    counters[counter] = value;
  }
  return { ok: missing.length === 0, counters, missing };
}

export function evaluateLegacyCleanupGate(report, proof = null, deletedSymbolProof = null) {
  const counters = {};
  const nonZero = [];
  const missing = [];

  // Gate input: the cutover counters. Absent, non-finite, or nonzero: block.
  for (const counter of CUTOVER_COUNTERS) {
    const value = report.counters[counter];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      counters[counter] = 0;
      missing.push(counter);
      continue;
    }
    counters[counter] = value;
    if (value !== 0) nonZero.push({ counter, value });
  }

  // Reported only: the five unrelated counters and the canonical-path mirror
  // counters are not gate input. A mirror counter missing from the report is
  // rendered as 0; only CUTOVER_COUNTERS gate on presence.
  const unrelated = {};
  for (const counter of [...LEGACY_COUNTERS, ...MIRROR_COUNTERS]) {
    const value = report.counters[counter];
    unrelated[counter] = typeof value === "number" && Number.isFinite(value) ? value : 0;
  }

  // A gate evaluated without a static proof is not proven clean.
  const proofMissing = proof === null || proof === undefined;
  const proofOffenders = proofMissing ? [] : (proof.offenders ?? []);
  const deletedProofMissing = deletedSymbolProof === null || deletedSymbolProof === undefined;
  const deletedProofOffenders = deletedProofMissing ? [] : (deletedSymbolProof.offenders ?? []);

  return {
    ok: missing.length === 0 && nonZero.length === 0
      && !proofMissing && proofOffenders.length === 0
      && !deletedProofMissing && deletedProofOffenders.length === 0,
    ts: report.ts,
    counters,
    unrelated,
    missing,
    nonZero,
    proofMissing,
    proofOffenders,
    deletedProofMissing,
    deletedProofOffenders,
  };
}

export function renderLegacyCleanupGateSummary(result) {
  const lines = [
    "gsd-pi Legacy Cleanup Gate",
    `Snapshot: ${result.ts || "unknown"}`,
    `Status: ${result.ok ? "PASS" : "BLOCK"}`,
    "",
    "Cutover bridge counters (gate input, must be zero):",
  ];

  for (const counter of CUTOVER_COUNTERS) {
    lines.push(`- ${counter}: ${result.counters[counter] ?? 0}`);
  }

  lines.push("", "Unrelated legacy counters (reported, not gate input):");
  for (const counter of LEGACY_COUNTERS) {
    lines.push(`- ${counter}: ${result.unrelated?.[counter] ?? 0}`);
  }

  if (result.missing.length > 0) {
    lines.push("", "Missing counters:");
    for (const counter of result.missing) lines.push(`- ${counter}`);
  }

  if (result.nonZero.length > 0) {
    lines.push("", "Cleanup blockers:");
    for (const entry of result.nonZero) lines.push(`- ${entry.counter}: ${entry.value}`);
  }

  if (result.proofMissing) {
    lines.push("", "Static state-path proof: NOT RUN (cannot prove zero usage)");
  } else if (result.proofOffenders.length > 0) {
    lines.push("", "Static state-path proof offenders:");
    for (const offender of result.proofOffenders) {
      lines.push(`- ${offender.kind} ${offender.file}:${offender.line}`);
    }
  }

  if (result.deletedProofMissing) {
    lines.push("", "Deleted-symbol proof: NOT RUN (cannot prove the branches stay deleted)");
  } else if (result.deletedProofOffenders.length > 0) {
    lines.push("", "Deleted-symbol proof offenders:");
    for (const offender of result.deletedProofOffenders) {
      lines.push(`- ${offender.symbol} ${offender.file}:${offender.line}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  try {
    const opts = parseArgs();
    const report = await loadTelemetryEvidence(opts.file, { maxAgeMs: opts.maxAgeMs });
    const proof = await collectLegacyStatePathProof({ root: process.cwd() });
    const deletedProof = await collectDeletedSymbolProof({ root: process.cwd() });
    const result = evaluateLegacyCleanupGate(report, proof, deletedProof);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(renderLegacyCleanupGateSummary(result));
      process.stdout.write(renderDeletedSymbolProofSummary(deletedProof));
      process.stdout.write(renderLegacyStatePathProofSummary(proof));
    }
    process.exitCode = result.ok ? 0 : 2;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
