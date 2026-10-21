// Project/App: gsd-pi
// File Purpose: Tests fail-closed telemetry evidence collection before Phase 8 legacy cleanup deletions.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const evidenceModule = await import("../../scripts/legacy-cleanup-evidence.mjs");
const gateModule = await import("../../scripts/legacy-cleanup-gate.mjs");

const { collectLegacyCleanupEvidence, DEFAULT_EVIDENCE_COMMANDS, parseArgs, parseCommandSpec } = evidenceModule;
const { LEGACY_COUNTERS } = gateModule;

async function makeCleanProofRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gsd-legacy-proof-clean-"));
  await mkdir(join(root, "src", "resources", "extensions", "gsd"), { recursive: true });
  await writeFile(join(root, "src", "resources", "extensions", "gsd", "clean.ts"), "export const clean = true;\n", "utf-8");
  return root;
}

test("parseArgs uses default evidence command and accepts explicit commands", () => {
  assert.deepEqual(parseArgs(["--file", "/tmp/legacy.json"], {}).commands, DEFAULT_EVIDENCE_COMMANDS);
  assert.deepEqual(parseArgs(["--file=/tmp/legacy.json", "--command", "[\"node\",\"-e\",\"process.exit(0)\"]"], {}).commands, [
    ["node", "-e", "process.exit(0)"],
  ]);
  assert.throws(() => parseArgs([], {}), /No telemetry file/);
});

test("parseCommandSpec rejects invalid command specs", () => {
  assert.deepEqual(parseCommandSpec("[\"npm\",\"run\",\"baseline:refactor:gate\"]"), [
    "npm",
    "run",
    "baseline:refactor:gate",
  ]);
  assert.throws(() => parseCommandSpec("npm run test"), /JSON string array/);
  assert.throws(() => parseCommandSpec("[]"), /non-empty/);
});

test("no fabrication path exists — a missing telemetry file fails closed", async () => {
  assert.equal((evidenceModule as Record<string, unknown>).ensureTelemetryReport, undefined);

  const root = await mkdtemp(join(tmpdir(), "gsd-legacy-cleanup-missing-"));
  const file = join(root, "nested", "legacy-telemetry.json");

  await assert.rejects(
    collectLegacyCleanupEvidence({
      file,
      json: false,
      commands: [["node", "-e", "process.exit(0)"]],
      proofRoot: await makeCleanProofRoot(),
    }),
    /telemetry evidence missing/,
  );
});

test("telemetry written before this run is rejected as stale", async () => {
  const root = await mkdtemp(join(tmpdir(), "gsd-legacy-cleanup-stale-"));
  const file = join(root, "legacy-telemetry.json");
  const counters = Object.fromEntries(LEGACY_COUNTERS.map((counter: string) => [counter, 0]));
  await writeFile(file, JSON.stringify({ ts: "2020-01-01T00:00:00.000Z", counters }), "utf-8");

  await assert.rejects(
    collectLegacyCleanupEvidence({
      file,
      json: false,
      commands: [["node", "-e", "process.exit(0)"]],
      proofRoot: await makeCleanProofRoot(),
    }),
    /stale/,
  );
});

test("fresh zero telemetry plus a clean static proof passes", async () => {
  const root = await mkdtemp(join(tmpdir(), "gsd-legacy-cleanup-fresh-"));
  const file = join(root, "legacy-telemetry.json");
  const counters = Object.fromEntries(LEGACY_COUNTERS.map((counter: string) => [counter, 0]));
  const writer = `require("node:fs").writeFileSync(process.env.GSD_LEGACY_TELEMETRY_FILE, JSON.stringify({ ts: new Date().toISOString(), counters: ${JSON.stringify(counters)} }))`;

  const result = await collectLegacyCleanupEvidence({
    file,
    json: false,
    commands: [["node", "-e", writer]],
    proofRoot: await makeCleanProofRoot(),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.nonZero, []);
  assert.deepEqual(result.proofOffenders, []);
});

test("collectLegacyCleanupEvidence reports nonzero counters as blockers", async () => {
  const root = await mkdtemp(join(tmpdir(), "gsd-legacy-cleanup-blocked-"));
  const file = join(root, "legacy-telemetry.json");
  const counters = Object.fromEntries(LEGACY_COUNTERS.map((counter: string) => [counter, 0]));
  counters["legacy.workflowEngineUsed"] = 1;
  const writer = `require("node:fs").writeFileSync(process.env.GSD_LEGACY_TELEMETRY_FILE, JSON.stringify({ ts: new Date().toISOString(), counters: ${JSON.stringify(counters)} }))`;

  const result = await collectLegacyCleanupEvidence({
    file,
    json: false,
    commands: [["node", "-e", writer]],
    proofRoot: await makeCleanProofRoot(),
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.nonZero, [{ counter: "legacy.workflowEngineUsed", value: 1 }]);
});
