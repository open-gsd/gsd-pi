// Project/App: gsd-pi
// File Purpose: Tests the Phase 8 legacy cleanup telemetry gate, its static
// state-path proof, the deleted-symbol structural proof, and the G8 closeout
// gate inputs.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const gateModule = await import("../../scripts/legacy-cleanup-gate.mjs");
const proofModule = await import("../../scripts/legacy-state-path-proof.mjs");
const g8Module = await import("../../scripts/g8-closeout-legacy-gate.mjs");

const {
  DEFAULT_MAX_TELEMETRY_AGE_MS,
  LEGACY_COUNTERS,
  CUTOVER_COUNTERS,
  DELETED_SYMBOLS,
  collectDeletedSymbolProof,
  evaluateLegacyCleanupGate,
  loadTelemetryEvidence,
  parseArgs,
  readTelemetryReport,
  renderDeletedSymbolProofSummary,
  renderLegacyCleanupGateSummary,
} = gateModule;
const { collectLegacyStatePathProof, renderLegacyStatePathProofSummary } = proofModule;

const CLEAN_PROOF = { ok: true, scanned: "src/resources/extensions", offenders: [] };
const CLEAN_DELETED_PROOF = { ok: true, scannedFiles: 10, offenders: [] };

function allCounters(): Record<string, number> {
  return Object.fromEntries([...LEGACY_COUNTERS, ...CUTOVER_COUNTERS].map((counter: string) => [counter, 0]));
}

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

test("evaluateLegacyCleanupGate passes when every cutover counter is zero and both proofs are clean", () => {
  const result = evaluateLegacyCleanupGate(
    { ts: "2026-05-04T00:00:00.000Z", counters: allCounters() },
    CLEAN_PROOF,
    CLEAN_DELETED_PROOF,
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.nonZero, []);
  assert.equal(result.proofMissing, false);
  assert.equal(result.deletedProofMissing, false);
});

test("evaluateLegacyCleanupGate gates on the cutover counters, not the unrelated five", () => {
  // A nonzero unrelated counter is reported but never blocks.
  const counters = allCounters();
  counters["legacy.mcpAliasUsed"] = 3;

  const reported = evaluateLegacyCleanupGate({ ts: "snapshot", counters }, CLEAN_PROOF, CLEAN_DELETED_PROOF);
  assert.equal(reported.ok, true);
  assert.equal(reported.unrelated["legacy.mcpAliasUsed"], 3);

  // The same nonzero value on a cutover counter blocks.
  counters["legacy.importApplied"] = 1;
  const blocked = evaluateLegacyCleanupGate({ ts: "snapshot", counters }, CLEAN_PROOF, CLEAN_DELETED_PROOF);
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.nonZero, [{ counter: "legacy.importApplied", value: 1 }]);
});

test("mirror counters are declared and reported but never zero-gated", () => {
  const counters = allCounters();
  counters["legacy.legacyTaskStatusWrite"] = 7;

  const result = evaluateLegacyCleanupGate({ ts: "snapshot", counters }, CLEAN_PROOF, CLEAN_DELETED_PROOF);

  assert.equal(result.ok, true);
  assert.equal(result.unrelated["legacy.legacyTaskStatusWrite"], 7);
  assert.deepEqual(result.nonZero, []);
});

test("evaluateBridgeEvidenceDeclared accepts nonzero bridge traffic but blocks undeclared counters", () => {
  const { evaluateBridgeEvidenceDeclared } = gateModule;
  const counters = allCounters();
  counters["legacy.importApplied"] = 2;
  counters["legacy.legacyTaskStatusWrite"] = 5;

  const accepts = evaluateBridgeEvidenceDeclared({ ts: "snapshot", counters });
  assert.equal(accepts.ok, true);
  assert.equal(accepts.counters["legacy.importApplied"], 2);

  const blocks = evaluateBridgeEvidenceDeclared({ ts: "snapshot", counters: { "legacy.importApplied": 1 } });
  assert.equal(blocks.ok, false);
  assert.ok(blocks.missing.includes("legacy.migrateImported"));
});

test("evaluateLegacyCleanupGate blocks when the static proof was not run", () => {
  const result = evaluateLegacyCleanupGate({ ts: "snapshot", counters: allCounters() }, undefined, CLEAN_DELETED_PROOF);

  assert.equal(result.ok, false);
  assert.equal(result.proofMissing, true);
});

test("evaluateLegacyCleanupGate blocks when the deleted-symbol proof was not run", () => {
  const result = evaluateLegacyCleanupGate({ ts: "snapshot", counters: allCounters() }, CLEAN_PROOF, undefined);

  assert.equal(result.ok, false);
  assert.equal(result.deletedProofMissing, true);
});

test("evaluateLegacyCleanupGate blocks on static proof offenders", () => {
  const offenders = [{ kind: "parsersLegacyImporter", file: "src/a.ts", line: 3, text: "import x" }];

  const result = evaluateLegacyCleanupGate(
    { ts: "snapshot", counters: allCounters() },
    { ok: false, offenders },
    CLEAN_DELETED_PROOF,
  );

  assert.equal(result.ok, false);
  assert.deepEqual(result.proofOffenders, offenders);
});

test("evaluateLegacyCleanupGate blocks on deleted-symbol offenders", () => {
  const offenders = [{ symbol: "gsd_verdict", file: "src/verdict.ts", line: 7 }];

  const result = evaluateLegacyCleanupGate(
    { ts: "snapshot", counters: allCounters() },
    CLEAN_PROOF,
    { ok: false, offenders },
  );

  assert.equal(result.ok, false);
  assert.deepEqual(result.deletedProofOffenders, offenders);
});

test("evaluateLegacyCleanupGate blocks on nonzero or missing cutover counters", () => {
  const counters = allCounters();
  delete counters["legacy.restoreExecuted"];
  counters["legacy.migrateImported"] = 2;

  const result = evaluateLegacyCleanupGate({ ts: "snapshot", counters }, CLEAN_PROOF, CLEAN_DELETED_PROOF);

  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["legacy.restoreExecuted"]);
  assert.deepEqual(result.nonZero, [{ counter: "legacy.migrateImported", value: 2 }]);
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
  const counters = allCounters();
  counters["legacy.importApplied"] = 1;
  const result = evaluateLegacyCleanupGate({ ts: "snapshot", counters }, CLEAN_PROOF, CLEAN_DELETED_PROOF);

  const summary = renderLegacyCleanupGateSummary(result);

  assert.match(summary, /Status: BLOCK/);
  assert.match(summary, /legacy\.importApplied: 1/);
});

// ─── Deleted-symbol structural proof ─────────────────────────────────────────

test("collectDeletedSymbolProof reports code occurrences and skips docs and node_modules", async () => {
  const root = await makeProofRoot({
    "src/offender.ts": "const cmd = \"gsd_verdict\";\n",
    "src/clean.ts": "export const ok = 1;\n",
    "docs/history.md": "the deleted /gsd verdict command\n",
    "node_modules/pkg/index.js": "skipBrowserEvidenceGate();\n",
    "dist/out.js": "allowPassThroughValidation();\n",
    "notes.txt": "renderAssessmentFromDb in prose\n",
  });

  const result = await collectDeletedSymbolProof({ root });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.offenders.map((o: { symbol: string; file: string; line: number }) => [o.symbol, o.line]),
    [["gsd_verdict", 1]],
  );
  assert.match(renderDeletedSymbolProofSummary(result), /gsd_verdict/);
});

test("collectDeletedSymbolProof passes on a clean tree", async () => {
  const root = await makeProofRoot({
    "src/clean.ts": "export const ok = 1;\n",
  });

  const result = await collectDeletedSymbolProof({ root });

  assert.equal(result.ok, true);
  assert.deepEqual(result.offenders, []);
});

test("the live repository deleted-symbol proof is green — the deleted branches stay deleted", async () => {
  const result = await collectDeletedSymbolProof({ root: process.cwd() });

  const files = [...new Set(result.offenders.map((o: { file: string }) => o.file))].sort();
  assert.equal(result.ok, true, `deleted-branch symbols reappeared:\n  ${files.join("\n  ")}`);
  assert.deepEqual(result.offenders, []);
  assert.ok(DELETED_SYMBOLS.length >= 5);
});

// ─── G8 closeout gate inputs ─────────────────────────────────────────────────

test("the G8 gate pins four closeout e2e files that exist in the repository", () => {
  assert.equal(g8Module.CLOSEOUT_E2E_FILES.length, 4);
  for (const file of g8Module.CLOSEOUT_E2E_FILES) {
    assert.ok(existsSync(join(process.cwd(), file)), `missing closeout e2e file: ${file}`);
    assert.match(file, /closeout|completion|sequence/);
  }
  assert.ok(existsSync(join(process.cwd(), g8Module.ACCEPTANCE_BED_SCRIPT)));
});

test("the G8 gate fails closed without a smoke binary", () => {
  const previous = process.env.GSD_SMOKE_BINARY;
  delete process.env.GSD_SMOKE_BINARY;
  try {
    assert.throws(() => g8Module.requireSmokeBinary(), /GSD_SMOKE_BINARY is not set/);
  } finally {
    if (previous === undefined) delete process.env.GSD_SMOKE_BINARY;
    else process.env.GSD_SMOKE_BINARY = previous;
  }
});

test("every declared cutover counter is a legacy.* counter with a diagnostics entry", () => {
  const telemetrySource = readFileSync(
    join(process.cwd(), "src/resources/extensions/gsd/legacy-telemetry.ts"),
    "utf-8",
  );
  for (const counter of CUTOVER_COUNTERS) {
    assert.match(counter, /^legacy\./);
    assert.match(telemetrySource, new RegExp(`"${counter}":`));
  }
});
