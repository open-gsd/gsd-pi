// Project/App: gsd-pi
// File Purpose: Tests the Phase 8 legacy cleanup telemetry gate and its static state-path proof.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const gateModule = await import("../../scripts/legacy-cleanup-gate.mjs");
const proofModule = await import("../../scripts/legacy-state-path-proof.mjs");

const {
  DEFAULT_MAX_TELEMETRY_AGE_MS,
  LEGACY_COUNTERS,
  evaluateLegacyCleanupGate,
  loadTelemetryEvidence,
  parseArgs,
  readTelemetryReport,
  renderLegacyCleanupGateSummary,
} = gateModule;
const { collectLegacyStatePathProof, renderLegacyStatePathProofSummary } = proofModule;

const CLEAN_PROOF = { ok: true, scanned: "src/resources/extensions", offenders: [] };

async function makeProofRoot(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gsd-legacy-state-path-proof-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content, "utf-8");
  }
  return root;
}

test("parseArgs accepts file path from flag or environment", () => {
  assert.deepEqual(parseArgs(["--file", "/tmp/legacy.json"], {}), {
    file: "/tmp/legacy.json",
    json: false,
    maxAgeMs: DEFAULT_MAX_TELEMETRY_AGE_MS,
  });
  assert.deepEqual(parseArgs(["--json", "--max-age-ms=5"], { GSD_LEGACY_TELEMETRY_FILE: "/tmp/from-env.json" }), {
    file: "/tmp/from-env.json",
    json: true,
    maxAgeMs: 5,
  });
  assert.throws(() => parseArgs([], {}), /No telemetry file/);
});

test("evaluateLegacyCleanupGate passes when every counter is zero and the proof is clean", () => {
  const counters = Object.fromEntries(LEGACY_COUNTERS.map((counter: string) => [counter, 0]));

  const result = evaluateLegacyCleanupGate({ ts: "2026-05-04T00:00:00.000Z", counters }, CLEAN_PROOF);

  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.nonZero, []);
  assert.equal(result.proofMissing, false);
});

test("evaluateLegacyCleanupGate blocks when the static proof was not run", () => {
  const counters = Object.fromEntries(LEGACY_COUNTERS.map((counter: string) => [counter, 0]));

  const result = evaluateLegacyCleanupGate({ ts: "snapshot", counters });

  assert.equal(result.ok, false);
  assert.equal(result.proofMissing, true);
});

test("evaluateLegacyCleanupGate blocks on static proof offenders", () => {
  const counters = Object.fromEntries(LEGACY_COUNTERS.map((counter: string) => [counter, 0]));
  const offenders = [{ kind: "parsersLegacyImporter", file: "src/a.ts", line: 3, text: "import x" }];

  const result = evaluateLegacyCleanupGate({ ts: "snapshot", counters }, { ok: false, offenders });

  assert.equal(result.ok, false);
  assert.deepEqual(result.proofOffenders, offenders);
});

test("evaluateLegacyCleanupGate blocks on nonzero or missing counters", () => {
  const counters = Object.fromEntries(LEGACY_COUNTERS.map((counter: string) => [counter, 0]));
  delete counters["legacy.uokFallbackUsed"];
  counters["legacy.mcpAliasUsed"] = 2;

  const result = evaluateLegacyCleanupGate({ ts: "snapshot", counters }, CLEAN_PROOF);

  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["legacy.uokFallbackUsed"]);
  assert.deepEqual(result.nonZero, [{ counter: "legacy.mcpAliasUsed", value: 2 }]);
});

test("readTelemetryReport parses persisted snapshot files", async () => {
  const root = await mkdtemp(join(tmpdir(), "gsd-legacy-cleanup-gate-"));
  const path = join(root, "nested", "legacy-telemetry.json");
  await mkdir(join(root, "nested"), { recursive: true });
  const counters = Object.fromEntries(LEGACY_COUNTERS.map((counter: string) => [counter, 0]));
  await writeFile(path, JSON.stringify({ ts: "snapshot", counters }), "utf-8");

  const report = await readTelemetryReport(path);

  assert.equal(report.ts, "snapshot");
  assert.equal(report.counters["legacy.providerDefaultUsed"], 0);
});

test("loadTelemetryEvidence fails closed on missing, unparseable, and aged reports", async () => {
  const root = await mkdtemp(join(tmpdir(), "gsd-legacy-cleanup-evidence-load-"));
  const counters = Object.fromEntries(LEGACY_COUNTERS.map((counter: string) => [counter, 0]));

  await assert.rejects(loadTelemetryEvidence(join(root, "absent.json")), /telemetry evidence missing/);

  const unparseable = join(root, "unparseable.json");
  await writeFile(unparseable, JSON.stringify({ ts: "snapshot", counters }), "utf-8");
  await assert.rejects(loadTelemetryEvidence(unparseable), /no parseable timestamp/);

  const aged = join(root, "aged.json");
  await writeFile(aged, JSON.stringify({ ts: "2020-01-01T00:00:00.000Z", counters }), "utf-8");
  await assert.rejects(loadTelemetryEvidence(aged, { maxAgeMs: 1000 }), /older than/);
  await assert.rejects(loadTelemetryEvidence(aged, { notBeforeMs: Date.now() }), /predates this evidence run/);

  const fresh = join(root, "fresh.json");
  await writeFile(fresh, JSON.stringify({ ts: new Date().toISOString(), counters }), "utf-8");
  const report = await loadTelemetryEvidence(fresh, { maxAgeMs: DEFAULT_MAX_TELEMETRY_AGE_MS });
  assert.equal(report.counters["legacy.mcpAliasUsed"], 0);
});

// The proof keys on the relocated legacy parser SYMBOLS, not only on the
// `parsers-legacy` module specifier: T012 moved parseLegacyRoadmap/parseLegacyPlan
// byte-identically to schemas/parsers.ts, so a specifier-only proof would be
// satisfied by a rename while the legacy read path is still in production use.
test("collectLegacyStatePathProof reports production callers, importers, and relocated-symbol consumers", async () => {
  const root = await makeProofRoot({
    "src/resources/extensions/gsd/offender.ts":
      "import { parseRoadmap } from './parsers-legacy.js';\nexport const s = await _deriveStateImpl(base);\n",
    // Specifier alone on its own line (multi-line import) — missed by a
    // line-scoped `from '…'` regex.
    "src/resources/extensions/gsd/own-line.ts":
      "import {\n  parseRoadmap,\n} from\n  './parsers-legacy.js';\n",
    "src/resources/extensions/gsd/parsers-legacy.ts": "export function parseRoadmap() {}\n",
    // Block comment naming both bans: prose is not usage.
    "src/resources/extensions/gsd/prose.ts":
      "/*\n * parseLegacyRoadmap once lived here.\n * import './parsers-legacy.js';\n */\nexport const noop = 0;\n",
    // The rename the wave performed: same functions, new import path.
    "src/resources/extensions/gsd/relocated.ts":
      "import { parseLegacyPlan } from './schemas/parsers.js';\nexport const t = parseLegacyPlan(raw);\n",
    "src/resources/extensions/gsd/schemas/parsers.ts":
      "export function parseLegacyRoadmap() {}\nexport function parseLegacyPlan() {}\n",
    // Side-effect import form (no `from`).
    "src/resources/extensions/gsd/side-effect.ts": "import './parsers-legacy.js';\n",
    "src/resources/extensions/gsd/state.ts": "export async function _deriveStateImpl(base: string) { return base; }\n",
    "src/resources/extensions/gsd/tests/legacy.test.ts":
      "import { parseRoadmap } from '../parsers-legacy.js';\nawait _deriveStateImpl(base);\nparseLegacyPlan(raw);\n",
  });

  const result = await collectLegacyStatePathProof({ root });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.offenders.map((o: { kind: string; file: string; line: number }) => [o.kind, o.file, o.line]),
    [
      ["parsersLegacyImporter", "src/resources/extensions/gsd/offender.ts", 1],
      ["deriveStateImplCaller", "src/resources/extensions/gsd/offender.ts", 2],
      ["parsersLegacyImporter", "src/resources/extensions/gsd/own-line.ts", 4],
      ["legacyParserSymbol", "src/resources/extensions/gsd/relocated.ts", 1],
      ["legacyParserSymbol", "src/resources/extensions/gsd/relocated.ts", 2],
      ["parsersLegacyImporter", "src/resources/extensions/gsd/side-effect.ts", 1],
    ],
  );
  assert.match(renderLegacyStatePathProofSummary(result), /Status: BLOCK/);
});

test("collectLegacyStatePathProof passes when no production caller, importer, or symbol consumer remains", async () => {
  const root = await makeProofRoot({
    "src/resources/extensions/gsd/state.ts":
      "// legacy filesystem fallback in _deriveStateImpl only\nexport async function _deriveStateImpl(base: string) { return base; }\n",
    "src/resources/extensions/gsd/schemas/parsers.ts": "export function parseLegacyRoadmap() {}\n",
    "src/resources/extensions/gsd/tests/legacy.test.ts":
      "await _deriveStateImpl(base);\nparseLegacyRoadmap(raw);\n",
  });

  const result = await collectLegacyStatePathProof({ root });

  assert.equal(result.ok, true);
  assert.deepEqual(result.offenders, []);
  assert.match(renderLegacyStatePathProofSummary(result), /Status: PASS/);
});

test("the live repository proof is green — the legacy read path is gone", async () => {
  const result = await collectLegacyStatePathProof({ root: process.cwd() });

  const files = [...new Set(result.offenders.map((o: { file: string }) => o.file))].sort();

  assert.equal(result.ok, true, `legacy state-path offenders remain:\n  ${files.join("\n  ")}`);
  assert.deepEqual(result.offenders, []);
});

test("renderLegacyCleanupGateSummary includes blockers", () => {
  const counters = Object.fromEntries(LEGACY_COUNTERS.map((counter: string) => [counter, 0]));
  counters["legacy.componentFormatUsed"] = 1;
  const result = evaluateLegacyCleanupGate({ ts: "snapshot", counters }, CLEAN_PROOF);

  const summary = renderLegacyCleanupGateSummary(result);

  assert.match(summary, /Status: BLOCK/);
  assert.match(summary, /legacy\.componentFormatUsed: 1/);
});
