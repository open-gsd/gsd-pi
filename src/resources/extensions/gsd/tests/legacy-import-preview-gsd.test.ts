// Project/App: gsd-pi
// File Purpose: Exact semantic corpus tests for pure legacy .gsd interpretation.

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import type {
  LegacyImportLocator,
  LegacyImportPreviewChange,
  LegacyImportPreviewDiagnosis,
  LegacyImportPreviewEnvelope,
  LegacyImportPreviewResolution,
  LegacyImportPreviewSource,
  LegacyImportSha256,
} from "../legacy-import-contract.ts";
import { classifyLegacyImportChanges } from "../legacy-import-preview-classifier.ts";
import {
  interpretLegacyGsdCapture,
  type LegacyImportGsdCandidate,
  type LegacyImportGsdDatabaseEvidence,
  type LegacyImportGsdDatabaseObservation,
  type LegacyImportGsdInterpretation,
} from "../legacy-import-preview-gsd.ts";
import {
  captureLegacyImportSourceSet,
  type LegacyImportSourceCapture,
  type LegacyImportSourceRoot,
} from "../legacy-import-preview-source.ts";
import {
  canonicalLegacyImportJson,
  hashLegacyImportBytes,
  hashLegacyImportValue,
} from "../legacy-import-preview.ts";
import {
  classificationBase,
  classificationBaseRow,
} from "./legacy-import-preview-classification-fixtures.ts";
import { loadLegacyImportCorpusCase } from "./helpers/legacy-import-corpus.ts";

const CORPUS_ROOT = new URL("./__fixtures__/legacy-import-corpus/v1/", import.meta.url);
const GSD_CASES = [
  "assessment-matrix",
  "gsd-alias-hybrid",
  "gsd-flat",
  "gsd-nested",
  "lifecycle-truth-matrix",
  "registries",
  "registries-lowercase",
] as const;

interface CapturedCase {
  capture: LegacyImportSourceCapture;
  physicalRoot: string;
  oracle: LegacyImportPreviewEnvelope;
  databaseEvidence: readonly LegacyImportGsdDatabaseEvidence[];
}

function compareCanonical(left: unknown, right: unknown): number {
  const leftJson = canonicalLegacyImportJson(left);
  const rightJson = canonicalLegacyImportJson(right);
  return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
}

function freezeDeep<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeDeep(child, seen);
  return Object.freeze(value);
}

function temporaryDirectory(t: { after(fn: () => void): void }): string {
  const path = mkdtempSync(join(tmpdir(), "gsd-preview-truth-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function payloadBytes(capture: LegacyImportSourceCapture, logicalPath: string): Buffer {
  const entry = capture.entries.find((candidate) => candidate.logical_path === logicalPath);
  assert.ok(entry?.payload_id, `${logicalPath}: captured payload`);
  const payload = capture.payloads.find((candidate) => candidate.payload_id === entry.payload_id);
  assert.ok(payload, `${logicalPath}: retained bytes`);
  return Buffer.from(payload.bytes_base64, "base64");
}

function capturedSourceId(capture: LegacyImportSourceCapture, logicalPath: string): LegacyImportSha256 {
  const entry = capture.entries.find((candidate) => candidate.logical_path === logicalPath);
  assert.ok(entry, `${logicalPath}: captured source`);
  return entry.source_id;
}

function lifecycleDatabaseEvidence(
  capture: LegacyImportSourceCapture,
  oracle: LegacyImportPreviewEnvelope,
): LegacyImportGsdDatabaseEvidence {
  const logicalPath = ".gsd/gsd.db";
  const bytes = payloadBytes(capture, logicalPath);
  const rawChanges = new Map(oracle.changes
    .filter((change) => change.raw.source_id === "lifecycle-dependency-database")
    .map((change) => [change.target.key, change.raw]));
  const depends = rawChanges.get("M001/S02/depends-column");
  const junction = rawChanges.get("M001/S02/dependency-junction");
  assert.ok(depends && junction, "lifecycle database evidence spans are sealed by the oracle");
  const observations: readonly LegacyImportGsdDatabaseObservation[] = [
    {
      table: "slices",
      key: { milestone_id: "M001", id: "S02" },
      field: "depends",
      value: ["S00"],
      raw: { locator: depends.locator, value: String(depends.value), sha256: depends.sha256 },
    },
    {
      table: "slice_dependencies",
      key: { milestone_id: "M001", slice_id: "S02" },
      field: "depends_on_slice_id",
      value: "S99",
      raw: { locator: junction.locator, value: String(junction.value), sha256: junction.sha256 },
    },
  ];
  const evidenceValue = {
    evidence_version: 1 as const,
    inspection_version: 1 as const,
    capture_hash: capture.capture_hash,
    source_id: capturedSourceId(capture, logicalPath),
    source_sha256: hashLegacyImportBytes(bytes),
    source_byte_size: bytes.length,
    coverage: [
      { table: "slices" as const, field: "depends" as const, complete: true as const, row_count: 1 },
      { table: "slice_dependencies" as const, field: "depends_on_slice_id" as const, complete: true as const, row_count: 1 },
    ],
    observations,
  };
  return freezeDeep({ ...evidenceValue, evidence_hash: hashLegacyImportValue(evidenceValue) });
}

function captureCase(
  t: { after(fn: () => void): void },
  caseName: (typeof GSD_CASES)[number],
): CapturedCase {
  const base = temporaryDirectory(t);
  const physicalRoot = join(base, ".gsd");
  cpSync(
    fileURLToPath(new URL(`./${caseName}/source/.gsd`, CORPUS_ROOT)),
    physicalRoot,
    { recursive: true, dereference: false },
  );
  const capture = captureLegacyImportSourceSet({
    roots: [{
      id: "gsd",
      kind: "project",
      physical_path: physicalRoot,
      logical_path: ".gsd",
      presence: "required",
    }],
  });
  const oracle = loadLegacyImportCorpusCase(CORPUS_ROOT, caseName).oracle;
  return {
    capture,
    physicalRoot,
    oracle,
    databaseEvidence: caseName === "lifecycle-truth-matrix"
      ? [lifecycleDatabaseEvidence(capture, oracle)]
      : [],
  };
}

function captureFiles(
  t: { after(fn: () => void): void },
  files: Readonly<Record<string, string | Buffer>>,
): LegacyImportSourceCapture {
  const base = temporaryDirectory(t);
  const physicalRoot = join(base, ".gsd");
  for (const [path, content] of Object.entries(files)) {
    const physicalPath = join(physicalRoot, path);
    mkdirSync(dirname(physicalPath), { recursive: true });
    writeFileSync(physicalPath, content);
  }
  return captureLegacyImportSourceSet({
    roots: [{ id: "gsd", kind: "project", physical_path: physicalRoot, logical_path: ".gsd", presence: "required" }],
  });
}

function captureCompositeT04(t: { after(fn: () => void): void }): CapturedCase {
  const base = temporaryDirectory(t);
  const physicalRoot = join(base, ".gsd");
  const selectedPaths = [
    ".gsd/DECISIONS.md",
    ".gsd/REQUIREMENTS.md",
    ".gsd/milestones/M007-capstone-alpha/M007-ROADMAP.md",
    ".gsd/milestones/M702-clean/M702-ROADMAP.md",
    ".gsd/phases/07-capstone-beta/07-ROADMAP.md",
    ".gsd/state-manifest.json",
  ];
  for (const logicalPath of selectedPaths) {
    const relativePath = logicalPath.slice(".gsd/".length);
    const destination = join(physicalRoot, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(fileURLToPath(new URL(`./composite-capstone/source/${logicalPath}`, CORPUS_ROOT)), destination);
  }
  const capture = captureLegacyImportSourceSet({
    roots: [{ id: "gsd", kind: "project", physical_path: physicalRoot, logical_path: ".gsd", presence: "required" }],
  });
  const fullOracle = loadLegacyImportCorpusCase(CORPUS_ROOT, "composite-capstone").oracle;
  const sources = fullOracle.sources.filter((source) => selectedPaths.includes(source.path));
  const sourceIds = new Set(sources.map((source) => source.source_id));
  const changes = fullOracle.changes.filter((change) => sourceIds.has(change.raw.source_id));
  const diagnoses = fullOracle.diagnoses.filter((diagnosis) => sourceIds.has(diagnosis.source_id));
  const diagnosisIds = new Set(diagnoses.map((diagnosis) => diagnosis.diagnosis_id));
  const resolutions = fullOracle.resolutions.filter((resolution) => diagnosisIds.has(resolution.diagnosis_id));
  return {
    capture,
    physicalRoot,
    databaseEvidence: [],
    oracle: { ...fullOracle, sources, changes, diagnoses, resolutions },
  };
}

function sourcePathsById(sources: readonly LegacyImportPreviewSource[]): Map<string, string> {
  return new Map(sources.map((source) => [source.source_id, source.path]));
}

function normalizedSources(sources: readonly LegacyImportPreviewSource[]) {
  return sources.map(({ source_id: _sourceId, ...source }) => source);
}

function normalizedCandidates(
  candidates: readonly (LegacyImportGsdCandidate | LegacyImportPreviewChange)[],
  sourcePaths: ReadonlyMap<string, string>,
) {
  return candidates.map((candidate) => {
    let classification: "compare" | "preserve";
    if ("action" in candidate) {
      classification = candidate.action === "preserve" ? "preserve" : "compare";
    } else {
      classification = candidate.classification;
    }
    return {
      classification,
      target: candidate.target,
      raw: {
        ...candidate.raw,
        source_id: sourcePaths.get(candidate.raw.source_id) ?? candidate.raw.source_id,
      },
      normalized: candidate.normalized,
      provenance: {
        ...candidate.provenance,
        source_id: sourcePaths.get(candidate.provenance.source_id) ?? candidate.provenance.source_id,
      },
      reason_code: candidate.reason_code,
    };
  }).sort(compareCanonical);
}

function diagnosisKey(
  diagnosis: LegacyImportPreviewDiagnosis,
  sourcePaths: ReadonlyMap<string, string>,
): string {
  return canonicalLegacyImportJson({
    code: diagnosis.code,
    source: sourcePaths.get(diagnosis.source_id) ?? diagnosis.source_id,
    locator: diagnosis.locator,
  });
}

function normalizedDiagnoses(
  diagnoses: readonly LegacyImportPreviewDiagnosis[],
  sourcePaths: ReadonlyMap<string, string>,
) {
  return diagnoses.map(({ diagnosis_id: _diagnosisId, source_id: sourceId, ...diagnosis }) => ({
    ...diagnosis,
    source_id: sourcePaths.get(sourceId) ?? sourceId,
  })).sort(compareCanonical);
}

function normalizedResolutions(
  resolutions: readonly LegacyImportPreviewResolution[],
  diagnoses: readonly LegacyImportPreviewDiagnosis[],
  sourcePaths: ReadonlyMap<string, string>,
) {
  const keys = new Map(diagnoses.map((diagnosis) => [
    diagnosis.diagnosis_id,
    diagnosisKey(diagnosis, sourcePaths),
  ]));
  return resolutions.map((resolution) => ({
    diagnosis: keys.get(resolution.diagnosis_id) ?? resolution.diagnosis_id,
    disposition: resolution.disposition,
    ...(resolution.target === undefined ? {} : { target: resolution.target }),
  })).sort(compareCanonical);
}

function assertDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

function assertLocator(bytes: Buffer, locator: LegacyImportLocator, label: string): Buffer {
  assert.ok(Number.isSafeInteger(locator.start_byte) && locator.start_byte >= 0, `${label}: start byte`);
  assert.ok(
    locator.end_byte !== undefined
      && Number.isSafeInteger(locator.end_byte)
      && locator.end_byte > locator.start_byte
      && locator.end_byte <= bytes.length,
    `${label}: end byte`,
  );
  const expectedLine = bytes.subarray(0, locator.start_byte).reduce(
    (line, byte) => line + (byte === 10 ? 1 : 0),
    1,
  );
  if (locator.line !== undefined) assert.equal(locator.line, expectedLine, `${label}: line`);
  return bytes.subarray(locator.start_byte, locator.end_byte);
}

function assertRuntimeIdentity(
  capture: LegacyImportSourceCapture,
  interpretation: LegacyImportGsdInterpretation,
): void {
  const sourceIds = new Set(interpretation.sources.map((source) => source.source_id));
  const expectedIds = new Map(capture.entries.map((entry) => [entry.logical_path, entry.source_id]));
  for (const source of interpretation.sources) {
    assert.equal(source.source_id, expectedIds.get(source.path), `${source.path}: captured identity`);
  }
  assert.deepEqual(
    interpretation.candidates.map((candidate) => candidate.ordinal),
    interpretation.candidates.map((_candidate, index) => index + 1),
  );
  for (const candidate of interpretation.candidates) {
    assert.ok(sourceIds.has(candidate.raw.source_id));
    assert.equal(candidate.raw.source_id, candidate.provenance.source_id);
    assert.match(candidate.candidate_id, /^sha256:[0-9a-f]{64}$/u);
    const { candidate_id: _candidateId, ordinal: _ordinal, ...identity } = candidate;
    assert.equal(candidate.candidate_id, hashLegacyImportValue(identity));
    const bytes = payloadBytes(capture, interpretation.sources.find(
      (source) => source.source_id === candidate.raw.source_id,
    )!.path);
    assert.equal(
      candidate.raw.sha256,
      hashLegacyImportBytes(assertLocator(bytes, candidate.raw.locator, candidate.candidate_id)),
    );
  }
  assert.equal(new Set(interpretation.candidates.map((candidate) => candidate.candidate_id)).size, interpretation.candidates.length);
  for (const diagnosis of interpretation.diagnoses) {
    assert.ok(sourceIds.has(diagnosis.source_id));
    assert.match(diagnosis.diagnosis_id, /^sha256:[0-9a-f]{64}$/u);
    const { diagnosis_id: _diagnosisId, ...identity } = diagnosis;
    assert.equal(diagnosis.diagnosis_id, hashLegacyImportValue(identity));
    const bytes = payloadBytes(capture, interpretation.sources.find(
      (source) => source.source_id === diagnosis.source_id,
    )!.path);
    assertLocator(bytes, diagnosis.locator, diagnosis.diagnosis_id);
  }
  assert.deepEqual(
    interpretation.resolutions.map((resolution) => resolution.diagnosis_id),
    interpretation.diagnoses.map((diagnosis) => diagnosis.diagnosis_id),
  );
}

function assertOracleSemantics(captured: CapturedCase, interpretation: LegacyImportGsdInterpretation): void {
  const runtimePaths = sourcePathsById(interpretation.sources);
  const oraclePaths = sourcePathsById(captured.oracle.sources);
  const manifestRows = interpretation.candidates.filter((candidate) => (
    candidate.reason_code.startsWith("state-manifest-")
    && candidate.reason_code.endsWith("-row")
  ));
  const manifestRowTargets = new Set(manifestRows.map((candidate) => canonicalLegacyImportJson([
    candidate.target,
    runtimePaths.get(candidate.raw.source_id),
  ])));
  const runtimeCandidates = interpretation.candidates.filter((candidate) => !manifestRows.includes(candidate));
  const oracleCandidates = captured.oracle.changes.filter((candidate) => !manifestRowTargets.has(
    canonicalLegacyImportJson([candidate.target, oraclePaths.get(candidate.raw.source_id)]),
  ));
  assert.deepEqual(normalizedSources(interpretation.sources), normalizedSources(captured.oracle.sources));
  assert.deepEqual(
    normalizedCandidates(runtimeCandidates, runtimePaths),
    normalizedCandidates(oracleCandidates, oraclePaths),
  );
  assert.deepEqual(
    normalizedDiagnoses(interpretation.diagnoses, runtimePaths),
    normalizedDiagnoses(captured.oracle.diagnoses, oraclePaths),
  );
  assert.deepEqual(
    normalizedResolutions(interpretation.resolutions, interpretation.diagnoses, runtimePaths),
    normalizedResolutions(captured.oracle.resolutions, captured.oracle.diagnoses, oraclePaths),
  );
  assertRuntimeIdentity(captured.capture, interpretation);
  assertDeepFrozen(interpretation);
}

function rehashEvidence(
  evidence: LegacyImportGsdDatabaseEvidence,
  changes: Partial<LegacyImportGsdDatabaseEvidence>,
): LegacyImportGsdDatabaseEvidence {
  const { evidence_hash: _oldHash, ...oldValue } = evidence;
  const value = { ...oldValue, ...changes };
  return { ...value, evidence_hash: hashLegacyImportValue(value) } as LegacyImportGsdDatabaseEvidence;
}

function completeStateManifestV1() {
  return {
    version: 1,
    exported_at: "2026-07-16T12:00:00.000Z",
    requirements: [{
      id: "R001",
      class: "functional",
      status: "active",
      description: "Retain one database authority.",
      why: "Prevent projection drift.",
      source: "M001",
      primary_owner: "S01",
      supporting_slices: "",
      validation: "Compare the imported row.",
      notes: "",
      full_content: "# R001\n\nRetain one database authority.",
      superseded_by: null,
    }],
    artifacts: [{
      path: "milestones/M001/slices/S01/tasks/T01-SUMMARY.md",
      artifact_type: "SUMMARY",
      milestone_id: "M001",
      slice_id: "S01",
      task_id: "T01",
      full_content: "# T01 Summary\n",
      imported_at: "2026-07-16T12:01:00.000Z",
      content_hash: "sha256:artifact-content",
    }],
    milestones: [{
      id: "M001",
      title: "Adopt canonical authority",
      status: "active",
      depends_on: [],
      created_at: "2026-07-16T12:00:00.000Z",
      completed_at: null,
      vision: "The database is authoritative.",
      success_criteria: ["No projection drift"],
      key_risks: [{ risk: "Data loss", whyItMatters: "Legacy truth must survive." }],
      proof_strategy: [{
        riskOrUnknown: "Manifest fidelity",
        retireIn: "S01",
        whatWillBeProven: "Every supported row is compared exactly.",
      }],
      verification_contract: "Run focused import tests.",
      verification_integration: "Classify against a frozen base.",
      verification_operational: "Replay deterministically.",
      verification_uat: "No manual step for exact rows.",
      definition_of_done: ["All rows retained"],
      requirement_coverage: "R001",
      boundary_map_markdown: "manifest -> preview",
      sequence: 1,
    }],
    slices: [{
      milestone_id: "M001",
      id: "S01",
      title: "Interpret the manifest",
      status: "active",
      risk: "medium",
      depends: [],
      demo: "Show exact candidates.",
      created_at: "2026-07-16T12:00:00.000Z",
      completed_at: null,
      full_summary_md: "",
      full_uat_md: "",
      goal: "Preserve complete authority.",
      success_criteria: "All row sets are explicit.",
      proof_level: "integration",
      integration_closure: "Classifier consumes the same identities.",
      observability_impact: "Preview exposes provenance.",
      target_repositories: ["open-gsd/gsd-pi"],
      sequence: 1,
      replan_triggered_at: null,
      is_sketch: 0,
      sketch_scope: "",
    }],
    tasks: [{
      milestone_id: "M001",
      slice_id: "S01",
      id: "T01",
      title: "Emit canonical rows",
      status: "active",
      one_liner: "Map each complete row.",
      narrative: "The manifest is the structured source.",
      verification_result: "",
      duration: "",
      completed_at: null,
      blocker_discovered: false,
      deviations: "",
      known_issues: "",
      key_files: [".gsd/state-manifest.json"],
      key_decisions: ["D001"],
      full_summary_md: "",
      description: "Emit one full-row candidate.",
      estimate: "1h",
      files: ["src/import.ts"],
      verify: "node --test",
      inputs: ["state manifest"],
      expected_output: ["canonical candidate"],
      observability_impact: "Raw pointers remain inspectable.",
      full_plan_md: "# T01 Plan\n",
      target_repositories: ["open-gsd/gsd-pi"],
      sequence: 1,
      blocker_source: "",
      escalation_pending: 0,
      escalation_awaiting_review: 0,
      escalation_artifact_path: null,
      escalation_override_applied_at: null,
    }],
    decisions: [{
      seq: 1,
      id: "D001",
      when_context: "Before import",
      scope: "global",
      decision: "Use one authority",
      choice: "database",
      rationale: "Avoid drift.",
      revisable: "yes",
      made_by: "human",
      source: "discussion",
      superseded_by: null,
    }],
    assessments: [{
      path: "milestones/M001/slices/S01/T01-ASSESSMENT.md",
      milestone_id: "M001",
      slice_id: "S01",
      task_id: "T01",
      status: "pass",
      scope: "run-uat",
      full_content: "**Verdict:** PASS",
      created_at: "2026-07-16T12:02:00.000Z",
    }],
    verification_evidence: [],
  };
}

function clonedStateManifestV1(): ReturnType<typeof completeStateManifestV1> {
  return JSON.parse(JSON.stringify(completeStateManifestV1())) as ReturnType<typeof completeStateManifestV1>;
}

describe("legacy .gsd captured-byte interpretation", () => {
  for (const caseName of GSD_CASES) {
    test(`matches the sealed ${caseName} semantics`, (t) => {
      const captured = captureCase(t, caseName);
      const interpretation = interpretLegacyGsdCapture(captured.capture, captured.databaseEvidence);
      assertOracleSemantics(captured, interpretation);
      assert.deepEqual(
        interpretation,
        interpretLegacyGsdCapture(captured.capture, captured.databaseEvidence),
        `${caseName}: deterministic replay`,
      );
    });
  }

  test("retains all meaning after the source tree is removed", (t) => {
    const captured = captureCase(t, "lifecycle-truth-matrix");
    const before = interpretLegacyGsdCapture(captured.capture, captured.databaseEvidence);
    rmSync(captured.physicalRoot, { recursive: true, force: true });
    const after = interpretLegacyGsdCapture(captured.capture, captured.databaseEvidence);
    assert.deepEqual(after, before);
    assertOracleSemantics(captured, after);
  });

  test("composes the filtered T04 capstone without interpreter drift", (t) => {
    const captured = captureCompositeT04(t);
    assertOracleSemantics(captured, interpretLegacyGsdCapture(captured.capture));
  });

  test("maps generated flat task artifacts without legacy parent frontmatter", (t) => {
    const interpretation = interpretLegacyGsdCapture(captureFiles(t, {
      "phases/09-team/09-ROADMAP.md": [
        "# M009-rfuh2h: Team milestone",
        "",
        "- [ ] **S01: Current task artifacts** `risk:low` `depends:[]`",
        "- [ ] **S02: Current slice plan** `risk:low` `depends:[]`",
        "",
      ].join("\n"),
      "phases/09-team/S01-T01-PLAN.md": [
        "---",
        "estimated_steps: 1",
        "estimated_files: 1",
        "---",
        "",
        "# T01: Recover current task plan",
        "",
      ].join("\n"),
      "phases/09-team/S01-T01-SUMMARY.md": [
        "---",
        "id: T01",
        "parent: S01",
        "milestone: M009-rfuh2h",
        "---",
        "",
        "# T01: Recover current task summary",
        "",
      ].join("\n"),
      "phases/09-team/09-02-PLAN.md": [
        "# S02: Current slice plan",
        "",
        "**Milestone:** M009-rfuh2h",
        "**Slice:** S02",
        "",
        "<tasks>",
        "- [ ] **T01**: Recover embedded task",
        "</tasks>",
        "",
      ].join("\n"),
    }));

    assert.deepEqual(
      interpretation.candidates
        .filter((candidate) => candidate.target.kind === "task")
        .map((candidate) => [candidate.target.key, candidate.target.field, candidate.normalized]),
      // Candidate order follows the interpreter's emission order: flat task
      // PLAN rows, then SUMMARY field refinements, then slice-plan embedded tasks.
      [
        ["M009-rfuh2h/S01/T01", undefined, {
          id: "T01",
          milestone_id: "M009-rfuh2h",
          slice_id: "S01",
          status: "pending",
          title: "Recover current task plan",
        }],
        ["M009-rfuh2h/S01/T01", "status", "complete"],
        ["M009-rfuh2h/S02/T01", undefined, {
          id: "T01",
          milestone_id: "M009-rfuh2h",
          slice_id: "S02",
          status: "pending",
          title: "Recover embedded task",
        }],
      ],
    );
    assert.deepEqual(interpretation.diagnoses, []);
    const classification = classifyLegacyImportChanges(classificationBase(), interpretation);
    assert.equal(classification.applicable, true);
    assert.equal(classification.counts.unresolved, 0);
  });

  test("rejects conflicting generated flat task parent evidence", (t) => {
    const interpretation = interpretLegacyGsdCapture(captureFiles(t, {
      "phases/09-team/09-ROADMAP.md": [
        "# M009-rfuh2h: Team milestone",
        "",
        "- [ ] **S01: First slice** `risk:low` `depends:[]`",
        "- [ ] **S02: Second slice** `risk:low` `depends:[]`",
        "",
      ].join("\n"),
      "phases/09-team/09-01-PLAN.md": [
        "# S02: Misfiled slice plan",
        "",
        "**Milestone:** M009-rfuh2h",
        "**Slice:** S02",
        "",
        "<tasks>",
        "- [ ] **T01**: Must not map",
        "</tasks>",
        "",
      ].join("\n"),
      "phases/09-team/S01-T01-SUMMARY.md": [
        "---",
        "id: T01",
        "parent: S02",
        "milestone: M009-rfuh2h",
        "---",
        "",
        "# T01: Misfiled task summary",
        "",
      ].join("\n"),
    }));

    assert.deepEqual(
      interpretation.diagnoses.map((diagnosis) => diagnosis.code),
      ["task-plan-parent-conflict", "task-summary-parent-conflict"],
    );
    assert.deepEqual(
      interpretation.candidates.filter((candidate) => candidate.target.kind === "task"),
      [],
    );
  });

  test("preserves flat slice and milestone summaries", (t) => {
    const interpretation = interpretLegacyGsdCapture(captureFiles(t, {
      "phases/09-team/09-ROADMAP.md": [
        "# M009-rfuh2h: Team milestone",
        "",
        "- [x] **S01: First slice** `risk:low` `depends:[]`",
        "",
      ].join("\n"),
      "phases/09-team/09-SUMMARY.md": [
        "---",
        "id: M009-rfuh2h",
        "status: complete",
        "---",
        "",
        "# M009: Must not map as a task",
        "",
      ].join("\n"),
      "phases/09-team/09-01-SUMMARY.md": [
        "---",
        "id: S01",
        "parent: M009-rfuh2h",
        "milestone: M009-rfuh2h",
        "status: complete",
        "---",
        "",
        "# S01: Must not map as a task",
        "",
      ].join("\n"),
      "phases/09-team/S01-T01-SUMMARY.md": [
        "---",
        "id: T01",
        "parent: S01",
        "milestone: M009-rfuh2h",
        "---",
        "",
        "# T01: Must map as a task status refinement",
        "",
      ].join("\n"),
    }));

    assert.deepEqual(interpretation.diagnoses, []);

    assert.deepEqual(
      interpretation.candidates
        .filter((candidate) => candidate.reason_code === "flat-non-task-summary-preserved")
        .map((candidate) => [candidate.classification, candidate.target.kind, candidate.target.key, candidate.normalized]),
      [
        ["preserve", "artifact", ".gsd/phases/09-team/09-01-SUMMARY.md", { reason: "non-task-summary", id: "S01" }],
        ["preserve", "artifact", ".gsd/phases/09-team/09-SUMMARY.md", { reason: "non-task-summary", id: "M009-rfuh2h" }],
      ],
    );

    assert.deepEqual(
      interpretation.candidates
        .filter((candidate) => candidate.target.kind === "task")
        .map((candidate) => [candidate.target.key, candidate.target.field, candidate.normalized]),
      [["M009-rfuh2h/S01/T01", "status", "complete"]],
    );
  });

  test("preserves flat slice summaries with no id field", (t) => {
    const interpretation = interpretLegacyGsdCapture(captureFiles(t, {
      "phases/09-team/09-ROADMAP.md": [
        "# M009-rfuh2h: Team milestone",
        "",
        "- [x] **S02: Second slice** `risk:low` `depends:[]`",
        "",
      ].join("\n"),
      "phases/09-team/09-02-PLAN.md": [
        "# S02: Second slice",
        "",
        "**Milestone:** M009-rfuh2h",
        "**Slice:** S02",
        "",
        "## Tasks",
        "",
        "- [x] **T01**: Must map as the only real task",
        "",
      ].join("\n"),
      "phases/09-team/09-02-SUMMARY.md": [
        "---",
        "slice: S02",
        "status: complete",
        "---",
        "",
        "# S02 Summary: Old format must not fabricate S02/T02",
        "",
      ].join("\n"),
    }));

    assert.deepEqual(interpretation.diagnoses, []);
    assert.deepEqual(
      interpretation.candidates
        .filter((candidate) => candidate.target.kind === "task")
        .map((candidate) => [candidate.target.key, candidate.target.field, candidate.normalized]),
      [["M009-rfuh2h/S02/T01", undefined, {
        id: "T01",
        milestone_id: "M009-rfuh2h",
        slice_id: "S02",
        status: "complete",
        title: "Must map as the only real task",
      }]],
    );

    assert.deepEqual(
      interpretation.candidates
        .filter((candidate) => candidate.reason_code === "flat-non-task-summary-preserved")
        .map((candidate) => [candidate.classification, candidate.target.kind, candidate.target.key, candidate.normalized]),
      [["preserve", "artifact", ".gsd/phases/09-team/09-02-SUMMARY.md", { reason: "non-task-summary", id: "S02" }]],
    );
  });

  test("routes a contradictory id-and-task summary through task-parent selection instead of preserving it", (t) => {
    const interpretation = interpretLegacyGsdCapture(captureFiles(t, {
      "phases/09-team/09-ROADMAP.md": [
        "# M009-rfuh2h: Team milestone",
        "",
        "- [x] **S03: Third slice** `risk:low` `depends:[]`",
        "",
      ].join("\n"),
      "phases/09-team/09-03-PLAN.md": [
        "# S03: Third slice",
        "",
        "**Milestone:** M009-rfuh2h",
        "**Slice:** S03",
        "",
        "## Tasks",
        "",
        "- [x] **T01**: Must not map from this summary",
        "",
      ].join("\n"),
      // Self-contradictory frontmatter: `id: S03` claims a slice identity, but `task:
      // T01` also claims task membership. The id-based guard must not preserve this as
      // history just because id matches ^S\d+ — the task field takes it out of scope.
      "phases/09-team/09-03-SUMMARY.md": [
        "---",
        "id: S03",
        "task: T01",
        "status: complete",
        "---",
        "",
        "# S03 Summary: Contradicts its own id with a task field",
        "",
      ].join("\n"),
    }));

    assert.deepEqual(
      interpretation.diagnoses.map((diagnosis) => diagnosis.code),
      ["task-summary-parent-conflict"],
    );
    assert.deepEqual(
      interpretation.candidates.filter((candidate) => candidate.reason_code === "flat-non-task-summary-preserved"),
      [],
    );
  });

  test("set milestone completion status from a matching milestone summary", (t) => {
    const interpretation = interpretLegacyGsdCapture(captureFiles(t, {
      "phases/09-team/09-ROADMAP.md": [
        "# M009-rfuh2h: Team milestone",
        "",
        "- [x] **S01: First slice** `risk:low` `depends:[]`",
        "",
      ].join("\n"),
      "phases/09-team/09-SUMMARY.md": [
        "---",
        "id: M009-rfuh2h",
        "status: complete",
        "---",
        "",
        "# M009: Must attest milestone completion",
        "",
      ].join("\n"),
    }));

    assert.deepEqual(interpretation.diagnoses, []);
    assert.deepEqual(
      interpretation.candidates
        .filter((candidate) => candidate.target.kind === "milestone" && candidate.target.field === "status")
        .map((candidate) => [candidate.target.key, candidate.normalized]),
      [["M009-rfuh2h", "complete"]],
    );
  });

  test("flags a mistmatch numeric milestone id when using unique id flag", (t) => {
    const interpretation = interpretLegacyGsdCapture(captureFiles(t, {
      "phases/09-team/09-ROADMAP.md": [
        "# M009-rfuh2h: Team milestone",
        "",
        "- [x] **S01: First slice** `risk:low` `depends:[]`",
        "",
      ].join("\n"),
      "phases/09-team/09-SUMMARY.md": [
        "---",
        "id: M009",
        "status: complete",
        "---",
        "",
        "# M009: Must not silently attest from an ambiguous bare id",
        "",
      ].join("\n"),
    }));

    assert.deepEqual(
      interpretation.diagnoses.map((diagnosis) => diagnosis.code),
      ["milestone-summary-id-ambiguous"],
    );
    assert.deepEqual(
      interpretation.candidates.filter(
        (candidate) => candidate.target.kind === "milestone" && candidate.target.field === "status",
      ),
      [],
    );
  });

  test("emits action-matrix decision candidates and complete anchors for present collections", (t) => {
    const base = temporaryDirectory(t);
    const physicalRoot = join(base, ".gsd");
    cpSync(
      fileURLToPath(new URL("./action-matrix/source/.gsd", CORPUS_ROOT)),
      physicalRoot,
      { recursive: true, dereference: false },
    );
    const capture = captureLegacyImportSourceSet({
      roots: [{
        id: "gsd",
        kind: "project",
        physical_path: physicalRoot,
        logical_path: ".gsd",
        presence: "required",
      }],
    });
    const interpretation = interpretLegacyGsdCapture(capture);
    const manifestBytes = payloadBytes(capture, ".gsd/state-manifest.json");
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
      decisions: readonly Record<string, unknown>[];
    };
    const decisionCandidates = interpretation.candidates
      .filter((candidate) => candidate.target.kind === "decision")
      .sort((left, right) => left.target.key.localeCompare(right.target.key));

    assert.deepEqual(
      decisionCandidates.map((candidate) => ({
        classification: candidate.classification,
        key: candidate.target.key,
        pointer: candidate.raw.locator.json_pointer,
        normalized: candidate.normalized,
      })),
      manifest.decisions.map((decision, index) => ({
        classification: "compare",
        key: decision.id,
        pointer: `/decisions/${index}`,
        normalized: decision,
      })),
    );
    assert.deepEqual(
      interpretation.complete_row_sets.map((candidate) => candidate.row_set).sort(),
      ["artifacts", "assessments", "decisions", "requirements"],
    );
    const complete = interpretation.complete_row_sets.find((candidate) => candidate.row_set === "decisions");
    assert.ok(complete);
    assert.equal(complete.row_set, "decisions");
    assert.equal(complete.target_kind, "decision");
    assert.deepEqual(complete.member_keys, ["D001", "D002", "D004"]);
    assert.equal(complete.raw.locator.json_pointer, "/decisions");
    assert.deepEqual(complete.raw.value, manifest.decisions);
    assert.equal(complete.raw.source_id, capturedSourceId(capture, ".gsd/state-manifest.json"));
    assert.equal(complete.provenance.source_id, complete.raw.source_id);
    assert.equal(complete.provenance.parser_id, "gsd-lifecycle-truth");
    assert.equal(
      complete.raw.sha256,
      hashLegacyImportBytes(assertLocator(manifestBytes, complete.raw.locator, complete.complete_set_id)),
    );
    const { complete_set_id: _completeSetId, ...identity } = complete;
    assert.equal(complete.complete_set_id, hashLegacyImportValue(identity));
    assertDeepFrozen(interpretation);
  });

  test("emits canonical full-row candidates and complete anchors for every present StateManifest v1 row set", (t) => {
    const manifest = completeStateManifestV1();
    const capture = captureFiles(t, {
      "state-manifest.json": JSON.stringify(manifest, null, 2),
    });
    const interpretation = interpretLegacyGsdCapture(capture);
    const manifestBytes = payloadBytes(capture, ".gsd/state-manifest.json");
    const sourceId = capturedSourceId(capture, ".gsd/state-manifest.json");
    const [{ created_at: _milestoneCreatedAt, completed_at: _milestoneCompletedAt, ...milestone }] = manifest.milestones;
    const [{
      created_at: _sliceCreatedAt,
      completed_at: _sliceCompletedAt,
      replan_triggered_at: _sliceReplanTriggeredAt,
      ...slice
    }] = manifest.slices;
    const [{
      completed_at: _taskCompletedAt,
      escalation_override_applied_at: _taskEscalationOverrideAppliedAt,
      ...task
    }] = manifest.tasks;
    const [requirement] = manifest.requirements;
    const [{ imported_at: _artifactImportedAt, ...artifact }] = manifest.artifacts;
    const [{ created_at: _assessmentCreatedAt, ...assessment }] = manifest.assessments;
    const expectedRows = [
      { property: "milestones", kind: "milestone", key: "M001", normalized: milestone },
      { property: "slices", kind: "slice", key: "M001/S01", normalized: slice },
      { property: "tasks", kind: "task", key: "M001/S01/T01", normalized: task },
      { property: "requirements", kind: "requirement", key: "R001", normalized: requirement },
      {
        property: "artifacts",
        kind: "artifact",
        key: "milestones/M001/slices/S01/tasks/T01-SUMMARY.md",
        normalized: artifact,
      },
      {
        property: "assessments",
        kind: "assessment",
        key: "M001/S01/T01/run-uat",
        normalized: assessment,
      },
    ] as const;

    for (const expected of expectedRows) {
      const pointer = `/${expected.property}/0`;
      const matching = interpretation.candidates.filter((candidate) => (
        candidate.target.kind === expected.kind
        && candidate.target.key === expected.key
        && candidate.target.field === undefined
      ));
      assert.equal(matching.length, 1, `${expected.property}: one authoritative full-row candidate`);
      const candidate = matching[0];
      assert.ok(candidate);
      assert.equal(candidate.classification, "compare", expected.property);
      assert.deepEqual(candidate.normalized, expected.normalized, `${expected.property}: canonical base row`);
      const hasTemporalEvidence = ["milestones", "slices", "tasks", "artifacts", "assessments"].includes(expected.property);
      assert.equal(candidate.raw.locator.json_pointer, hasTemporalEvidence ? undefined : pointer, expected.property);
      const rawBytes = assertLocator(manifestBytes, candidate.raw.locator, candidate.candidate_id);
      assert.deepEqual(candidate.raw.value, hasTemporalEvidence
        ? rawBytes.toString("utf8")
        : manifest[expected.property][0], `${expected.property}: exact manifest member evidence`);
      assert.equal(candidate.raw.source_id, sourceId, expected.property);
      assert.deepEqual(candidate.provenance, {
        source_id: sourceId,
        parser_id: "gsd-lifecycle-truth",
        parser_version: "1",
      }, expected.property);
      assert.equal(
        candidate.raw.sha256,
        hashLegacyImportBytes(rawBytes),
        expected.property,
      );
    }

    const completeByRowSet = new Map(interpretation.complete_row_sets.map((complete) => [complete.row_set, complete]));
    const expectedComplete = [
      { property: "milestones", rowSet: "milestones", kind: "milestone", members: ["M001"] },
      { property: "slices", rowSet: "slices", kind: "slice", members: ["M001/S01"] },
      { property: "tasks", rowSet: "tasks", kind: "task", members: ["M001/S01/T01"] },
      { property: "requirements", rowSet: "requirements", kind: "requirement", members: ["R001"] },
      {
        property: "artifacts",
        rowSet: "artifacts",
        kind: "artifact",
        members: ["milestones/M001/slices/S01/tasks/T01-SUMMARY.md"],
      },
      {
        property: "assessments",
        rowSet: "assessments",
        kind: "assessment",
        members: ["M001/S01/T01/run-uat"],
      },
      { property: "decisions", rowSet: "decisions", kind: "decision", members: ["D001"] },
    ] as const;
    assert.equal(completeByRowSet.size, expectedComplete.length);
    for (const expected of expectedComplete) {
      const complete = completeByRowSet.get(expected.rowSet);
      assert.ok(complete, `${expected.rowSet}: complete authority`);
      assert.equal(complete.target_kind, expected.kind, expected.rowSet);
      assert.deepEqual(complete.member_keys, expected.members, expected.rowSet);
      assert.equal(complete.raw.locator.json_pointer, `/${expected.property}`, expected.rowSet);
      assert.deepEqual(complete.raw.value, manifest[expected.property], expected.rowSet);
      assert.equal(complete.raw.source_id, sourceId, expected.rowSet);
      assert.deepEqual(complete.provenance, {
        source_id: sourceId,
        parser_id: "gsd-lifecycle-truth",
        parser_version: "1",
      }, expected.rowSet);
      assert.equal(
        complete.raw.sha256,
        hashLegacyImportBytes(assertLocator(manifestBytes, complete.raw.locator, complete.complete_set_id)),
        expected.rowSet,
      );
    }
    assert.equal(interpretation.sources[0]?.outcome, "mapped");
    assertDeepFrozen(interpretation);
  });

  test("keeps legacy timestamps out of structured StateManifest Preview values", (t) => {
    const interpretation = interpretLegacyGsdCapture(captureFiles(t, {
      "state-manifest.json": JSON.stringify(completeStateManifestV1(), null, 2),
    }));
    const temporalPaths: string[] = [];
    const visit = (value: unknown, path: string): void => {
      if (Array.isArray(value)) {
        value.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      } else if (value !== null && typeof value === "object") {
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
          const child = `${path}.${key}`;
          if (key === "timestamp" || key.endsWith("_timestamp") || key.endsWith("_at")) temporalPaths.push(child);
          visit(entry, child);
        }
      }
    };
    interpretation.candidates.forEach((candidate, index) => {
      visit(candidate.raw.value, `candidates[${index}].raw.value`);
      visit(candidate.normalized, `candidates[${index}].normalized`);
    });
    interpretation.complete_row_sets.forEach((complete, index) => {
      visit((complete.preview_raw ?? complete.raw).value, `complete_row_sets[${index}].preview_raw.value`);
    });

    assert.deepEqual(temporalPaths, []);
  });

  test("classifies every self-contained StateManifest v1 row without duplicate assessment ownership", (t) => {
    const interpretation = interpretLegacyGsdCapture(captureFiles(t, {
      "state-manifest.json": JSON.stringify(completeStateManifestV1(), null, 2),
    }));

    assert.deepEqual(
      interpretation.candidates.filter((candidate) => (
        candidate.classification === "compare" && candidate.target.kind === "assessment"
      )).map((candidate) => candidate.target.key),
      ["M001/S01/T01/run-uat"],
    );

    const result = classifyLegacyImportChanges(classificationBase(), interpretation);
    const rowKinds = new Set([
      "milestone", "slice", "task", "requirement", "artifact", "assessment", "decision",
    ]);
    assert.equal(result.applicable, true);
    assert.deepEqual(
      result.changes.filter((change) => rowKinds.has(change.target.kind)).map((change) => (
        [change.action, change.target.kind, change.target.key]
      )).sort(),
      [
        ["create", "artifact", "milestones/M001/slices/S01/tasks/T01-SUMMARY.md"],
        ["create", "assessment", "M001/S01/T01/run-uat"],
        ["create", "decision", "D001"],
        ["create", "milestone", "M001"],
        ["create", "requirement", "R001"],
        ["create", "slice", "M001/S01"],
        ["create", "task", "M001/S01/T01"],
      ].sort(),
    );
  });

  test("retains complete manifest rows beside a compatible recognized projection", (t) => {
    const manifest = completeStateManifestV1();
    manifest.milestones[0].status = "pending";
    manifest.slices[0].status = "pending";
    manifest.milestones.push({
      ...structuredClone(manifest.milestones[0]),
      id: "M002",
      title: "Manifest-only milestone",
      vision: "This enrichment must survive projection delegation.",
      sequence: 2,
    });
    manifest.slices.push({
      ...structuredClone(manifest.slices[0]),
      milestone_id: "M002",
      id: "S02",
      title: "Manifest-only slice",
      risk: "high",
      sequence: 2,
    });
    const interpretation = interpretLegacyGsdCapture(captureFiles(t, {
      "state-manifest.json": JSON.stringify(manifest, null, 2),
      "milestones/M001/M001-ROADMAP.md": [
        "# M001: Adopt canonical authority",
        "",
        "- [ ] S01 Interpret the manifest",
        "",
      ].join("\n"),
    }));

    assert.deepEqual(
      interpretation.complete_row_sets.map((complete) => complete.row_set).sort(),
      ["artifacts", "assessments", "decisions", "milestones", "requirements", "slices", "tasks"],
    );
    assert.deepEqual(
      interpretation.candidates.filter((candidate) => (
        candidate.reason_code.startsWith("state-manifest-")
        && candidate.reason_code.endsWith("-row")
      )).map((candidate) => candidate.target.kind).sort(),
      ["artifact", "assessment", "decision", "milestone", "milestone", "requirement", "slice", "slice", "task"],
    );
    assert.ok(interpretation.candidates.some((candidate) => (
      candidate.target.kind === "milestone" && candidate.target.key === "M001"
      && candidate.raw.locator.line === 1
    )));
    assert.ok(interpretation.candidates.some((candidate) => (
      candidate.target.kind === "slice" && candidate.target.key === "M001/S01"
    )));
    const result = classifyLegacyImportChanges(classificationBase(), interpretation);
    assert.equal(result.applicable, true);
    assert.equal(
      (result.changes.find((change) => change.target.key === "M002")?.normalized as Record<string, unknown>).vision,
      "This enrichment must survive projection delegation.",
    );
    assert.equal(
      (result.changes.find((change) => change.target.key === "M002/S02")?.normalized as Record<string, unknown>).risk,
      "high",
    );
  });

  test("does not duplicate a versioned manifest sketch row with derived evidence", (t) => {
    const manifest = completeStateManifestV1();
    manifest.slices[0].is_sketch = 1;
    manifest.tasks = [];
    manifest.artifacts = [];
    manifest.assessments = [];
    const interpretation = interpretLegacyGsdCapture(captureFiles(t, {
      "state-manifest.json": JSON.stringify(manifest, null, 2),
    }));

    assert.equal(
      interpretation.candidates.filter((candidate) => (
        candidate.classification === "compare"
        && candidate.target.kind === "slice"
        && candidate.target.key === "M001/S01"
      )).length,
      1,
    );
    assert.doesNotThrow(() => classifyLegacyImportChanges(classificationBase(), interpretation));
  });

  test("keeps present empty optional collections authoritative without granting empty hierarchy authority", (t) => {
    const manifest = completeStateManifestV1();
    const [requirement] = manifest.requirements;
    const [artifact] = manifest.artifacts;
    const [assessment] = manifest.assessments;
    manifest.milestones = [];
    manifest.slices = [];
    manifest.tasks = [];
    manifest.requirements = [];
    manifest.artifacts = [];
    manifest.assessments = [];
    const interpretation = interpretLegacyGsdCapture(captureFiles(t, {
      "state-manifest.json": JSON.stringify(manifest, null, 2),
    }));
    const completeByRowSet = new Map(interpretation.complete_row_sets.map((complete) => [complete.row_set, complete]));

    assert.deepEqual([...completeByRowSet.keys()].sort(), [
      "artifacts", "assessments", "decisions", "requirements",
    ]);
    for (const rowSet of ["requirements", "artifacts", "assessments"] as const) {
      const complete = completeByRowSet.get(rowSet);
      assert.ok(complete, `${rowSet}: present empty collection is authoritative`);
      assert.deepEqual(complete.member_keys, [], rowSet);
      assert.deepEqual(complete.raw.value, [], rowSet);
      assert.equal(complete.raw.locator.json_pointer, `/${rowSet}`, rowSet);
    }

    const result = classifyLegacyImportChanges(classificationBase([
      classificationBaseRow("requirements", { id: requirement.id }, requirement),
      classificationBaseRow("artifacts", { path: artifact.path }, artifact),
      classificationBaseRow("assessments", {
        milestone_id: assessment.milestone_id,
        slice_id: assessment.slice_id,
        task_id: assessment.task_id,
        scope: assessment.scope,
      }, assessment),
    ]), interpretation);
    assert.deepEqual(
      result.changes.filter((change) => change.action === "delete").map((change) => (
        [change.target.kind, change.target.key, change.raw.value]
      )).sort(),
      [
        ["artifact", artifact.path, []],
        ["assessment", "M001/S01/T01/run-uat", []],
        ["requirement", requirement.id, []],
      ].sort(),
    );
  });

  test("accepts categorical nonblank requirement identities from StateManifest v1", (t) => {
    const manifest = completeStateManifestV1();
    manifest.requirements[0].id = "NET-01";
    const interpretation = interpretLegacyGsdCapture(captureFiles(t, {
      "state-manifest.json": JSON.stringify(manifest),
    }));
    const source = interpretation.sources.find((candidate) => candidate.path === ".gsd/state-manifest.json");
    const complete = interpretation.complete_row_sets.find((candidate) => candidate.row_set === "requirements");

    assert.equal(source?.outcome, "mapped");
    assert.deepEqual(complete?.member_keys, ["NET-01"]);
    assert.ok(interpretation.candidates.some((candidate) => (
      candidate.target.kind === "requirement" && candidate.target.key === "NET-01"
    )));
  });

  test("treats omitted optional StateManifest v1 collections as non-authoritative", (t) => {
    const manifest = completeStateManifestV1();
    const { requirements: _requirements, artifacts: _artifacts, assessments: _assessments, ...requiredOnly } = manifest;
    const interpretation = interpretLegacyGsdCapture(captureFiles(t, {
      "state-manifest.json": JSON.stringify(requiredOnly),
    }));

    assert.deepEqual(
      interpretation.complete_row_sets.map((complete) => complete.row_set).sort(),
      ["decisions", "milestones", "slices", "tasks"],
    );
    assert.ok(!interpretation.candidates.some((candidate) => (
      candidate.target.kind === "requirement"
      || candidate.target.kind === "artifact"
      || candidate.target.kind === "assessment"
    )));
  });

  test("keeps a complete StateManifest authoritative beside non-owning sibling evidence", (t) => {
    const database = readFileSync(fileURLToPath(new URL(
      "./action-matrix/source/.gsd/gsd.db",
      CORPUS_ROOT,
    )));
    const variants = [
      { name: "operator STATE narrative", path: "STATE.md", content: "# State\n\nOperator narrative.\n", preserved: true },
      { name: "captured gsd.db", path: "gsd.db", content: database, preserved: false },
      {
        name: "milestone context artifact",
        path: "milestones/M001/M001-CONTEXT.md",
        content: "# Context\n\nProjection-only planning notes.\n",
        preserved: true,
      },
    ] as const;
    const expectedRowSets = [
      "artifacts", "assessments", "decisions", "milestones", "requirements", "slices", "tasks",
    ];

    const observed = variants.map((variant) => {
      const interpretation = interpretLegacyGsdCapture(captureFiles(t, {
        "state-manifest.json": JSON.stringify(completeStateManifestV1()),
        [variant.path]: variant.content,
      }));
      return {
        name: variant.name,
        complete_row_sets: interpretation.complete_row_sets.map((complete) => complete.row_set).sort(),
        full_row_kinds: interpretation.candidates.filter((candidate) => (
          candidate.reason_code.startsWith("state-manifest-")
          && candidate.reason_code.endsWith("-row")
        )).map((candidate) => candidate.target.kind).sort(),
        sibling_preserved: interpretation.candidates.some((candidate) => (
          candidate.classification === "preserve" && candidate.target.key === `.gsd/${variant.path}`
        )),
      };
    });

    assert.deepEqual(observed, variants.map((variant) => ({
      name: variant.name,
      complete_row_sets: expectedRowSets,
      full_row_kinds: ["artifact", "assessment", "decision", "milestone", "requirement", "slice", "task"],
      sibling_preserved: variant.preserved,
    })));
  });

  test("fails an invalid StateManifest v1 member closed before any collection contributes truth", (t) => {
    const invalidScenarios: ReadonlyArray<readonly [
      string,
      (manifest: ReturnType<typeof completeStateManifestV1>) => void,
    ]> = [
      ["unknown milestone field", (manifest) => {
        (manifest.milestones[0] as unknown as Record<string, unknown>)["future_field"] = "not-v1";
      }],
      ["invalid slice field type", (manifest) => {
        (manifest.slices[0] as unknown as Record<string, unknown>)["risk"] = 7;
      }],
      ["invalid task field type", (manifest) => {
        (manifest.tasks[0] as unknown as Record<string, unknown>)["blocker_discovered"] = 1;
      }],
      ["invalid requirement identity", (manifest) => {
        (manifest.requirements[0] as unknown as Record<string, unknown>)["id"] = "";
      }],
      ["non-string requirement identity", (manifest) => {
        (manifest.requirements[0] as unknown as Record<string, unknown>)["id"] = 7;
      }],
      ["invalid artifact field type", (manifest) => {
        (manifest.artifacts[0] as unknown as Record<string, unknown>)["content_hash"] = 7;
      }],
      ["invalid assessment hierarchy", (manifest) => {
        (manifest.assessments[0] as unknown as Record<string, unknown>)["task_id"] = 7;
      }],
      ["orphan slice identity", (manifest) => {
        manifest.slices[0].milestone_id = "M999";
      }],
    ];

    const outcomes = invalidScenarios.map(([name, mutate]) => {
      const manifest = clonedStateManifestV1();
      mutate(manifest);
      const interpretation = interpretLegacyGsdCapture(captureFiles(t, {
        "state-manifest.json": JSON.stringify(manifest),
      }));
      const source = interpretation.sources.find((candidate) => (
        candidate.path === ".gsd/state-manifest.json"
      ));
      const blocker = interpretation.diagnoses.find((diagnosis) => (
        diagnosis.source_id === source?.source_id && diagnosis.severity === "blocker"
      ));
      return {
        name,
        outcome: source?.outcome,
        candidate_count: interpretation.candidates.length,
        complete_set_count: interpretation.complete_row_sets.length,
        blocker: blocker !== undefined,
        disposition: blocker === undefined ? undefined : interpretation.resolutions.find((resolution) => (
          resolution.diagnosis_id === blocker.diagnosis_id
        ))?.disposition,
      };
    });
    assert.deepEqual(outcomes, invalidScenarios.map(([name]) => ({
      name,
      outcome: "unparsed",
      candidate_count: 0,
      complete_set_count: 0,
      blocker: true,
      disposition: "requires-user",
    })));
  });

  test("fails closed on partial or invalid StateManifest decision snapshots", (t) => {
    const validDecision = {
      seq: 1,
      id: "D001",
      when_context: "Before import",
      scope: "global",
      decision: "Keep one authority",
      choice: "database",
      rationale: "Avoid drift.",
      revisable: "yes",
      made_by: "human",
      source: "discussion",
      superseded_by: null,
    };
    const manifest = {
      version: 1,
      exported_at: "2026-01-01T00:00:00.000Z",
      milestones: [],
      slices: [],
      tasks: [],
      verification_evidence: [],
    };
    const scenarios = {
      "missing decisions": manifest,
      "non-object decision": { ...manifest, decisions: [null] },
      "missing decision property": {
        ...manifest,
        decisions: [{ ...validDecision, source: undefined }],
      },
      "duplicate decision identity": {
        ...manifest,
        decisions: [validDecision, { ...validDecision, seq: 2 }],
      },
    };

    for (const [name, value] of Object.entries(scenarios)) {
      const interpretation = interpretLegacyGsdCapture(captureFiles(t, {
        "state-manifest.json": JSON.stringify(value),
      }));
      assert.deepEqual(
        interpretation.candidates.filter((candidate) => candidate.target.kind === "decision"),
        [],
        name,
      );
      assert.deepEqual(interpretation.complete_row_sets, [], name);
      const source = interpretation.sources.find((candidate) => (
        candidate.path === ".gsd/state-manifest.json"
      ));
      assert.equal(source?.outcome, "unparsed", name);
      const diagnosis = interpretation.diagnoses.find((candidate) => (
        candidate.source_id === source?.source_id
        && candidate.code === "invalid-state-manifest-decision-snapshot"
      ));
      assert.ok(diagnosis, name);
      assert.equal(diagnosis.severity, "blocker", name);
      assert.equal(
        interpretation.resolutions.find((resolution) => (
          resolution.diagnosis_id === diagnosis.diagnosis_id
        ))?.disposition,
        "requires-user",
        name,
      );
    }
  });

  test("preserves registry semantics across canonical and lowercase filenames", (t) => {
    const canonical = captureCase(t, "registries");
    const lowercase = captureCase(t, "registries-lowercase");
    const canonicalResult = interpretLegacyGsdCapture(canonical.capture);
    const lowercaseResult = interpretLegacyGsdCapture(lowercase.capture);
    assert.ok(canonicalResult.candidates.length > 0, "canonical registry interpretation is not empty");
    assert.ok(lowercaseResult.candidates.length > 0, "lowercase registry interpretation is not empty");
    const semantics = (result: LegacyImportGsdInterpretation) => result.candidates.map((candidate) => ({
      classification: candidate.classification,
      target: candidate.target.key.includes(".gsd/")
        ? { ...candidate.target, key: candidate.target.key.toLowerCase() }
        : candidate.target,
      normalized: candidate.normalized !== null
        && typeof candidate.normalized === "object"
        && !Array.isArray(candidate.normalized)
        && "path" in candidate.normalized
        && typeof candidate.normalized.path === "string"
        ? { ...candidate.normalized, path: candidate.normalized.path.toLowerCase() }
        : candidate.normalized,
      reason_code: candidate.reason_code,
    })).sort(compareCanonical);
    assert.deepEqual(semantics(lowercaseResult), semantics(canonicalResult));
  });

  test("maps every checkbox task line in a nested slice plan and flags unsupported ones", (t) => {
    const interpretation = interpretLegacyGsdCapture(captureFiles(t, {
      "milestones/M001/M001-ROADMAP.md": [
        "# M001: Foundation",
        "",
        "- [ ] S01 Core setup",
        "",
      ].join("\n"),
      "milestones/M001/slices/S01/S01-PLAN.md": [
        "# S01: Core setup",
        "",
        "## Tasks",
        "",
        "- [ ] **T01: Make answer() return 42** `est:2m`",
        "- [x] **T02: Add double(n)** `est:2m`",
        "- [ ] **T03** Missing colon grammar",
        "",
        "### T01: Make answer() return 42",
        "",
        "Inputs:",
        "- `src/answer.js`",
        "- `test/answer.test.js`",
        "",
        "Expected Output:",
        "- `src/answer.js` — `answer()` returns `42`",
        "",
        "Verification:",
        "- `node --test test/answer.test.js`",
        "",
        "### T02: Add double(n)",
        "",
        "Verify:",
        "- Verify: `node --test test/double.test.js` exits 0.",
        "",
      ].join("\n"),
    }));

    assert.deepEqual(
      interpretation.candidates
        .filter((candidate) => candidate.target.kind === "task")
        .map((candidate) => [candidate.target.key, candidate.reason_code, candidate.normalized]),
      [
        ["M001/S01/T01", "nested-checkbox-task", {
          id: "T01",
          milestone_id: "M001",
          slice_id: "S01",
          status: "pending",
          title: "Make answer() return 42",
          verify: "node --test test/answer.test.js",
          inputs: ["src/answer.js", "test/answer.test.js"],
          expected_output: ["src/answer.js — answer() returns 42"],
        }],
        ["M001/S01/T02", "nested-checkbox-task", {
          id: "T02",
          milestone_id: "M001",
          slice_id: "S01",
          status: "complete",
          title: "Add double(n)",
          verify: "node --test test/double.test.js",
        }],
      ],
    );
    assert.deepEqual(
      interpretation.diagnoses
        .filter((diagnosis) => diagnosis.code === "unmapped-checkbox-task")
        .map((diagnosis) => [diagnosis.severity, diagnosis.raw_value]),
      [["warning", "- [ ] **T03** Missing colon grammar"]],
    );
  });

  test("fails closed on malformed structured data", (t) => {
    const malformed = interpretLegacyGsdCapture(captureFiles(t, {
      "state-manifest.json": "{\"milestones\":[",
    }));
    assert.deepEqual(malformed.candidates, []);
    assert.equal(malformed.sources[0]?.outcome, "unparsed");
    assert.equal(malformed.diagnoses[0]?.code, "malformed-state-manifest");
    assert.equal(malformed.resolutions[0]?.disposition, "requires-user");
  });

  test("fails closed on invalid UTF-8", (t) => {
    const invalidUtf8 = interpretLegacyGsdCapture(captureFiles(t, {
      "REQUIREMENTS.md": Buffer.from([0x23, 0x20, 0xc3, 0x28]),
    }));
    assert.deepEqual(invalidUtf8.candidates, []);
    assert.equal(invalidUtf8.sources[0]?.encoding, "binary");
    assert.equal(invalidUtf8.sources[0]?.outcome, "unparsed");
    assert.equal(invalidUtf8.diagnoses[0]?.code, "unsupported-gsd-encoding");
    assert.equal(invalidUtf8.resolutions[0]?.disposition, "unsupported");
  });

  test("records symlink bytes without interpreting their target content", (t) => {
    const base = temporaryDirectory(t);
    const gsd = join(base, ".gsd");
    const support = join(base, "support.md");
    mkdirSync(gsd);
    writeFileSync(support, "# Requirements\n\n### R001 — Must not follow this link\n");
    symlinkSync(support, join(gsd, "REQUIREMENTS.md"));
    const roots: readonly LegacyImportSourceRoot[] = [
      { id: "gsd", kind: "project", physical_path: gsd, logical_path: ".gsd", presence: "required" },
      { id: "support", kind: "external", physical_path: support, logical_path: "support", presence: "required" },
    ];
    const symlink = interpretLegacyGsdCapture(captureLegacyImportSourceSet({ roots }));
    const linkedSource = symlink.sources.find((source) => source.path === ".gsd/REQUIREMENTS.md");
    assert.equal(linkedSource?.kind, "symlink");
    assert.equal(linkedSource?.outcome, "unparsed");
    assert.ok(!symlink.candidates.some((candidate) => candidate.target.key === "R001"));
    assert.ok(symlink.diagnoses.some((diagnosis) => diagnosis.code === "unsupported-gsd-symlink"));
  });

  test("rejects forged database evidence identity", (t) => {
    const captured = captureCase(t, "lifecycle-truth-matrix");
    const evidence = captured.databaseEvidence[0]!;
    assert.throws(
      () => interpretLegacyGsdCapture(captured.capture, [{ ...evidence, evidence_hash: hashLegacyImportBytes(Buffer.from("forged")) }]),
      /database evidence identity/i,
    );
  });

  test("rejects database evidence linked to the wrong source fingerprint", (t) => {
    const captured = captureCase(t, "lifecycle-truth-matrix");
    const evidence = captured.databaseEvidence[0]!;
    assert.throws(
      () => interpretLegacyGsdCapture(captured.capture, [rehashEvidence(evidence, { source_sha256: hashLegacyImportBytes(Buffer.from("wrong")) })]),
      /database evidence source/i,
    );
  });

  test("rejects database evidence outside the captured byte range", (t) => {
    const captured = captureCase(t, "lifecycle-truth-matrix");
    const evidence = captured.databaseEvidence[0]!;
    const forgedObservation = {
      ...evidence.observations[0]!,
      raw: { ...evidence.observations[0]!.raw, locator: { start_byte: evidence.source_byte_size + 1, end_byte: evidence.source_byte_size + 2 } },
    };
    assert.throws(
      () => interpretLegacyGsdCapture(captured.capture, [rehashEvidence(evidence, { observations: [forgedObservation, evidence.observations[1]!] })]),
      /database evidence span/i,
    );
  });

  test("requires complete database coverage and exact raw normalization", (t) => {
    const captured = captureCase(t, "lifecycle-truth-matrix");
    const evidence = captured.databaseEvidence[0]!;
    const withoutEvidence = interpretLegacyGsdCapture(captured.capture);
    const database = withoutEvidence.sources.find((source) => source.path === ".gsd/gsd.db");
    assert.equal(database?.outcome, "unparsed");
    assert.ok(withoutEvidence.diagnoses.some((diagnosis) => diagnosis.code === "missing-complete-database-evidence"));

    const incompleteCoverage = rehashEvidence(evidence, {
      coverage: evidence.coverage.map((coverage) => (
        coverage.table === "slices" ? { ...coverage, row_count: 0 } : coverage
      )),
    });
    assert.throws(
      () => interpretLegacyGsdCapture(captured.capture, [incompleteCoverage]),
      /database evidence coverage/i,
    );

    const forgedObservation = {
      ...evidence.observations[0]!,
      value: ["FORGED"],
    };
    assert.throws(
      () => interpretLegacyGsdCapture(captured.capture, [rehashEvidence(evidence, {
        observations: [forgedObservation, evidence.observations[1]!],
      })]),
      /database evidence span/i,
    );

    const joinedKeyObservation = {
      ...evidence.observations[0]!,
      key: { "id,milestone_id": "joined-key" },
    };
    assert.throws(
      () => interpretLegacyGsdCapture(captured.capture, [rehashEvidence(evidence, {
        observations: [joinedKeyObservation, evidence.observations[1]!],
      })]),
      /database evidence span/i,
    );

    const duplicateObservationEvidence = rehashEvidence(evidence, {
      coverage: evidence.coverage.map((coverage) => (
        coverage.table === "slices" ? { ...coverage, row_count: 2 } : coverage
      )),
      observations: [evidence.observations[0]!, evidence.observations[0]!, evidence.observations[1]!],
    });
    assert.throws(
      () => interpretLegacyGsdCapture(captured.capture, [duplicateObservationEvidence]),
      /database evidence observations are duplicated/i,
    );
  });

  test("preserves unrecognized UTF-8 artifacts with explicit evidence", (t) => {
    const interpretation = interpretLegacyGsdCapture(captureFiles(t, {
      "UNKNOWN.md": "# Unknown retained surface\n",
    }));
    assert.equal(interpretation.sources[0]?.outcome, "preserved");
    assert.equal(interpretation.candidates[0]?.classification, "preserve");
    assert.equal(interpretation.diagnoses[0]?.code, "unrecognized-gsd-artifact");
    assert.equal(interpretation.resolutions[0]?.disposition, "preserved");
  });

  test("reads assessment JSON independently of formatting and normalizes before conflict checks", (t) => {
    const manifest = JSON.stringify({
      assessments: [{
        full_content: "**Verdict:** PASSED",
        scope: "run-uat",
        status: "passed",
        slice_id: "S01",
        milestone_id: "M001",
      }],
    }, null, 2);
    const interpretation = interpretLegacyGsdCapture(captureFiles(t, {
      "state-manifest.json": manifest,
      "milestones/M001/slices/S01/S01-ASSESSMENT.md": "# Assessment\n\n**Verdict:** PASS\n",
    }));
    assert.ok(interpretation.candidates.some((candidate) => (
      candidate.target.key === "M001/S01/run-uat"
      && candidate.normalized !== null
      && typeof candidate.normalized === "object"
      && !Array.isArray(candidate.normalized)
      && "verdict" in candidate.normalized
      && candidate.normalized.verdict === "pass"
    )));
    assert.ok(!interpretation.diagnoses.some((diagnosis) => (
      diagnosis.code === "structured-assessment-vs-artifact-conflict"
    )));
  });

  test("fails closed on malformed assessment manifest entries without runtime errors", (t) => {
    const interpretation = interpretLegacyGsdCapture(captureFiles(t, {
      "state-manifest.json": JSON.stringify({ assessments: [null] }),
    }));
    assert.equal(interpretation.sources[0]?.outcome, "unparsed");
    assert.equal(interpretation.diagnoses[0]?.code, "invalid-assessment-manifest");
    assert.equal(interpretation.resolutions[0]?.disposition, "requires-user");
  });

  test("handles alternate lifecycle manifests without fixture-shaped assumptions", (t) => {
    const empty = interpretLegacyGsdCapture(captureFiles(t, {
      "state-manifest.json": "{}",
    }));
    assert.equal(empty.sources[0]?.outcome, "mapped");
    assert.deepEqual(empty.candidates, []);

    const invalidRoot = interpretLegacyGsdCapture(captureFiles(t, {
      "state-manifest.json": "null",
      "milestones/M123/M123-ROADMAP.md": "# M123: Alternate\n",
    }));
    assert.ok(invalidRoot.sources.some((source) => source.outcome === "unparsed"));
    assert.ok(invalidRoot.diagnoses.some((diagnosis) => (
      diagnosis.code === "unsupported-lifecycle-manifest-schema"
    )));

    const pretty = interpretLegacyGsdCapture(captureFiles(t, {
      "state-manifest.json": JSON.stringify({
        milestones: [{ id: "M123", status: "active" }],
        slices: [],
        tasks: [],
      }, null, 2),
    }));
    assert.ok(pretty.candidates.some((candidate) => (
      candidate.target.kind === "milestone-status"
      && candidate.target.key === "M123"
      && candidate.normalized === "active"
    )));
  });

  test("models lifecycle artifacts in the flat-phase layout", (t) => {
    const interpretation = interpretLegacyGsdCapture(captureFiles(t, {
      "state-manifest.json": JSON.stringify({
        milestones: [{ id: "M001", status: "active" }],
        slices: [{ milestone_id: "M001", id: "S01", status: "active" }],
        tasks: [{ milestone_id: "M001", slice_id: "S01", id: "T01", status: "active" }],
      }),
      "phases/01-recovery/01-01-PLAN.md": "# S01: Recovery\n\n- [ ] T01: Repair drift\n",
      "phases/01-recovery/S01-T01-SUMMARY.md": "# T01 Summary\n\nThe repair passed verification.\n",
    }));

    assert.deepEqual(
      interpretation.sources.map((source) => [source.path, source.parser_id, source.outcome]),
      [
        [".gsd/phases/01-recovery/01-01-PLAN.md", "gsd-lifecycle-truth", "mapped"],
        [".gsd/phases/01-recovery/S01-T01-SUMMARY.md", "gsd-lifecycle-truth", "mapped"],
        [".gsd/state-manifest.json", "gsd-lifecycle-truth", "mapped"],
      ],
    );
    assert.ok(interpretation.candidates.some((candidate) => (
      candidate.target.kind === "task-status"
      && candidate.target.key === "M001/S01/T01"
      && candidate.normalized === "complete"
    )));
  });

  test("models compatibility and team-mode flat-phase lifecycle paths", (t) => {
    const interpretation = interpretLegacyGsdCapture(captureFiles(t, {
      "state-manifest.json": JSON.stringify({
        milestones: [{ id: "M002-abc123", status: "active" }],
        slices: [{ milestone_id: "M002-abc123", id: "S01", status: "active" }],
        tasks: [{ milestone_id: "M002-abc123", slice_id: "S01", id: "T01", status: "active" }],
      }),
      "phases/02-abc123-recovery/01-PLAN.md": "# S01: Recovery\n\n- [ ] T01: Repair drift\n",
      "phases/02-abc123-recovery/T01-SUMMARY.md": [
        "---",
        "parent: S01",
        "---",
        "# T01 Summary",
        "",
        "The repair passed verification.",
      ].join("\n"),
    }));

    assert.ok(interpretation.sources.every((source) => (
      source.parser_id === "gsd-lifecycle-truth" && source.outcome === "mapped"
    )));
    assert.ok(interpretation.candidates.some((candidate) => (
      candidate.target.kind === "task-status"
      && candidate.target.key === "M002-abc123/S01/T01"
      && candidate.normalized === "complete"
    )));
  });

  test("does not fabricate a dependency conflict from complete zero-row evidence", (t) => {
    const captured = captureCase(t, "lifecycle-truth-matrix");
    const evidence = captured.databaseEvidence[0]!;
    const zeroRows = rehashEvidence(evidence, {
      coverage: evidence.coverage.map((coverage) => ({ ...coverage, row_count: 0 })),
      observations: [],
    });
    const interpretation = interpretLegacyGsdCapture(captured.capture, [zeroRows]);
    assert.ok(!interpretation.diagnoses.some((diagnosis) => (
      diagnosis.code === "slices-depends-vs-slice-dependencies-conflict"
    )));
  });

  test("preserves unknown files beside recognized lifecycle artifacts", (t) => {
    const interpretation = interpretLegacyGsdCapture(captureFiles(t, {
      "state-manifest.json": JSON.stringify({ milestones: [], slices: [], tasks: [] }),
      "UNKNOWN.md": "# Unknown beside lifecycle\n",
    }));
    const unknown = interpretation.sources.find((source) => source.path === ".gsd/UNKNOWN.md");
    assert.equal(unknown?.outcome, "preserved");
    assert.ok(interpretation.diagnoses.some((diagnosis) => (
      diagnosis.source_id === unknown?.source_id && diagnosis.code === "unrecognized-gsd-artifact"
    )));
  });

  test("classifies hybrid conflicts from structure rather than fixture vocabulary", (t) => {
    const diagnose = (word: string) => interpretLegacyGsdCapture(captureFiles(t, {
      "milestones/M007-alpha/M007-ROADMAP.md": `# M007: Alpha ${word}\n\n- [ ] S01 Alpha delivery\n`,
      "phases/07-beta/07-ROADMAP.md": `# 007: Beta ${word}\n\n- [ ] S01 Beta delivery\n`,
    })).diagnoses.map((diagnosis) => diagnosis.code).sort();
    const expected = ["duplicate-logical-milestone", "hybrid-conflicting-content"];
    assert.deepEqual(diagnose("capstone"), expected);
    assert.deepEqual(diagnose("launch"), expected);
  });

  test("fails closed on malformed and duplicate lifecycle identities", (t) => {
    const malformed = interpretLegacyGsdCapture(captureFiles(t, {
      "state-manifest.json": JSON.stringify({
        milestones: [{ id: 1, status: "active" }],
        slices: [],
        tasks: [],
      }),
    }));
    assert.equal(malformed.sources[0]?.outcome, "unparsed");
    assert.equal(malformed.diagnoses[0]?.code, "unsupported-lifecycle-manifest-schema");

    const duplicate = interpretLegacyGsdCapture(captureFiles(t, {
      "state-manifest.json": JSON.stringify({
        milestones: [{ id: "M001", status: "active" }, { id: "M001", status: "pending" }],
        slices: [],
        tasks: [],
      }),
    }));
    assert.equal(duplicate.sources[0]?.outcome, "unparsed");
    assert.equal(duplicate.diagnoses[0]?.code, "unsupported-lifecycle-manifest-schema");
  });

  test("reconciles database conflicts without a lifecycle manifest", (t) => {
    const fixture = captureCase(t, "lifecycle-truth-matrix");
    const databaseOnly = captureFiles(t, {
      "gsd.db": payloadBytes(fixture.capture, ".gsd/gsd.db"),
    });
    const evidence = lifecycleDatabaseEvidence(databaseOnly, fixture.oracle);
    const interpretation = interpretLegacyGsdCapture(databaseOnly, [evidence]);
    assert.equal(interpretation.candidates.filter((candidate) => (
      candidate.reason_code === "dependency-conflict-raw-evidence"
    )).length, 2);
    assert.ok(interpretation.diagnoses.some((diagnosis) => (
      diagnosis.code === "slices-depends-vs-slice-dependencies-conflict"
    )));
  });

  test("keeps roadmap and manifest lifecycle evidence provenance separate", (t) => {
    const captured = captureCompositeT04(t);
    const interpretation = interpretLegacyGsdCapture(captured.capture);
    const roadmapMilestone = interpretation.candidates.find((candidate) => (
      candidate.target.kind === "milestone" && candidate.target.key === "M702"
      && candidate.reason_code === "hybrid-non-overlap"
    ));
    assert.deepEqual(roadmapMilestone?.normalized, {
      id: "M702",
      layout: "nested",
      title: "Clean database adoption",
    });
    const manifestMilestone = interpretation.candidates.find((candidate) => (
      candidate.target.kind === "milestone" && candidate.target.key === "M702"
      && candidate.reason_code === "state-manifest-milestone-row"
    ));
    assert.equal(
      (manifestMilestone?.normalized as Record<string, unknown>).vision,
      "Classify legacy evidence without mutation.",
    );
    const manifestStatus = interpretation.candidates.find((candidate) => (
      candidate.target.kind === "milestone-status" && candidate.target.key === "M702"
    ));
    assert.equal(manifestStatus?.normalized, "active");
    assert.equal(manifestStatus?.raw.locator.json_pointer, "/milestones/0/status");

    const sourceParserIds = new Map(interpretation.sources.map((source) => [source.source_id, source.parser_id]));
    for (const candidate of interpretation.candidates) {
      assert.equal(candidate.provenance.parser_id, sourceParserIds.get(candidate.provenance.source_id));
    }
  });

  test("fails closed on a recognized roadmap without a canonical heading", (t) => {
    const interpretation = interpretLegacyGsdCapture(captureFiles(t, {
      "milestones/M123/M123-ROADMAP.md": "# M123 malformed\n\n- [ ] S01 Work\n",
    }));
    assert.equal(interpretation.sources[0]?.outcome, "unparsed");
    assert.deepEqual(interpretation.candidates, []);
    assert.equal(interpretation.diagnoses[0]?.code, "malformed-roadmap");
    assert.equal(interpretation.resolutions[0]?.disposition, "requires-user");
  });

  test("imports legacy CLOSED milestone headings and phase status tables", (t) => {
    const interpretation = interpretLegacyGsdCapture(captureFiles(t, {
      "phases/01-foundation/01-ROADMAP.md": [
        "## ✅ v2.7.0 milestone (CLOSED 2026-08-18 — shipped)",
        "",
        "| Phase | Name | Status |",
        "| --- | --- | --- |",
        "| 1 | Foundation | Complete |",
        "| 2 | Follow-up | Pending |",
      ].join("\n"),
    }));

    assert.deepEqual(
      interpretation.candidates
        .filter((candidate) => candidate.target.kind === "milestone" || candidate.target.kind === "slice")
        .map((candidate) => [candidate.target, candidate.normalized]),
      [
        [
          { kind: "milestone", key: "M001" },
          { id: "M001", source_alias: "01", status: "complete", title: "v2.7.0 milestone" },
        ],
        [
          { kind: "slice", key: "M001/S01" },
          { id: "S01", milestone_id: "M001", status: "complete", title: "Foundation" },
        ],
        [
          { kind: "slice", key: "M001/S02" },
          { id: "S02", milestone_id: "M001", status: "pending", title: "Follow-up" },
        ],
      ],
    );
    assert.deepEqual(interpretation.diagnoses, []);
  });

  test("quarantines every occurrence of a duplicate requirement identity", (t) => {
    const captured = captureCase(t, "registries");
    const interpretation = interpretLegacyGsdCapture(captured.capture);
    assert.ok(!interpretation.candidates.some((candidate) => (
      candidate.target.kind === "requirement" && candidate.target.key === "R001"
    )));
    assert.ok(interpretation.diagnoses.some((diagnosis) => diagnosis.code === "duplicate-requirement-id"));
  });

  test("emits assessment and lifecycle truth from one mixed manifest", (t) => {
    const interpretation = interpretLegacyGsdCapture(captureFiles(t, {
      "state-manifest.json": JSON.stringify({
        milestones: [{ id: "M001", status: "active" }],
        slices: [{ milestone_id: "M001", id: "S01", status: "active" }],
        tasks: [{ milestone_id: "M001", slice_id: "S01", id: "T01", status: "active" }],
        assessments: [{
          milestone_id: "M001",
          slice_id: "S01",
          status: "pass",
          scope: "run-uat",
          full_content: "**Verdict:** PASS",
        }],
      }),
    }));
    const targets = new Set(interpretation.candidates.map((candidate) => (
      `${candidate.target.kind}:${candidate.target.key}`
    )));
    assert.ok(targets.has("milestone-status:M001"));
    assert.ok(targets.has("slice-status:M001/S01"));
    assert.ok(targets.has("task-status:M001/S01/T01"));
    assert.ok(targets.has("assessment:M001/S01/run-uat"));
    assert.equal(interpretation.sources[0]?.parser_id, "gsd-lifecycle-truth");
    assert.ok(interpretation.candidates.every((candidate) => (
      candidate.provenance.parser_id === "gsd-lifecycle-truth"
    )));
  });

  test("emits no truth from a mixed manifest when its assessment schema is invalid", (t) => {
    const interpretation = interpretLegacyGsdCapture(captureFiles(t, {
      "state-manifest.json": JSON.stringify({
        milestones: [{ id: "M001", status: "active" }],
        slices: [],
        tasks: [],
        assessments: [null],
      }),
    }));
    assert.equal(interpretation.sources[0]?.outcome, "unparsed");
    assert.deepEqual(interpretation.candidates, []);
    assert.ok(interpretation.diagnoses.some((diagnosis) => (
      diagnosis.code === "invalid-assessment-manifest"
    )));
  });

  test("emits no truth from a mixed manifest when its lifecycle schema is invalid", (t) => {
    const interpretation = interpretLegacyGsdCapture(captureFiles(t, {
      "state-manifest.json": JSON.stringify({
        milestones: [{ id: 1, status: "active" }],
        slices: [],
        tasks: [],
        assessments: [{
          milestone_id: "M001",
          slice_id: "S01",
          status: "pass",
          scope: "run-uat",
          full_content: "**Verdict:** PASS",
        }],
      }),
      "milestones/M001/M001-SUMMARY.md": "# M001 Summary\n",
    }));
    assert.ok(interpretation.sources.some((source) => source.outcome === "unparsed"));
    assert.ok(interpretation.diagnoses.some((diagnosis) => (
      diagnosis.code === "unsupported-lifecycle-manifest-schema"
    )));
    assert.deepEqual(interpretation.candidates.map((candidate) => candidate.target), [{
      kind: "legacy-artifact",
      key: ".gsd/milestones/M001/M001-SUMMARY.md",
    }]);
  });

  test("does not derive projection conflicts from an invalid mixed manifest", (t) => {
    const interpretation = interpretLegacyGsdCapture(captureFiles(t, {
      "state-manifest.json": JSON.stringify({
        milestones: [{ id: "M001", status: "active" }],
        slices: [],
        tasks: [],
        assessments: [null],
      }),
      "milestones/M001/M001-SUMMARY.md": "# M001 Summary\n",
    }));
    assert.ok(interpretation.sources.some((source) => source.outcome === "unparsed"));
    assert.ok(!interpretation.candidates.some((candidate) => (
      candidate.reason_code === "milestone-summary-precedence"
    )));
    assert.ok(!interpretation.diagnoses.some((diagnosis) => (
      diagnosis.code === "projection-conflicts-with-adopted-lifecycle"
    )));
    assert.ok(interpretation.candidates.some((candidate) => (
      candidate.target.kind === "legacy-artifact"
      && candidate.target.key === ".gsd/milestones/M001/M001-SUMMARY.md"
    )));
  });
});
