// Project/App: gsd-pi
// File Purpose: Tests for telemetry counters guarding legacy compatibility cleanup.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  getLegacyTelemetryReport,
  getLegacyTelemetry,
  incrementLegacyTelemetry,
  listLegacyTelemetryCounters,
  persistLegacyTelemetrySnapshot,
  resetLegacyTelemetry,
} from "../legacy-telemetry.ts";
import { _resetLogs, peekLogs, setStderrLoggingEnabled } from "../workflow-logger.ts";

test("legacy telemetry exposes every Phase 8 cleanup counter", () => {
  resetLegacyTelemetry();

  assert.deepEqual(listLegacyTelemetryCounters(), [
    "legacy.workflowEngineUsed",
    "legacy.uokFallbackUsed",
    "legacy.mcpAliasUsed",
    "legacy.componentFormatUsed",
    "legacy.providerDefaultUsed",
  ]);
});

test("legacy telemetry increments positive finite amounts only", () => {
  resetLegacyTelemetry();

  incrementLegacyTelemetry("legacy.workflowEngineUsed");
  incrementLegacyTelemetry("legacy.workflowEngineUsed", 2);
  incrementLegacyTelemetry("legacy.workflowEngineUsed", 0);
  incrementLegacyTelemetry("legacy.workflowEngineUsed", Number.NaN);

  assert.equal(getLegacyTelemetry()["legacy.workflowEngineUsed"], 3);
});

test("legacy telemetry emits one actionable diagnostic per counter", () => {
  const previousStderr = setStderrLoggingEnabled(false);
  try {
    resetLegacyTelemetry();
    _resetLogs();

    incrementLegacyTelemetry("legacy.mcpAliasUsed");
    incrementLegacyTelemetry("legacy.mcpAliasUsed");

    const logs = peekLogs();
    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.component, "migration");
    assert.equal(logs[0]?.context?.counter, "legacy.mcpAliasUsed");
    assert.match(logs[0]?.message ?? "", /canonical gsd_\* tool name/);
  } finally {
    _resetLogs();
    resetLegacyTelemetry();
    setStderrLoggingEnabled(previousStderr);
  }
});

test("legacy telemetry can persist an opt-in snapshot file", () => {
  const previousStderr = setStderrLoggingEnabled(false);
  const previousOutput = process.env.GSD_LEGACY_TELEMETRY_FILE;
  const base = mkdtempSync(join(tmpdir(), "gsd-legacy-telemetry-file-"));
  const outputPath = join(base, "runtime", "legacy-telemetry.json");
  try {
    resetLegacyTelemetry();
    _resetLogs();
    process.env.GSD_LEGACY_TELEMETRY_FILE = outputPath;

    incrementLegacyTelemetry("legacy.providerDefaultUsed", 2);

    const report = JSON.parse(readFileSync(outputPath, "utf-8")) as ReturnType<typeof getLegacyTelemetryReport>;
    assert.equal(typeof report.ts, "string");
    assert.equal(report.counters["legacy.providerDefaultUsed"], 2);
  } finally {
    if (previousOutput === undefined) delete process.env.GSD_LEGACY_TELEMETRY_FILE;
    else process.env.GSD_LEGACY_TELEMETRY_FILE = previousOutput;
    _resetLogs();
    resetLegacyTelemetry();
    setStderrLoggingEnabled(previousStderr);
    rmSync(base, { recursive: true, force: true });
  }
});

test("legacy telemetry can persist a zero-use snapshot for deletion gates", () => {
  const previousOutput = process.env.GSD_LEGACY_TELEMETRY_FILE;
  const base = mkdtempSync(join(tmpdir(), "gsd-legacy-zero-telemetry-"));
  const outputPath = join(base, "legacy-telemetry.json");
  try {
    resetLegacyTelemetry();
    process.env.GSD_LEGACY_TELEMETRY_FILE = outputPath;

    persistLegacyTelemetrySnapshot();

    const report = JSON.parse(readFileSync(outputPath, "utf-8")) as ReturnType<typeof getLegacyTelemetryReport>;
    assert.equal(typeof report.ts, "string");
    assert.deepEqual(report.counters, {
      "legacy.workflowEngineUsed": 0,
      "legacy.uokFallbackUsed": 0,
      "legacy.mcpAliasUsed": 0,
      "legacy.componentFormatUsed": 0,
      "legacy.providerDefaultUsed": 0,
    });
  } finally {
    if (previousOutput === undefined) delete process.env.GSD_LEGACY_TELEMETRY_FILE;
    else process.env.GSD_LEGACY_TELEMETRY_FILE = previousOutput;
    resetLegacyTelemetry();
    rmSync(base, { recursive: true, force: true });
  }
});
