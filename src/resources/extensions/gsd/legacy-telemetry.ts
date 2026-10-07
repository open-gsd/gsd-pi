// Project/App: gsd-pi
// File Purpose: Runtime counters for telemetry-gated legacy compatibility paths.

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { logWarning } from "./workflow-logger.js";

export type LegacyTelemetryCounter =
  | "legacy.workflowEngineUsed"
  | "legacy.uokFallbackUsed"
  | "legacy.mcpAliasUsed"
  | "legacy.componentFormatUsed"
  | "legacy.providerDefaultUsed"
  // ADR-046 cutover counters (Migration step 8). CUTOVER_COUNTERS count the
  // bridges the program keeps temporarily and that no canonical closeout run
  // may enter: the operator-command imports, the restore, the migrate import,
  // the doctor file blocks. The G8 gate asserts zero on every one of them
  // across the four closeout e2e runs. MIRROR_COUNTERS count legacy writes
  // that are part of the canonical path itself (the tasks.status mirror the
  // replan gate still reads); they are declared and reported, never
  // zero-gated. The five counters above are unrelated legacy surfaces
  // (engine, alias, component format) and are not gate input.
  | "legacy.importApplied"
  | "legacy.fileOverridesImported"
  | "legacy.fileCapturesImported"
  | "legacy.restoreExecuted"
  | "legacy.migrateImported"
  | "legacy.legacyTaskStatusWrite";

export type LegacyTelemetrySnapshot = Record<LegacyTelemetryCounter, number>;

export interface LegacyTelemetryReport {
  ts: string;
  counters: LegacyTelemetrySnapshot;
}

/** The ADR-046 cutover bridges. Zero-gated by the G8 closeout gate. */
export const CUTOVER_COUNTERS = [
  "legacy.importApplied",
  "legacy.fileOverridesImported",
  "legacy.fileCapturesImported",
  "legacy.restoreExecuted",
  "legacy.migrateImported",
] as const satisfies readonly LegacyTelemetryCounter[];

/** Legacy writes on the canonical path. Declared and reported, never zero-gated. */
export const MIRROR_COUNTERS = [
  "legacy.legacyTaskStatusWrite",
] as const satisfies readonly LegacyTelemetryCounter[];

const COUNTERS: LegacyTelemetryCounter[] = [
  "legacy.workflowEngineUsed",
  "legacy.uokFallbackUsed",
  "legacy.mcpAliasUsed",
  "legacy.componentFormatUsed",
  "legacy.providerDefaultUsed",
  ...CUTOVER_COUNTERS,
  ...MIRROR_COUNTERS,
];

const values: LegacyTelemetrySnapshot = Object.fromEntries(
  COUNTERS.map((counter) => [counter, 0]),
) as LegacyTelemetrySnapshot;

const warnedCounters = new Set<LegacyTelemetryCounter>();

const DIAGNOSTICS: Record<LegacyTelemetryCounter, string> = {
  "legacy.workflowEngineUsed": "Deprecated workflow engine path used; prefer auto-milestone workflow templates before removing legacy engines.",
  "legacy.uokFallbackUsed": "Deprecated UOK fallback path used; resolve UOK kernel blockers before removing parity fallback wrappers.",
  "legacy.mcpAliasUsed": "Deprecated MCP alias tool used; update callers to the canonical gsd_* tool name before alias removal.",
  "legacy.componentFormatUsed": "Deprecated component format loaded; migrate skills/agents to component.yaml before removing legacy loaders.",
  "legacy.providerDefaultUsed": "Provider-specific default fallback used without an explicit available model; configure provider-aware model preferences before removing defaults.",
  "legacy.importApplied": "Legacy Import Application ran; file content became DB rows. When the import window closes (ADR-046: 2 releases + 60 days), remove the bridge.",
  "legacy.fileOverridesImported": "File-only OVERRIDES.md blocks were imported by /gsd doctor --fix; remove with the doctor file-import bridge.",
  "legacy.fileCapturesImported": "File-only CAPTURES.md blocks were imported by /gsd doctor --fix; remove with the doctor file-import bridge.",
  "legacy.restoreExecuted": "A pre-import backup was restored (legacy-import-live-restore); the restore window closes with the first later Domain Operation.",
  "legacy.migrateImported": "/gsd migrate imported hierarchy rows through the pre-adoption upsert ELSE arms; remove with the migrate path.",
  "legacy.legacyTaskStatusWrite": "A verified task publication wrote the legacy tasks.status column; remove when the tasks table stops mirroring lifecycle state.",
};

process.once("beforeExit", persistLegacyTelemetry);

export function incrementLegacyTelemetry(counter: LegacyTelemetryCounter, amount = 1): void {
  if (!Number.isFinite(amount) || amount <= 0) return;
  values[counter] += amount;
  emitLegacyDiagnostic(counter);
  persistLegacyTelemetry();
}

export function getLegacyTelemetry(): LegacyTelemetrySnapshot {
  return { ...values };
}

export function resetLegacyTelemetry(): void {
  for (const counter of COUNTERS) {
    values[counter] = 0;
  }
  warnedCounters.clear();
}

export function listLegacyTelemetryCounters(): LegacyTelemetryCounter[] {
  return [...COUNTERS];
}

export function getLegacyTelemetryReport(): LegacyTelemetryReport {
  return {
    ts: new Date().toISOString(),
    counters: getLegacyTelemetry(),
  };
}

export function persistLegacyTelemetrySnapshot(): void {
  persistLegacyTelemetry();
}

function emitLegacyDiagnostic(counter: LegacyTelemetryCounter): void {
  if (warnedCounters.has(counter)) return;
  warnedCounters.add(counter);
  logWarning("migration", DIAGNOSTICS[counter], { counter });
}

function persistLegacyTelemetry(): void {
  const outputPath = process.env.GSD_LEGACY_TELEMETRY_FILE?.trim();
  if (!outputPath) return;

  try {
    // Merge with the file instead of overwriting it: an e2e run or a gate
    // spawns several CLI processes that share one GSD_LEGACY_TELEMETRY_FILE,
    // and a last-writer-wins file would hide a nonzero counter from an
    // earlier process. The baseline is read once per process, so repeated
    // persists from this process do not double-count.
    if (persistedBaseline === null) {
      persistedBaseline = readPersistedCounters(outputPath);
    }
    const baseline = persistedBaseline;
    const merged = Object.fromEntries(
      COUNTERS.map((counter) => [counter, (baseline[counter] ?? 0) + values[counter]]),
    ) as LegacyTelemetrySnapshot;
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify({ ts: new Date().toISOString(), counters: merged }, null, 2)}\n`, "utf-8");
  } catch {
    // Legacy cleanup telemetry must never block runtime paths.
  }
}

let persistedBaseline: Partial<Record<LegacyTelemetryCounter, number>> | null = null;

function readPersistedCounters(outputPath: string): Partial<Record<LegacyTelemetryCounter, number>> {
  try {
    const parsed = JSON.parse(readFileSync(outputPath, "utf-8")) as { counters?: Record<string, unknown> };
    const counters = parsed?.counters;
    if (!counters || typeof counters !== "object") return {};
    return Object.fromEntries(
      Object.entries(counters)
        .filter(([, v]) => typeof v === "number" && Number.isFinite(v) && v > 0)
        .map(([k, v]) => [k as LegacyTelemetryCounter, v as number]),
    );
  } catch {
    return {};
  }
}
