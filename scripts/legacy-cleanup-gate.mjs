// Project/App: gsd-pi
// File Purpose: Checks persisted Phase 8 legacy telemetry plus the static
// state-path proof before cleanup deletions. Fails closed: absent or stale
// evidence blocks, it never counts as proof of zero usage.

import { readFile } from "node:fs/promises";

import { collectLegacyStatePathProof, renderLegacyStatePathProofSummary } from "./legacy-state-path-proof.mjs";

export const LEGACY_COUNTERS = [
  "legacy.workflowEngineUsed",
  "legacy.uokFallbackUsed",
  "legacy.mcpAliasUsed",
  "legacy.componentFormatUsed",
  "legacy.providerDefaultUsed",
];

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

export function evaluateLegacyCleanupGate(report, proof = null) {
  const counters = {};
  const nonZero = [];
  const missing = [];

  for (const counter of LEGACY_COUNTERS) {
    const value = report.counters[counter];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      counters[counter] = 0;
      missing.push(counter);
      continue;
    }
    counters[counter] = value;
    if (value !== 0) nonZero.push({ counter, value });
  }

  // A gate evaluated without a static proof is not proven clean.
  const proofMissing = proof === null || proof === undefined;
  const proofOffenders = proofMissing ? [] : (proof.offenders ?? []);

  return {
    ok: missing.length === 0 && nonZero.length === 0 && !proofMissing && proofOffenders.length === 0,
    ts: report.ts,
    counters,
    missing,
    nonZero,
    proofMissing,
    proofOffenders,
  };
}

export function renderLegacyCleanupGateSummary(result) {
  const lines = [
    "gsd-pi Legacy Cleanup Gate",
    `Snapshot: ${result.ts || "unknown"}`,
    `Status: ${result.ok ? "PASS" : "BLOCK"}`,
    "",
    "Counters:",
  ];

  for (const counter of LEGACY_COUNTERS) {
    lines.push(`- ${counter}: ${result.counters[counter] ?? 0}`);
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

  return `${lines.join("\n")}\n`;
}

async function main() {
  try {
    const opts = parseArgs();
    const report = await loadTelemetryEvidence(opts.file, { maxAgeMs: opts.maxAgeMs });
    const proof = await collectLegacyStatePathProof({ root: process.cwd() });
    const result = evaluateLegacyCleanupGate(report, proof);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(renderLegacyCleanupGateSummary(result));
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
