// Project/App: gsd-pi
// File Purpose: Exact retained-byte integration contract for unified supplemental legacy interpretation.

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import type {
  LegacyImportPreviewDiagnosis,
  LegacyImportPreviewEnvelope,
  LegacyImportPreviewResolution,
  LegacyImportPreviewSource,
} from "../legacy-import-contract.ts";
import {
  collectLegacyImportDatabaseTargetEvidence,
  LegacyImportDatabaseTargetError,
} from "../legacy-import-preview-database-target.ts";
import { inspectLegacyImportDatabaseTarget, LegacyImportDatabaseTargetInspectionError } from "../legacy-import-database-target-inspector.ts";
import type { LegacyImportInterpretation } from "../legacy-import-preview-interpretation.ts";
import {
  captureLegacyImportSourceSet,
  type LegacyImportSourceCapture,
  type LegacyImportSourceRoot,
} from "../legacy-import-preview-source.ts";
import { interpretLegacySupplementalCapture } from "../legacy-import-preview-supplemental.ts";
import {
  canonicalLegacyImportJson,
  hashLegacyImportBytes,
  hashLegacyImportValue,
} from "../legacy-import-preview.ts";
import { loadLegacyImportCorpusCase } from "./helpers/legacy-import-corpus.ts";

const CORPUS_ROOT = new URL("./__fixtures__/legacy-import-corpus/v1/", import.meta.url);
const COMPOSITE_PATHS = [
  ".gsd-worktrees/M008/git-marker.txt",
  ".gsd/KNOWLEDGE.md",
  ".gsd/event-log.jsonl",
  ".gsd/gsd.db",
  ".gsd/workflow-runs/capstone/run-001/GRAPH.yaml",
  ".gsd/workflows/capstone.yaml",
] as const;

interface RootSpec {
  physical: string;
  logical: string;
  kind: LegacyImportSourceRoot["kind"];
}

interface CaseSpec {
  name: string;
  roots: readonly RootSpec[] | "top-level";
  bundledDefinitionNames?: readonly string[];
}

const CASES: readonly CaseSpec[] = [
  {
    name: "jsonl-history",
    roots: [
      { physical: ".gsd", logical: ".gsd", kind: "project" },
      { physical: ".gsd-worktrees", logical: ".gsd-worktrees", kind: "worktree" },
      {
        physical: "$GSD_STATE_DIR/projects/project-a",
        logical: "$GSD_STATE_DIR/projects/project-a",
        kind: "external",
      },
    ],
  },
  {
    name: "custom-workflow",
    roots: [
      { physical: ".gsd", logical: ".gsd", kind: "project" },
      { physical: "gsd-home", logical: "gsd-home", kind: "external" },
    ],
    bundledDefinitionNames: ["bugfix"],
  },
  { name: "knowledge-graph", roots: [{ physical: ".gsd", logical: ".gsd", kind: "project" }] },
  { name: "worktree-topology", roots: "top-level" },
  {
    name: "root-external-boundaries",
    roots: [
      { physical: ".gsd", logical: ".gsd", kind: "project" },
      {
        physical: "$GSD_STATE_DIR/projects/project-external",
        logical: "$GSD_STATE_DIR/projects/project-external",
        kind: "external",
      },
    ],
  },
];

function compareCanonical(left: unknown, right: unknown): number {
  const leftJson = canonicalLegacyImportJson(left);
  const rightJson = canonicalLegacyImportJson(right);
  return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
}

function temporaryDirectory(t: { after(fn: () => void): void }): string {
  const path = mkdtempSync(join(tmpdir(), "gsd-preview-supplemental-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function fixtureFingerprint(caseName: string): unknown[] {
  return loadLegacyImportCorpusCase(CORPUS_ROOT, caseName).files.map((file) => [
    file.path,
    file.entryKind,
    file.byteSize,
    file.sha256,
  ]);
}

function sourceRoots(source: string, specs: CaseSpec["roots"]): LegacyImportSourceRoot[] {
  const roots = specs === "top-level"
    ? readdirSync(source).sort().map((name): RootSpec => ({ physical: name, logical: name, kind: "project" }))
    : specs;
  return roots.map((root, index) => ({
    id: `source-${index + 1}`,
    kind: root.kind,
    physical_path: join(source, root.physical),
    logical_path: root.logical,
    presence: "required",
  }));
}

function captureCase(
  t: { after(fn: () => void): void },
  spec: CaseSpec,
): { capture: LegacyImportSourceCapture; oracle: LegacyImportPreviewEnvelope } {
  const source = join(temporaryDirectory(t), "source");
  cpSync(fileURLToPath(new URL(`./${spec.name}/source`, CORPUS_ROOT)), source, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });
  const capture = captureLegacyImportSourceSet({ roots: sourceRoots(source, spec.roots) });
  rmSync(source, { recursive: true, force: true });
  assert.equal(existsSync(source), false, `${spec.name}: copied source removed before interpretation`);
  return { capture, oracle: loadLegacyImportCorpusCase(CORPUS_ROOT, spec.name).oracle };
}

function captureComposite(
  t: { after(fn: () => void): void },
): { capture: LegacyImportSourceCapture; oracle: LegacyImportPreviewEnvelope } {
  const source = join(temporaryDirectory(t), "source");
  const fixture = fileURLToPath(new URL("./composite-capstone/source", CORPUS_ROOT));
  for (const path of COMPOSITE_PATHS) {
    cpSync(join(fixture, path), join(source, path), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
    });
  }
  const capture = captureLegacyImportSourceSet({
    roots: sourceRoots(source, [
      { physical: ".gsd", logical: ".gsd", kind: "project" },
      { physical: ".gsd-worktrees", logical: ".gsd-worktrees", kind: "worktree" },
    ]),
  });
  rmSync(source, { recursive: true, force: true });
  assert.equal(existsSync(source), false, "composite: copied source removed before interpretation");
  return { capture, oracle: loadLegacyImportCorpusCase(CORPUS_ROOT, "composite-capstone").oracle };
}

function captureUnknownSupplementalSource(
  t: { after(fn: () => void): void },
): LegacyImportSourceCapture {
  const source = join(temporaryDirectory(t), ".gsd");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "UNKNOWN.bin"), Buffer.from([0xff, 0x00, 0x01]));
  const capture = captureLegacyImportSourceSet({
    roots: [{
      id: "unknown",
      kind: "project",
      physical_path: source,
      logical_path: ".gsd",
      presence: "required",
    }],
  });
  rmSync(source, { recursive: true, force: true });
  return capture;
}

function sourcePaths(sources: readonly LegacyImportPreviewSource[]): Map<string, string> {
  return new Map(sources.map((source) => [source.source_id, source.path]));
}

function normalizedSources(sources: readonly LegacyImportPreviewSource[]): unknown[] {
  return sources.map(({ source_id: _sourceId, ...source }) => source);
}

function normalizedCandidates(
  candidates: LegacyImportInterpretation["candidates"] | LegacyImportPreviewEnvelope["changes"],
  paths: ReadonlyMap<string, string>,
): unknown[] {
  return candidates.map((candidate) => ({
    classification: candidateClassification(candidate),
    target: candidate.target,
    raw: { ...candidate.raw, source_id: paths.get(candidate.raw.source_id) ?? candidate.raw.source_id },
    normalized: candidate.normalized,
    provenance: {
      ...candidate.provenance,
      source_id: paths.get(candidate.provenance.source_id) ?? candidate.provenance.source_id,
    },
    reason_code: candidate.reason_code,
  })).sort(compareCanonical);
}

function candidateClassification(
  candidate: LegacyImportInterpretation["candidates"][number] | LegacyImportPreviewEnvelope["changes"][number],
): "compare" | "preserve" {
  if (!("action" in candidate)) return candidate.classification;
  return candidate.action === "preserve" ? "preserve" : "compare";
}

function diagnosisKey(
  diagnosis: LegacyImportPreviewDiagnosis,
  paths: ReadonlyMap<string, string>,
): string {
  return canonicalLegacyImportJson({
    code: diagnosis.code,
    source: paths.get(diagnosis.source_id) ?? diagnosis.source_id,
    locator: diagnosis.locator,
  });
}

function normalizedDiagnoses(
  diagnoses: readonly LegacyImportPreviewDiagnosis[],
  paths: ReadonlyMap<string, string>,
): unknown[] {
  return diagnoses.map(({ diagnosis_id: _diagnosisId, source_id: sourceId, ...diagnosis }) => ({
    ...diagnosis,
    source_id: paths.get(sourceId) ?? sourceId,
  })).sort(compareCanonical);
}

function normalizedResolutions(
  resolutions: readonly LegacyImportPreviewResolution[],
  diagnoses: readonly LegacyImportPreviewDiagnosis[],
  paths: ReadonlyMap<string, string>,
): unknown[] {
  const keys = new Map(diagnoses.map((diagnosis) => [
    diagnosis.diagnosis_id,
    diagnosisKey(diagnosis, paths),
  ]));
  return resolutions.map((resolution) => ({
    diagnosis: keys.get(resolution.diagnosis_id) ?? resolution.diagnosis_id,
    disposition: resolution.disposition,
    ...(resolution.target === undefined ? {} : { target: resolution.target }),
  })).sort(compareCanonical);
}

function assertOracleSemantics(
  interpretation: LegacyImportInterpretation,
  oracle: LegacyImportPreviewEnvelope,
): void {
  const actualPaths = sourcePaths(interpretation.sources);
  const expectedPaths = sourcePaths(oracle.sources);
  assert.deepEqual(normalizedSources(interpretation.sources), normalizedSources(oracle.sources));
  assert.deepEqual(
    normalizedCandidates(interpretation.candidates, actualPaths),
    normalizedCandidates(oracle.changes, expectedPaths),
  );
  assert.deepEqual(
    normalizedDiagnoses(interpretation.diagnoses, actualPaths),
    normalizedDiagnoses(oracle.diagnoses, expectedPaths),
  );
  assert.deepEqual(
    normalizedResolutions(interpretation.resolutions, interpretation.diagnoses, actualPaths),
    normalizedResolutions(oracle.resolutions, oracle.diagnoses, expectedPaths),
  );
}

function payloadBytes(capture: LegacyImportSourceCapture, path: string): Buffer {
  const entry = capture.entries.find((candidate) => candidate.logical_path === path);
  assert.ok(entry?.payload_id, `${path}: retained payload`);
  const payload = capture.payloads.find((candidate) => candidate.payload_id === entry.payload_id);
  assert.ok(payload, `${path}: retained bytes`);
  return Buffer.from(payload.bytes_base64, "base64");
}

function assertDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

function assertRuntimeIdentity(
  capture: LegacyImportSourceCapture,
  interpretation: LegacyImportInterpretation,
): void {
  const sourceIds = new Set(interpretation.sources.map((source) => source.source_id));
  const pathBySource = new Map(interpretation.sources.map((source) => [source.source_id, source.path]));
  for (const candidate of interpretation.candidates) {
    assert.ok(sourceIds.has(candidate.raw.source_id));
    assert.equal(candidate.raw.source_id, candidate.provenance.source_id);
    const { candidate_id: _candidateId, ordinal: _ordinal, ...identity } = candidate;
    assert.equal(candidate.candidate_id, hashLegacyImportValue(identity));
    const path = pathBySource.get(candidate.raw.source_id)!;
    const bytes = payloadBytes(capture, path).subarray(
      candidate.raw.locator.start_byte,
      candidate.raw.locator.end_byte,
    );
    assert.equal(candidate.raw.sha256, hashLegacyImportBytes(bytes));
  }
  for (const diagnosis of interpretation.diagnoses) {
    assert.ok(sourceIds.has(diagnosis.source_id));
    const { diagnosis_id: _diagnosisId, ...identity } = diagnosis;
    assert.equal(diagnosis.diagnosis_id, hashLegacyImportValue(identity));
    const path = pathBySource.get(diagnosis.source_id)!;
    const bytes = payloadBytes(capture, path);
    assert.ok(diagnosis.locator.start_byte >= 0);
    assert.ok(diagnosis.locator.end_byte !== undefined && diagnosis.locator.end_byte <= bytes.length);
  }
  assert.deepEqual(
    interpretation.candidates.map((candidate) => candidate.ordinal),
    interpretation.candidates.map((_candidate, index) => index + 1),
  );
  assert.deepEqual(
    interpretation.resolutions.map((resolution) => resolution.diagnosis_id),
    interpretation.diagnoses.map((diagnosis) => diagnosis.diagnosis_id),
  );
  assertDeepFrozen(interpretation);
}

function assertNoDiagnosticSecretLeak(interpretation: LegacyImportInterpretation): void {
  const presentation = canonicalLegacyImportJson({
    diagnoses: interpretation.diagnoses,
    normalized: interpretation.candidates.map((candidate) => candidate.normalized),
  });
  assert.doesNotMatch(presentation, /fixture-token-1234|synthetic-token-workflow-2026/u);
}

function supplementalContext(capture: LegacyImportSourceCapture, spec?: CaseSpec) {
  return {
    databaseTargetEvidence: collectLegacyImportDatabaseTargetEvidence(
      capture,
      inspectLegacyImportDatabaseTarget,
    ),
    bundledDefinitionNames: spec?.bundledDefinitionNames ?? [],
  };
}

function compositeCandidateSemantics(interpretation: LegacyImportInterpretation): unknown[] {
  return interpretation.candidates.map((candidate) => ({
    target: candidate.target,
    normalized: candidate.normalized,
    reason_code: candidate.reason_code,
  })).sort(compareCanonical);
}

describe("legacy supplemental captured-byte integration", () => {
  for (const spec of CASES) {
    test(`matches the sealed ${spec.name} semantics after source deletion`, (t) => {
      const before = fixtureFingerprint(spec.name);
      const { capture, oracle } = captureCase(t, spec);
      const context = supplementalContext(capture, spec);
      const interpretation = interpretLegacySupplementalCapture(capture, context);

      assertOracleSemantics(interpretation, oracle);
      assertRuntimeIdentity(capture, interpretation);
      assertNoDiagnosticSecretLeak(interpretation);
      assert.deepEqual(interpretation, interpretLegacySupplementalCapture(capture, context));
      assert.deepEqual(fixtureFingerprint(spec.name), before, `${spec.name}: fixture corpus unchanged`);
    });
  }

  test("composes the filtered six-source capstone with generic supplemental semantics", (t) => {
    const before = fixtureFingerprint("composite-capstone");
    const { capture, oracle } = captureComposite(t);
    const context = supplementalContext(capture);
    const interpretation = interpretLegacySupplementalCapture(capture, context);
    const expectedSources = oracle.sources.filter((source) => (
      (COMPOSITE_PATHS as readonly string[]).includes(source.path)
    )).map((source) => {
      if (source.path === ".gsd-worktrees/M008/git-marker.txt") return { ...source, kind: "git-marker" };
      if (source.path === ".gsd/gsd.db") return { ...source, outcome: "unparsed" as const };
      return source;
    });

    assert.deepEqual(normalizedSources(interpretation.sources), normalizedSources(expectedSources));
    assert.deepEqual(compositeCandidateSemantics(interpretation), [
      {
        target: { kind: "legacy-knowledge-source", key: ".gsd/KNOWLEDGE.md" },
        normalized: { role: "projection-input", preservation: "verbatim" },
        reason_code: "knowledge-markdown-preserved",
      },
      {
        target: { kind: "legacy-workflow-definition", key: ".gsd/workflows/capstone.yaml" },
        normalized: { path: ".gsd/workflows/capstone.yaml", preservation: "verbatim" },
        reason_code: "workflow-definition-is-evidence-only",
      },
      {
        target: { kind: "legacy-workflow-event", key: ".gsd/event-log.jsonl#L001" },
        normalized: {
          replay_policy: "evidence-only",
          event_version: 2,
          command: "complete_task",
          entity: { type: "task", id: "T01" },
          authority_context: null,
          file_order: 1,
        },
        reason_code: "history-evidence-only",
      },
      {
        target: {
          kind: "legacy-workflow-run-artifact",
          key: ".gsd/workflow-runs/capstone/run-001/GRAPH.yaml",
        },
        normalized: {
          path: ".gsd/workflow-runs/capstone/run-001/GRAPH.yaml",
          preservation: "verbatim",
        },
        reason_code: "workflow-run-is-evidence-only",
      },
      {
        target: { kind: "legacy-worktree-topology", key: "canonical/M008" },
        normalized: {
          scenario: "canonical",
          id: "M008",
          layout: "canonical",
          active: true,
          evidence_kind: "portable-git-marker-descriptor",
        },
        reason_code: "canonical-worktree-preserved",
      },
    ].sort(compareCanonical));
    assert.deepEqual(interpretation.diagnoses.map((diagnosis) => diagnosis.code), [
      "unsupported-database-schema",
    ]);
    assert.deepEqual(interpretation.resolutions.map((resolution) => ({
      disposition: resolution.disposition,
      target: resolution.target,
    })), [{ disposition: "unsupported", target: undefined }]);
    assertRuntimeIdentity(capture, interpretation);
    assertNoDiagnosticSecretLeak(interpretation);
    assert.deepEqual(interpretation, interpretLegacySupplementalCapture(capture, context));
    assert.deepEqual(fixtureFingerprint("composite-capstone"), before, "composite fixture corpus unchanged");
  });

  test("fails loud when retained supplemental bytes are not claimed", (t) => {
    const capture = captureUnknownSupplementalSource(t);

    assert.throws(
      () => interpretLegacySupplementalCapture(capture),
      /captured supplemental GSD sources are unclaimed: \.gsd\/UNKNOWN\.bin/u,
    );
  });

  test("rejects database evidence from a different immutable capture", (t) => {
    const first = captureComposite(t).capture;
    const second = captureComposite(t).capture;
    const evidence = collectLegacyImportDatabaseTargetEvidence(first, inspectLegacyImportDatabaseTarget);

    assert.throws(
      () => interpretLegacySupplementalCapture(second, { databaseTargetEvidence: evidence }),
      (error: unknown) => error instanceof LegacyImportDatabaseTargetError
        && error.stage === "interpret"
        && error.code === "LEGACY_IMPORT_DATABASE_EVIDENCE_SOURCE_INCONSISTENT",
    );
  });

  test("database inspector surfaces copy tampering over cleanup failure", (t) => {
    const { capture } = captureComposite(t);
    const source = capture.entries.find((candidate) => candidate.logical_path === ".gsd/gsd.db");
    assert.ok(source?.payload_id && source.sha256 && source.byte_size !== undefined);
    const payload = capture.payloads.find((candidate) => candidate.payload_id === source.payload_id);
    assert.ok(payload);
    const request = {
      root_kind: "project" as const,
      logical_path: source.logical_path,
      capture_hash: capture.capture_hash,
      source_id: source.source_id,
      source_sha256: source.sha256,
      source_byte_size: source.byte_size,
      bytes: Buffer.from(payload.bytes_base64, "base64"),
    };
    let reads = 0;
    const scratch = mkdtempSync(join(tmpdir(), "gsd-supplemental-inspect-"));
    t.after(() => rmSync(scratch, { recursive: true, force: true }));
    let observed: unknown;
    try {
      inspectLegacyImportDatabaseTarget(request, {
        makeTemporaryDirectory: () => scratch,
        writePrivateFile: (path, bytes) => writeFileSync(path, bytes, { mode: 0o600 }),
        readFile: (path) => {
          reads += 1;
          const current = readFileSync(path);
          if (reads === 1) return current;
          const altered = Buffer.from(current);
          altered[altered.length - 1] ^= 1;
          return altered;
        },
        removeTemporaryDirectory: (path) => {
          rmSync(path, { recursive: true, force: true });
          throw new Error("cleanup boom");
        },
        openReadOnly: () => {
          throw new Error("sqlite provider not needed for this test");
        },
      });
    } catch (error) {
      observed = error;
    }
    assert.ok(
      observed instanceof LegacyImportDatabaseTargetInspectionError,
      `expected COPY_CHANGED, received ${String(observed)}`,
    );
    assert.equal(observed.code, "LEGACY_IMPORT_DATABASE_INSPECTION_COPY_CHANGED");
    assert.equal(observed.stage, "cleanup");
    assert.equal(observed.retryable, false);
    assert.equal(observed.context.cleanup_also_failed, "true");
    assert.equal(observed.context.logical_path, ".gsd/gsd.db");
    assert.equal(existsSync(scratch), false);
  });

  test("does not label a boilerplate secrets manifest containing secret material as sanitized", (t) => {
    const source = join(temporaryDirectory(t), ".gsd");
    mkdirSync(source, { recursive: true });
    writeFileSync(
      join(source, "SECRETS-MANIFEST.md"),
      [
        "# Secrets Manifest",
        "",
        "No credential material is included in this repository.",
        "",
        "- Required environment keys: none",
        "",
        "-----BEGIN OPENSSH PRIVATE KEY-----",
        "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ",
        "-----END OPENSSH PRIVATE KEY-----",
        "",
      ].join("\n"),
    );
    const capture = captureLegacyImportSourceSet({
      roots: [{
        id: "project",
        kind: "project",
        physical_path: source,
        logical_path: ".gsd",
        presence: "required",
      }],
    });
    rmSync(source, { recursive: true, force: true });

    const interpretation = interpretLegacySupplementalCapture(capture);
    const manifest = interpretation.candidates.find((candidate) => (
      candidate.target.kind === "artifact" && candidate.target.key === ".gsd/SECRETS-MANIFEST.md"
    ));
    assert.ok(manifest);
    assert.deepEqual(manifest.normalized, {
      path: ".gsd/SECRETS-MANIFEST.md",
      preservation: "verbatim",
      role: "secrets-manifest",
    });
    assert.equal(manifest.reason_code, "secrets-manifest-preserved");
    assert.doesNotMatch(canonicalLegacyImportJson(manifest.normalized), /OPENSSH|contains_secrets/u);
  });
});
