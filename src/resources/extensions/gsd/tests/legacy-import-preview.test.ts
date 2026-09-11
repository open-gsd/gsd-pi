// Project/App: gsd-pi
// File Purpose: Preview identity and atomic current-authority base snapshot tests.

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import {
  LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION,
  LEGACY_IMPORT_PREVIEW_TOP_LEVEL_KEYS,
  type LegacyImportPreviewEnvelope,
  type LegacyImportSha256,
  type LegacyImportValue,
} from "../legacy-import-contract.ts";
import {
  LEGACY_IMPORT_BASE_ROW_SETS,
  LegacyImportBaseSnapshotError,
  captureLegacyImportBaseSnapshot,
  captureCurrentLegacyImportBaseSnapshot,
  type LegacyImportBaseSnapshot,
  type LegacyImportBaseSnapshotSource,
} from "../legacy-import-preview-base.ts";
import { classifyLegacyImportChanges } from "../legacy-import-preview-classifier.ts";
import { compileLegacyImportApplicationPlan } from "../legacy-import-application-plan.ts";
import {
  collectLegacyImportDatabaseTargetEvidence,
} from "../legacy-import-preview-database-target.ts";
import { inspectLegacyImportDatabaseTarget } from "../legacy-import-database-target-inspector.ts";
import { interpretLegacyGsdCapture } from "../legacy-import-preview-gsd.ts";
import type { LegacyImportInterpretation } from "../legacy-import-preview-interpretation.ts";
import { interpretLegacyPlanningCapture } from "../legacy-import-preview-planning.ts";
import {
  captureLegacyImportSourceSet,
  LegacyImportSourceError,
  type LegacyImportSourceCapture,
  type LegacyImportSourceRoot,
} from "../legacy-import-preview-source.ts";
import { interpretLegacySupplementalCapture } from "../legacy-import-preview-supplemental.ts";
import {
  _createLegacyImportPreviewForTest,
  canonicalLegacyImportJson,
  createLegacyImportPreview,
  hashLegacyImportValue,
  isValidLegacyImportPreviewArtifact,
  LegacyImportPreviewError,
  resolveLegacyImportPreview,
  revalidateLegacyImportPreview,
  sealLegacyImportPreview,
  type LegacyImportPreviewArtifact,
  type LegacyImportPreviewCreateInput,
  type LegacyImportPreviewSealInput,
} from "../legacy-import-preview.ts";
import { finalizeLegacyImportInterpretation } from "../legacy-import-preview-interpretation.ts";
import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";
import {
  assertStableClassificationHashes,
  classificationBase,
  classificationCandidate,
  classificationInterpretation,
  classificationSource,
} from "./legacy-import-preview-classification-fixtures.ts";

const ONE_HASH = `sha256:${"1".repeat(64)}` as LegacyImportSha256;
const EMPTY_HASH = hashLegacyImportValue([]);
const LEGACY_CORPUS_ROOT = new URL("./__fixtures__/legacy-import-corpus/v1/", import.meta.url);
const EXPECTED_BASE_ROW_SETS = [
  "milestones",
  "slices",
  "tasks",
  "slice_dependencies",
  "requirements",
  "artifacts",
  "assessments",
  "decisions",
  "decision_memories",
  "item_lifecycles",
] as const;
const EXPECTED_BASE_ROW_KEYS: Record<(typeof EXPECTED_BASE_ROW_SETS)[number], readonly string[]> = {
  milestones: [
    "id", "title", "status", "depends_on", "completed_at", "vision", "success_criteria",
    "key_risks", "proof_strategy", "verification_contract", "verification_integration",
    "verification_operational", "verification_uat", "definition_of_done",
    "requirement_coverage", "boundary_map_markdown", "sequence",
  ],
  slices: [
    "milestone_id", "id", "title", "status", "risk", "depends", "demo", "completed_at",
    "full_summary_md", "full_uat_md", "goal", "success_criteria", "proof_level",
    "integration_closure", "observability_impact", "target_repositories", "sequence",
    "replan_triggered_at", "is_sketch", "sketch_scope",
  ],
  tasks: [
    "milestone_id", "slice_id", "id", "title", "status", "one_liner", "narrative",
    "verification_result", "duration", "completed_at", "blocker_discovered", "blocker_source",
    "escalation_pending", "escalation_awaiting_review", "escalation_artifact_path",
    "escalation_override_applied_at", "deviations", "known_issues", "key_files", "key_decisions",
    "full_summary_md", "description", "estimate", "files", "verify", "inputs", "expected_output",
    "observability_impact", "full_plan_md", "target_repositories", "sequence",
  ],
  slice_dependencies: ["milestone_id", "slice_id", "depends_on_slice_id"],
  requirements: [
    "id", "class", "status", "description", "why", "source", "primary_owner",
    "supporting_slices", "validation", "notes", "full_content", "superseded_by",
  ],
  artifacts: ["path", "artifact_type", "milestone_id", "slice_id", "task_id", "full_content", "content_hash"],
  assessments: ["path", "milestone_id", "slice_id", "task_id", "status", "scope", "full_content"],
  decisions: [
    "id", "when_context", "scope", "decision", "choice", "rationale", "revisable",
    "made_by", "source", "superseded_by",
  ],
  decision_memories: ["source_decision_id", "structured_fields"],
  item_lifecycles: [
    "project_id", "item_kind", "milestone_id", "slice_id", "task_id",
    "lifecycle_status", "state_version", "last_operation_id",
  ],
};

function previewSource() {
  return {
    source_id: "source-1",
    path: ".gsd/STATE.md",
    kind: "markdown",
    byte_size: 4,
    sha256: ONE_HASH,
    parser_id: "state",
    parser_version: "1",
    encoding: "utf-8" as const,
    outcome: "preserved" as const,
  };
}

function previewChange() {
  return {
    change_id: "change-1",
    action: "preserve" as const,
    target: { kind: "legacy-artifact", key: ".gsd/STATE.md" },
    raw: {
      source_id: "source-1",
      locator: { start_byte: 0, end_byte: 4, line: 1 },
      value: "raw",
      sha256: ONE_HASH,
    },
    normalized: { value: "raw" },
    provenance: { source_id: "source-1", parser_id: "state", parser_version: "1" },
    reason_code: "preserve-state",
  };
}

function sealInput(): LegacyImportPreviewSealInput {
  return {
    import_kind: "legacy-markdown",
    importer_version: "1",
    base: {
      snapshot_schema_version: 1,
      database_schema_version: LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION,
      authority: {
        singleton: 1,
        project_id: "project-1",
        project_root_realpath: "",
        revision: 7,
        authority_epoch: 2,
        created_at: "",
        updated_at: "",
      },
      rows: [],
      relevant_rows_hash: EMPTY_HASH,
    },
    source_set_hash: EMPTY_HASH,
    change_set_hash: EMPTY_HASH,
    counts: { create: 0, update: 0, delete: 0, preserve: 0, unparsed: 0, unresolved: 0 },
    sources: [],
    changes: [],
    diagnoses: [],
    resolutions: [],
  };
}

function sealInputWithEvidence(): LegacyImportPreviewSealInput {
  const input = sealInput();
  input.sources = [previewSource()];
  input.changes = [previewChange()];
  input.diagnoses = [{
    diagnosis_id: "diagnosis-1",
    code: "ambiguous-state",
    severity: "blocker",
    source_id: "source-1",
    locator: { start_byte: 0, end_byte: 4, line: 1 },
    raw_value: "raw",
    message: "State is ambiguous.",
  }];
  input.resolutions = [{ diagnosis_id: "diagnosis-1", disposition: "requires-user" }];
  input.counts = { ...input.counts, preserve: 1, unresolved: 1 };
  input.source_set_hash = hashLegacyImportValue(input.sources);
  input.change_set_hash = hashLegacyImportValue(input.changes);
  return input;
}

function sealInputWithAllCounts(): LegacyImportPreviewSealInput {
  const input = sealInput();
  input.sources = [
    previewSource(),
    { ...previewSource(), source_id: "source-2", path: ".gsd/UNKNOWN.md", outcome: "unparsed" },
  ];
  input.changes = (["create", "update", "delete", "preserve"] as const).map((action, index) => ({
    ...previewChange(),
    change_id: `change-${index + 1}`,
    action,
    target: { kind: "milestone", key: `M00${index + 1}` },
  }));
  input.diagnoses = [
    { diagnosis_id: "diagnosis-1", code: "ambiguous", severity: "blocker", source_id: "source-1", locator: { start_byte: 0, end_byte: 4 }, raw_value: "raw", message: "Ambiguous." },
    { diagnosis_id: "diagnosis-2", code: "unsupported", severity: "blocker", source_id: "source-2", locator: { start_byte: 0, end_byte: 4 }, raw_value: "raw", message: "Unsupported." },
  ];
  input.resolutions = [
    { diagnosis_id: "diagnosis-1", disposition: "requires-user" },
    { diagnosis_id: "diagnosis-2", disposition: "unsupported" },
  ];
  input.counts = { create: 1, update: 1, delete: 1, preserve: 1, unparsed: 1, unresolved: 2 };
  input.source_set_hash = hashLegacyImportValue(input.sources);
  input.change_set_hash = hashLegacyImportValue(input.changes);
  return input;
}

describe("legacy preview identity", () => {
  test("legacy preview identity canonicalizes objects but preserves arrays and exact values", () => {
    const left = { nested: { beta: 2, alpha: 1 }, values: ["a", "b"] };
    const reordered = { values: ["a", "b"], nested: { alpha: 1, beta: 2 } };

    assert.equal(canonicalLegacyImportJson(left), canonicalLegacyImportJson(reordered));
    assert.equal(hashLegacyImportValue(left), hashLegacyImportValue(reordered));
    assert.equal(
      hashLegacyImportValue({ b: 2, a: 1 }),
      "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
    );
    assert.notEqual(hashLegacyImportValue(left), hashLegacyImportValue({ ...left, values: ["b", "a"] }));
    assert.notEqual(hashLegacyImportValue("é"), hashLegacyImportValue("e"));
  });

  test("legacy preview identity rejects values outside strict JSON", () => {
    for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, () => undefined, new Date(0)]) {
      assert.throws(
        () => canonicalLegacyImportJson(value as never),
        /legacy import identity requires (strict JSON|plain JSON objects)/,
      );
    }
    assert.throws(() => canonicalLegacyImportJson(Array(1)), /dense JSON arrays/);
    const extended = ["value"] as string[] & { extra?: string };
    extended.extra = "not-json";
    assert.throws(() => canonicalLegacyImportJson(extended), /dense JSON arrays/);
  });

  test("legacy preview identity seals the exact envelope in a two-field artifact", () => {
    const first = sealLegacyImportPreview(sealInput());
    const second = sealLegacyImportPreview(sealInput());

    assert.deepEqual(first, second);
    assert.deepEqual(Object.keys(first), ["preview", "preview_hash"]);
    assert.deepEqual(Object.keys(first.preview), LEGACY_IMPORT_PREVIEW_TOP_LEVEL_KEYS);
    assert.equal("preview_hash" in first.preview, false);
    assert.match(first.preview.preview_id, /^sha256:[0-9a-f]{64}$/);
    assert.match(first.preview_hash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(first.preview_hash, hashLegacyImportValue(first.preview as never));
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.preview), true);
  });

  test("legacy preview identity changes for every approval-relevant base component", () => {
    const original = sealInput();
    const originalArtifact = sealLegacyImportPreview(original);
    const mutations: Array<[string, (input: LegacyImportPreviewSealInput) => void]> = [
      ["importer version", (input) => { input.importer_version = "2"; }],
      ["import kind", (input) => { input.import_kind = "legacy-gsd"; }],
      ["revision", (input) => { input.base = { ...input.base, authority: { ...input.base.authority, revision: 8 } }; }],
      ["epoch", (input) => { input.base = { ...input.base, authority: { ...input.base.authority, authority_epoch: 3 } }; }],
      ["project", (input) => { input.base = { ...input.base, authority: { ...input.base.authority, project_id: "project-2" } }; }],
      ["root", (input) => { input.base = { ...input.base, authority: { ...input.base.authority, project_root_realpath: "/repo" } }; }],
    ];

    for (const [label, mutate] of mutations) {
      const changed = structuredClone(original);
      mutate(changed);
      const artifact = sealLegacyImportPreview(changed);
      assert.notEqual(artifact.preview.preview_id, originalArtifact.preview.preview_id, label);
      assert.notEqual(artifact.preview_hash, originalArtifact.preview_hash, label);
    }
  });

  test("legacy preview identity binds source, change, and relevant base-row evidence", () => {
    const original = sealInput();
    const originalArtifact = sealLegacyImportPreview(original);

    const sourceChanged = structuredClone(original);
    sourceChanged.sources = [previewSource()];
    sourceChanged.source_set_hash = hashLegacyImportValue(sourceChanged.sources);
    const sourceArtifact = sealLegacyImportPreview(sourceChanged);
    assert.notEqual(sourceArtifact.preview.preview_id, originalArtifact.preview.preview_id);

    const changeChanged = structuredClone(sourceChanged);
    changeChanged.changes = [previewChange()];
    changeChanged.counts = { ...changeChanged.counts, preserve: 1 };
    changeChanged.change_set_hash = hashLegacyImportValue(changeChanged.changes);
    const changeArtifact = sealLegacyImportPreview(changeChanged);
    assert.notEqual(changeArtifact.preview.preview_id, sourceArtifact.preview.preview_id);

    const baseChanged = structuredClone(original);
    baseChanged.base = {
      ...baseChanged.base,
      rows: [{
        row_set: "milestones",
        identity: '{"id":"M001"}',
        value: { id: "M001", title: "Foundation" },
      }],
    };
    baseChanged.base = {
      ...baseChanged.base,
      relevant_rows_hash: hashLegacyImportValue(baseChanged.base.rows),
    };
    const baseArtifact = sealLegacyImportPreview(baseChanged);
    assert.notEqual(baseArtifact.preview.preview_id, originalArtifact.preview.preview_id);
  });

  test("legacy preview identity rejects an unsupported database schema", () => {
    const input = sealInput();
    input.base = {
      ...input.base,
      database_schema_version: 44 as typeof LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION,
    };
    assert.throws(() => sealLegacyImportPreview(input), /database schema 50/);
  });

  test("legacy preview identity rejects import kinds the application receipt cannot store", () => {
    for (const importKind of ["Legacy-Markdown", " legacy-markdown", "legacy-markdown "]) {
      const input = sealInput();
      input.import_kind = importKind;
      assert.throws(() => sealLegacyImportPreview(input), /trimmed lowercase/, importKind);
    }
  });

  test("legacy preview identity rejects stale evidence hashes and counts", () => {
    const staleHashes: Array<[string, (input: LegacyImportPreviewSealInput) => void, RegExp]> = [
      ["base", (input) => { input.base = { ...input.base, relevant_rows_hash: ONE_HASH }; }, /base rows/],
      ["sources", (input) => { input.source_set_hash = ONE_HASH; }, /Preview sources/],
      ["changes", (input) => { input.change_set_hash = ONE_HASH; }, /Preview changes/],
    ];
    for (const [label, mutate, message] of staleHashes) {
      const input = sealInput();
      mutate(input);
      assert.throws(() => sealLegacyImportPreview(input), message, label);
    }

    const wrongCounts = sealInput();
    wrongCounts.counts = { ...wrongCounts.counts, create: 1 };
    assert.throws(() => sealLegacyImportPreview(wrongCounts), /counts do not match evidence/);
  });

  test("legacy preview identity retains ambiguity evidence in the sealed hash", () => {
    const input = sealInputWithEvidence();
    const artifact = sealLegacyImportPreview(input);
    assert.deepEqual(artifact.preview, {
      preview_schema_version: 1,
      preview_id: artifact.preview.preview_id,
      import_kind: input.import_kind,
      importer_version: input.importer_version,
      base_project_revision: input.base.authority.revision,
      base_authority_epoch: input.base.authority.authority_epoch,
      base_database_schema_version: input.base.database_schema_version,
      source_set_hash: input.source_set_hash,
      change_set_hash: input.change_set_hash,
      counts: input.counts,
      sources: input.sources,
      changes: input.changes,
      diagnoses: input.diagnoses,
      resolutions: input.resolutions,
    });

    const withoutAmbiguity = structuredClone(artifact.preview);
    withoutAmbiguity.diagnoses = [];
    withoutAmbiguity.resolutions = [];
    assert.notEqual(hashLegacyImportValue(withoutAmbiguity), artifact.preview_hash);
  });

  test("legacy preview identity is deeply immutable and detached from caller input", () => {
    const input = sealInputWithEvidence();
    const artifact = sealLegacyImportPreview(input);
    const normalized = input.changes[0].normalized as Record<string, string>;
    normalized["value"] = "mutated";
    input.diagnoses[0].message = "Mutated after approval.";

    assert.deepEqual(artifact.preview.changes[0].normalized, { value: "raw" });
    assert.equal(artifact.preview.diagnoses[0].message, "State is ambiguous.");
    assert.equal(Object.isFrozen(artifact.preview.changes), true);
    assert.equal(Object.isFrozen(artifact.preview.changes[0]), true);
    assert.equal(Object.isFrozen(artifact.preview.changes[0].normalized), true);
    assert.equal(Object.isFrozen(artifact.preview.diagnoses[0]), true);
  });

  test("legacy preview identity snapshots getter-backed input before validation", () => {
    const input = sealInput();
    let reads = 0;
    Object.defineProperty(input, "sources", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? [] : [previewSource()];
      },
    });

    const artifact = sealLegacyImportPreview(input);
    assert.equal(reads, 1);
    assert.deepEqual(artifact.preview.sources, []);
    assert.equal(artifact.preview.source_set_hash, hashLegacyImportValue(artifact.preview.sources));
  });

  test("legacy preview identity derives and rejects drift in every count", () => {
    const input = sealInputWithAllCounts();
    assert.doesNotThrow(() => sealLegacyImportPreview(input));
    for (const field of ["create", "update", "delete", "preserve", "unparsed", "unresolved"] as const) {
      const changed = structuredClone(input);
      changed.counts = { ...changed.counts, [field]: changed.counts[field] + 1 };
      assert.throws(() => sealLegacyImportPreview(changed), /counts do not match evidence/, field);
    }
  });

  test("legacy preview identity rejects blank importer and unsupported snapshot schema", () => {
    const blankImporter = sealInput();
    blankImporter.importer_version = " ";
    assert.throws(() => sealLegacyImportPreview(blankImporter), /importer_version must not be blank/);

    const wrongSnapshotSchema = sealInput();
    wrongSnapshotSchema.base = { ...wrongSnapshotSchema.base, snapshot_schema_version: 2 as 1 };
    assert.throws(() => sealLegacyImportPreview(wrongSnapshotSchema), /snapshot schema 1/);
  });

  test("legacy preview identity full-envelope hash catches non-identity evidence drift", () => {
    const artifact = sealLegacyImportPreview(sealInput());
    const changed = structuredClone(artifact.preview) as LegacyImportPreviewEnvelope;
    changed.counts = { ...changed.counts, unparsed: 1 };

    assert.equal(changed.preview_id, artifact.preview.preview_id);
    assert.notEqual(hashLegacyImportValue(changed as never), artifact.preview_hash);
  });

  test("legacy preview identity accepts zero-length evidence locators but rejects inverted spans", () => {
    const zeroLengthChange = (locator: { start_byte: number; end_byte: number; line?: number }) => ({
      change_id: ONE_HASH,
      action: "preserve" as const,
      target: { kind: "legacy-artifact", key: ".gsd/EMPTY.md" },
      raw: { source_id: ONE_HASH, locator, value: "", sha256: ONE_HASH },
      normalized: { value: "" },
      provenance: { source_id: ONE_HASH, parser_id: "state", parser_version: "1" },
      reason_code: "preserve-empty",
    });
    const input = sealInput();
    input.sources = [{ ...previewSource(), source_id: ONE_HASH, byte_size: 0 }];
    input.changes = [zeroLengthChange({ start_byte: 0, end_byte: 0, line: 1 })];
    input.diagnoses = [{
      diagnosis_id: ONE_HASH,
      code: "empty-token",
      severity: "warning",
      source_id: ONE_HASH,
      locator: { start_byte: 1, end_byte: 1 },
      raw_value: "",
      message: "An empty string token is zero-length evidence.",
    }];
    input.resolutions = [{ diagnosis_id: ONE_HASH, disposition: "preserved" }];
    input.counts = { ...input.counts, preserve: 1 };
    input.source_set_hash = hashLegacyImportValue(input.sources);
    input.change_set_hash = hashLegacyImportValue(input.changes);
    assert.equal(isValidLegacyImportPreviewArtifact(sealLegacyImportPreview(input)), true);

    const inverted = structuredClone(input);
    inverted.changes = [zeroLengthChange({ start_byte: 2, end_byte: 1 })];
    inverted.change_set_hash = hashLegacyImportValue(inverted.changes);
    assert.equal(isValidLegacyImportPreviewArtifact(sealLegacyImportPreview(inverted)), false);
  });

  test("legacy preview interpretation finalize does not reorder caller arrays", () => {
    const provenance = { source_id: "source-1", parser_id: "parser", parser_version: "1" };
    const candidates = ["b", "a"].map((key) => ({
      classification: "preserve" as const,
      target: { kind: "legacy-artifact", key },
      raw: {
        source_id: "source-1",
        locator: { start_byte: 0, end_byte: 1, line: 1 },
        value: key,
        sha256: ONE_HASH,
      },
      normalized: key,
      provenance,
      reason_code: `reason-${key}`,
    }));
    const diagnoses = ["b", "a"].map((key, index) => ({
      diagnosis_id: `sha256:${String(index + 2).repeat(64)}` as LegacyImportSha256,
      code: `code-${key}`,
      severity: "warning" as const,
      source_id: "source-1",
      locator: { start_byte: 0, end_byte: 1, line: 1 },
      raw_value: key,
      message: `message-${key}`,
      resolution: { disposition: "preserved" as const },
    }));

    const interpretation = finalizeLegacyImportInterpretation([], candidates, diagnoses);

    assert.deepEqual(candidates.map((candidate) => candidate.target.key), ["b", "a"]);
    assert.deepEqual(diagnoses.map((diagnosis) => diagnosis.code), ["code-b", "code-a"]);
    assert.deepEqual(interpretation.candidates.map((candidate) => candidate.target.key), ["a", "b"]);
    assert.deepEqual(interpretation.diagnoses.map((diagnosis) => diagnosis.code), ["code-a", "code-b"]);
  });
});

function sourceFixture(overrides: Partial<LegacyImportBaseSnapshotSource> = {}) {
  let inTransaction = false;
  const calls: string[] = [];
  const rows = new Map<string, readonly Record<string, unknown>[]>([
    ["milestones", [
      { id: "M002", title: "Second", status: "pending" },
      { id: "M001", title: "First", status: "active" },
    ]],
    ["slices", [{ milestone_id: "M001", id: "S01", title: "Slice" }]],
    ["tasks", [{ milestone_id: "M001", slice_id: "S01", id: "T01", title: "Task" }]],
    ["slice_dependencies", [{ milestone_id: "M001", slice_id: "S02", depends_on_slice_id: "S01" }]],
    ["requirements", [{ id: "R001", description: "Requirement" }]],
    ["artifacts", [{ path: ".gsd/PROJECT.md", full_content: "Project" }]],
    ["assessments", [{
      path: ".gsd/M001-ASSESSMENT.md",
      milestone_id: "M001",
      slice_id: null,
      task_id: null,
      scope: "roadmap",
      status: "pass",
    }]],
    ["decisions", [{ id: "D001", decision: "Decision" }]],
    ["decision_memories", [{ source_decision_id: "D002", structured_fields: '{"sourceDecisionId":"D002"}' }]],
    ["item_lifecycles", [{
      project_id: "project-1",
      item_kind: "milestone",
      milestone_id: "M001",
      slice_id: null,
      task_id: null,
      lifecycle_status: "pending",
      state_version: 0,
      last_operation_id: "operation-1",
    }]],
  ]);
  const assertInside = (name: string) => {
    assert.equal(inTransaction, true, `${name} must run inside readTransaction`);
    calls.push(name);
  };
  const source: LegacyImportBaseSnapshotSource = {
    readSchemaVersion() {
      assertInside("schema");
      return LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION;
    },
    readAuthorityRows() {
      assertInside("authority");
      return [{
        singleton: 1,
        project_id: "project-1",
        project_root_realpath: "",
        revision: 9,
        authority_epoch: 3,
        created_at: "created",
        updated_at: "updated",
      }];
    },
    readRows(rowSet) {
      assertInside(rowSet);
      return rows.get(rowSet) ?? [];
    },
    ...overrides,
  };
  return {
    source,
    calls,
    rows,
    readTransaction<T>(fn: () => T): T {
      assert.equal(inTransaction, false);
      inTransaction = true;
      try {
        return fn();
      } finally {
        inTransaction = false;
      }
    },
  };
}

describe("legacy preview base snapshot", () => {
  test("legacy preview base snapshot captures every relevant row set in one transaction", () => {
    const fixture = sourceFixture();
    let transactionCalls = 0;
    const snapshot = captureLegacyImportBaseSnapshot({
      source: fixture.source,
      readTransaction<T>(fn: () => T): T {
        transactionCalls += 1;
        return fixture.readTransaction(fn);
      },
    });

    assert.equal(transactionCalls, 1);
    assert.deepEqual(LEGACY_IMPORT_BASE_ROW_SETS, EXPECTED_BASE_ROW_SETS);
    assert.deepEqual(fixture.calls, ["schema", "authority", ...EXPECTED_BASE_ROW_SETS]);
    assert.deepEqual(snapshot.rows.map((row) => row.row_set), [
      "milestones",
      "milestones",
      ...EXPECTED_BASE_ROW_SETS.slice(1),
    ]);
    assert.equal(snapshot.rows[0].identity, '{"id":"M001"}');
    assert.equal(snapshot.relevant_rows_hash, hashLegacyImportValue(snapshot.rows));
    const changedRows = structuredClone(snapshot.rows);
    (changedRows[0].value as Record<string, unknown>)["title"] = "Changed";
    assert.notEqual(hashLegacyImportValue(changedRows), snapshot.relevant_rows_hash);
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.rows), true);
  });

  test("legacy preview base snapshot is stable when a reader returns rows in another order", () => {
    const first = sourceFixture();
    const second = sourceFixture();
    second.rows.set("milestones", [...second.rows.get("milestones")!].reverse());

    const left = captureLegacyImportBaseSnapshot(first);
    const right = captureLegacyImportBaseSnapshot(second);
    assert.deepEqual(left, right);
  });

  test("legacy preview base snapshot propagates transaction failures without retry", () => {
    const sentinel = new Error("read snapshot failed");
    let calls = 0;
    assert.throws(
      () => captureLegacyImportBaseSnapshot({
        source: sourceFixture().source,
        readTransaction() {
          calls += 1;
          throw sentinel;
        },
      }),
      (error) => error === sentinel,
    );
    assert.equal(calls, 1);
  });

  test("legacy preview base snapshot fails loudly on malformed authority state", () => {
    const cases: Array<[string, Partial<LegacyImportBaseSnapshotSource>, string]> = [
      ["missing", { readAuthorityRows: () => [] }, "LEGACY_IMPORT_BASE_AUTHORITY_MISSING"],
      ["duplicate", { readAuthorityRows: () => [{}, {}] }, "LEGACY_IMPORT_BASE_AUTHORITY_DUPLICATE"],
      ["unsupported schema", { readSchemaVersion: () => 43 }, "LEGACY_IMPORT_BASE_UNSUPPORTED_SCHEMA"],
      ["blank project", { readAuthorityRows: () => [{ singleton: 1, project_id: "", project_root_realpath: "", revision: 0, authority_epoch: 0, created_at: "", updated_at: "" }] }, "LEGACY_IMPORT_BASE_AUTHORITY_INVALID"],
      ["unsafe revision", { readAuthorityRows: () => [{ singleton: 1, project_id: "p", project_root_realpath: "", revision: Number.MAX_SAFE_INTEGER + 1, authority_epoch: 0, created_at: "", updated_at: "" }] }, "LEGACY_IMPORT_BASE_AUTHORITY_INVALID"],
    ];

    for (const [label, override, code] of cases) {
      const fixture = sourceFixture(override);
      assert.throws(
        () => captureLegacyImportBaseSnapshot(fixture),
        (error) => error instanceof LegacyImportBaseSnapshotError && error.code === code,
        label,
      );
    }
  });

  test("legacy preview base snapshot rejects duplicate logical row identity", () => {
    const fixture = sourceFixture({
      readRows(rowSet) {
        if (rowSet !== "milestones") return [];
        return [
          { id: "M001", title: "one" },
          { id: "M001", title: "conflict" },
        ];
      },
    });

    assert.throws(
      () => captureLegacyImportBaseSnapshot(fixture),
      (error) => error instanceof LegacyImportBaseSnapshotError
        && error.code === "LEGACY_IMPORT_BASE_ROW_DUPLICATE"
        && error.context.row_set === "milestones",
    );

    const memoryFixture = sourceFixture({
      readRows(rowSet) {
        if (rowSet !== "decision_memories") return [];
        return [
          { source_decision_id: "D001", structured_fields: '{"sourceDecisionId":"D001","choice":"one"}' },
          { source_decision_id: "D001", structured_fields: '{"sourceDecisionId":"D001","choice":"two"}' },
        ];
      },
    });
    assert.throws(
      () => captureLegacyImportBaseSnapshot(memoryFixture),
      (error) => error instanceof LegacyImportBaseSnapshotError
        && error.code === "LEGACY_IMPORT_BASE_ROW_DUPLICATE"
        && error.context.row_set === "decision_memories"
        && error.context.identity === '{"source_decision_id":"D001"}',
    );
  });

  test("legacy preview base snapshot identifies assessments by their primary-key path", () => {
    const fixture = sourceFixture({
      readRows(rowSet) {
        if (rowSet !== "assessments") return [];
        return [
          {
            path: ".gsd/phases/01-foundation/T01-ASSESSMENT.md",
            milestone_id: "M001",
            slice_id: "S01",
            task_id: "T01",
            scope: "task",
          },
          {
            path: ".gsd/phases/01-foundation/tasks/T01-ASSESSMENT.md",
            milestone_id: "M001",
            slice_id: "S01",
            task_id: "T01",
            scope: "task",
          },
        ];
      },
    });

    const snapshot = captureLegacyImportBaseSnapshot(fixture);
    assert.deepEqual(snapshot.rows.map((row) => row.identity), [
      '{"path":".gsd/phases/01-foundation/T01-ASSESSMENT.md"}',
      '{"path":".gsd/phases/01-foundation/tasks/T01-ASSESSMENT.md"}',
    ]);
  });

  test("legacy preview base snapshot rejects integers that cannot be hashed exactly", () => {
    const fixture = sourceFixture({
      readRows(rowSet) {
        return rowSet === "milestones"
          ? [{ id: "M001", sequence: Number.MAX_SAFE_INTEGER + 1 }]
          : [];
      },
    });
    assert.throws(
      () => captureLegacyImportBaseSnapshot(fixture),
      (error) => error instanceof LegacyImportBaseSnapshotError
        && error.code === "LEGACY_IMPORT_BASE_ROW_INVALID"
        && error.context.column === "sequence",
    );
  });

  test("legacy preview base snapshot reads the current database without writes", () => {
    assert.equal(openDatabase(":memory:"), true);
    try {
      const db = _getAdapter();
      assert.ok(db);
      db.exec(`
        INSERT INTO milestones (id, title) VALUES ('M001', 'Foundation');
        INSERT INTO slices (milestone_id, id, title) VALUES ('M001', 'S01', 'First');
        INSERT INTO slices (milestone_id, id, title) VALUES ('M001', 'S02', 'Second');
        INSERT INTO tasks (milestone_id, slice_id, id, title) VALUES ('M001', 'S01', 'T01', 'Task');
        INSERT INTO slice_dependencies (milestone_id, slice_id, depends_on_slice_id)
          VALUES ('M001', 'S02', 'S01');
        INSERT INTO requirements (id, description) VALUES ('R001', 'Requirement');
        INSERT INTO artifacts (path, artifact_type, milestone_id, full_content)
          VALUES ('.gsd/PROJECT.md', 'project', 'M001', 'Project');
        INSERT INTO assessments (path, milestone_id, status, scope)
          VALUES ('.gsd/M001-ASSESSMENT.md', 'M001', 'pass', 'roadmap');
        INSERT INTO decisions (id, decision) VALUES ('D001', 'Decision');
        INSERT INTO memories (
          id, category, content, created_at, updated_at, structured_fields
        ) VALUES (
          'memory-1', 'architecture', 'Decision memory', 'created', 'updated',
          '{ "choice": "Memory choice", "sourceDecisionId": "D002" }'
        );
      `);
      const projectId = String(db.prepare(
        "SELECT project_id FROM project_authority WHERE singleton = 1",
      ).get()?.["project_id"]);
      db.prepare(`
        INSERT INTO workflow_operations (
          operation_id, project_id, operation_type, idempotency_key,
          expected_revision, resulting_revision,
          expected_authority_epoch, resulting_authority_epoch,
          actor_type, source_transport, request_hash, created_at
        ) VALUES ('operation-1', ?, 'test', 'test-1', 0, 1, 0, 0, 'test', 'test', 'hash', 'created')
      `).run(projectId);
      db.prepare(`
        INSERT INTO workflow_item_lifecycles (
          lifecycle_id, project_id, item_kind, milestone_id, lifecycle_status,
          created_at, updated_at, last_operation_id, last_project_revision, last_authority_epoch
        ) VALUES ('lifecycle-1', ?, 'milestone', 'M001', 'pending',
          'created', 'created', 'operation-1', 1, 0)
      `).run(projectId);
      const before = db.prepare("SELECT total_changes() AS count").get()?.["count"];

      const snapshot = captureCurrentLegacyImportBaseSnapshot();

      const after = db.prepare("SELECT total_changes() AS count").get()?.["count"];
      assert.equal(after, before);
      assert.equal(
        snapshot.database_schema_version,
        LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION,
      );
      assert.deepEqual([...new Set(snapshot.rows.map((row) => row.row_set))], EXPECTED_BASE_ROW_SETS);
      const rows = new Map(snapshot.rows.map((row) => [row.row_set, row.value]));
      for (const rowSet of EXPECTED_BASE_ROW_SETS) {
        assert.deepEqual(Object.keys(rows.get(rowSet)!), EXPECTED_BASE_ROW_KEYS[rowSet], rowSet);
      }
      assert.equal(rows.get("milestones")?.["title"], "Foundation");
      assert.equal(rows.get("slices")?.["title"], "Second");
      assert.equal(rows.get("tasks")?.["title"], "Task");
      assert.equal(rows.get("slice_dependencies")?.["depends_on_slice_id"], "S01");
      assert.equal(rows.get("requirements")?.["description"], "Requirement");
      assert.equal(rows.get("artifacts")?.["full_content"], "Project");
      assert.equal(rows.get("assessments")?.["scope"], "roadmap");
      assert.equal(rows.get("decisions")?.["decision"], "Decision");
      assert.equal(rows.get("decision_memories")?.["source_decision_id"], "D002");
      assert.equal(rows.get("item_lifecycles")?.["lifecycle_status"], "pending");

      db.exec(`
        UPDATE artifacts SET imported_at = 'later' WHERE path = '.gsd/PROJECT.md';
        UPDATE memories SET hit_count = 9, last_hit_at = 'later', updated_at = 'later'
          WHERE id = 'memory-1';
      `);
      const afterOperationalActivity = captureCurrentLegacyImportBaseSnapshot();
      assert.equal(afterOperationalActivity.relevant_rows_hash, snapshot.relevant_rows_hash);

      db.prepare("UPDATE artifacts SET full_content = 'Changed' WHERE path = '.gsd/PROJECT.md'").run();
      const afterSemanticChange = captureCurrentLegacyImportBaseSnapshot();
      assert.notEqual(afterSemanticChange.relevant_rows_hash, snapshot.relevant_rows_hash);

      db.prepare(`INSERT INTO memories (
        id, category, content, created_at, updated_at, structured_fields
      ) VALUES ('memory-malformed', 'architecture', 'Bad', 'created', 'updated',
        '{"sourceDecisionId":"D003"')`).run();
      assert.throws(
        () => captureCurrentLegacyImportBaseSnapshot(),
        (error) => error instanceof LegacyImportBaseSnapshotError
          && error.code === "LEGACY_IMPORT_BASE_ROW_INVALID"
          && error.context.row_set === "decision_memories",
      );
      db.prepare("DELETE FROM memories WHERE id = 'memory-malformed'").run();

      db.prepare(`INSERT INTO memories (
        id, category, content, created_at, updated_at, structured_fields
      ) VALUES ('memory-nested', 'architecture', 'Nested', 'created', 'updated',
        '{"nested":{"sourceDecisionId":"D004"}}')`).run();
      assert.throws(
        () => captureCurrentLegacyImportBaseSnapshot(),
        (error) => error instanceof LegacyImportBaseSnapshotError
          && error.code === "LEGACY_IMPORT_BASE_ROW_INVALID"
          && error.context.row_set === "decision_memories",
      );
    } finally {
      closeDatabase();
    }
  });
});

function temporaryLegacyCorpusDirectory(t: { after(fn: () => void): void }): string {
  const path = mkdtempSync(join(tmpdir(), "gsd-preview-classification-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function captureLegacyCorpusPaths(
  t: { after(fn: () => void): void },
  caseName: string,
  paths: readonly string[],
  roots: readonly { logical: string; kind: LegacyImportSourceRoot["kind"] }[],
): LegacyImportSourceCapture {
  const source = join(temporaryLegacyCorpusDirectory(t), "source");
  const fixture = fileURLToPath(new URL(`./${caseName}/source/`, LEGACY_CORPUS_ROOT));
  for (const path of paths) {
    const destination = join(source, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(fixture, path), destination, { dereference: false, verbatimSymlinks: true });
  }
  return captureLegacyImportSourceSet({
    roots: roots.map((root, index) => ({
      id: `classification-source-${index + 1}`,
      kind: root.kind,
      physical_path: join(source, root.logical),
      logical_path: root.logical,
      presence: "required",
    })),
  });
}

function actionMatrixBaseSnapshot(): LegacyImportBaseSnapshot {
  const path = fileURLToPath(new URL(
    "./action-matrix/source/.gsd/gsd.db",
    LEGACY_CORPUS_ROOT,
  ));
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    database.exec("PRAGMA query_only=ON");
    const schema = database.prepare("SELECT max(version) AS version FROM schema_version").get();
    assert.equal(schema?.version, LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION);
    const rawAuthority = database.prepare(`
      SELECT singleton, project_id, project_root_realpath, revision, authority_epoch,
             created_at, updated_at
      FROM project_authority
    `).get();
    assert.ok(rawAuthority);
    assert.equal(rawAuthority.singleton, 1);
    const authority = {
      singleton: 1 as const,
      project_id: String(rawAuthority.project_id),
      project_root_realpath: String(rawAuthority.project_root_realpath),
      revision: Number(rawAuthority.revision),
      authority_epoch: Number(rawAuthority.authority_epoch),
      created_at: String(rawAuthority.created_at),
      updated_at: String(rawAuthority.updated_at),
    };
    const rows: LegacyImportBaseSnapshot["rows"][number][] = database.prepare(`
      SELECT id, when_context, scope, decision, choice, rationale, revisable,
             made_by, source, superseded_by
      FROM decisions ORDER BY id
    `).all().map((rawRow) => {
      const value = { ...rawRow } as Readonly<Record<string, LegacyImportValue>>;
      return {
        row_set: "decisions",
        identity: canonicalLegacyImportJson({ id: String(value.id) }),
        value,
      };
    });
    return {
      snapshot_schema_version: 1,
      database_schema_version: LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION,
      authority,
      rows,
      relevant_rows_hash: hashLegacyImportValue(rows),
    };
  } finally {
    database.close();
  }
}

function composeLegacyInterpretations(
  interpretations: readonly LegacyImportInterpretation[],
): LegacyImportInterpretation {
  const candidates = interpretations.flatMap((interpretation) => interpretation.candidates)
    .sort((left, right) => left.candidate_id.localeCompare(right.candidate_id))
    .map((candidate, index) => ({ ...candidate, ordinal: index + 1 }));
  return {
    sources: interpretations.flatMap((interpretation) => interpretation.sources),
    candidates,
    complete_row_sets: interpretations.flatMap((interpretation) => interpretation.complete_row_sets),
    diagnoses: interpretations.flatMap((interpretation) => interpretation.diagnoses),
    resolutions: interpretations.flatMap((interpretation) => interpretation.resolutions),
  };
}

describe("legacy preview task classification", () => {
  test("legacy preview action matrix classification against a captured current fixture", (t) => {
    const capture = captureLegacyCorpusPaths(
      t,
      "action-matrix",
      [".gsd/STATE.md", ".gsd/state-manifest.json"],
      [{ logical: ".gsd", kind: "project" }],
    );
    const interpretation = interpretLegacyGsdCapture(capture);
    const result = classifyLegacyImportChanges(actionMatrixBaseSnapshot(), interpretation);

    assert.equal(result.applicable, true);
    assert.deepEqual(
      result.changes.map((change) => [change.action, change.target.key]).sort(),
      [
        ["create", "D001"],
        ["delete", "D003"],
        ["preserve", ".gsd/STATE.md"],
        ["update", "D002"],
      ].sort(),
    );
    assert.deepEqual(result.counts, {
      create: 1, update: 1, delete: 1, preserve: 1, unparsed: 0, unresolved: 0,
    });
    assert.equal(result.changes.some((change) => change.target.key === "D004"), false);
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
    assert.deepEqual(
      result.changes.find((change) => change.target.key === "D003")?.raw,
      complete.raw,
    );
    assertStableClassificationHashes(result);

    const replay = classifyLegacyImportChanges(actionMatrixBaseSnapshot(), interpretation);
    assert.equal(replay.source_set_hash, result.source_set_hash);
    assert.equal(replay.change_set_hash, result.change_set_hash);
    assert.deepEqual(replay.changes, result.changes);
  });

  test("legacy preview ambiguity classification", () => {
    const routeA = classificationSource("route-a", ".gsd/routes/a.json");
    const routeB = classificationSource("route-b", ".gsd/routes/b.json");
    const target = { kind: "milestone", key: "M007" } as const;
    const result = classifyLegacyImportChanges(
      classificationBase(),
      classificationInterpretation([routeA, routeB], [
        classificationCandidate(routeA, target, { id: "M007", title: "Route A" }),
        classificationCandidate(routeB, target, { id: "M007", title: "Route B" }, { ordinal: 2 }),
      ]),
    );

    assert.equal(result.applicable, false);
    assert.deepEqual(result.changes, []);
    assert.equal(result.counts.unresolved, 1);
    assert.equal(result.diagnoses.length, 1);
    assert.equal(result.resolutions.length, 1);
    assert.equal(result.diagnoses[0].code, "conflicting-legacy-import-target");
    assert.equal(result.diagnoses[0].severity, "blocker");
    assert.equal(result.resolutions[0].diagnosis_id, result.diagnoses[0].diagnosis_id);
    assert.equal(result.resolutions[0].disposition, "requires-user");
    assertStableClassificationHashes(result);
  });

  test("legacy preview composite classification from the real producer seam", (t) => {
    const planningCapture = captureLegacyCorpusPaths(
      t,
      "composite-capstone",
      [".planning/ROADMAP.md"],
      [{ logical: ".planning", kind: "project" }],
    );
    const gsdCapture = captureLegacyCorpusPaths(
      t,
      "composite-capstone",
      [
        ".gsd/DECISIONS.md",
        ".gsd/REQUIREMENTS.md",
        ".gsd/milestones/M007-capstone-alpha/M007-ROADMAP.md",
        ".gsd/milestones/M702-clean/M702-ROADMAP.md",
        ".gsd/phases/07-capstone-beta/07-ROADMAP.md",
        ".gsd/state-manifest.json",
      ],
      [{ logical: ".gsd", kind: "project" }],
    );
    const supplementalCapture = captureLegacyCorpusPaths(
      t,
      "composite-capstone",
      [
        ".gsd-worktrees/M008/git-marker.txt",
        ".gsd/KNOWLEDGE.md",
        ".gsd/event-log.jsonl",
        ".gsd/gsd.db",
        ".gsd/workflow-runs/capstone/run-001/GRAPH.yaml",
        ".gsd/workflows/capstone.yaml",
      ],
      [
        { logical: ".gsd", kind: "project" },
        { logical: ".gsd-worktrees", kind: "worktree" },
      ],
    );
    const interpretation = composeLegacyInterpretations([
      interpretLegacyPlanningCapture(planningCapture),
      interpretLegacyGsdCapture(gsdCapture),
      interpretLegacySupplementalCapture(supplementalCapture, {
        databaseTargetEvidence: collectLegacyImportDatabaseTargetEvidence(
          supplementalCapture,
          inspectLegacyImportDatabaseTarget,
        ),
      }),
    ]);
    const result = classifyLegacyImportChanges(classificationBase(), interpretation);

    assert.equal(result.applicable, false);
    assert.deepEqual(
      result.diagnoses.map((diagnosis) => diagnosis.code).sort(),
      [
        "conflicting-legacy-import-completeness",
        "conflicting-legacy-import-completeness",
        "duplicate-logical-milestone",
        "hybrid-conflicting-content",
        "unsupported-database-schema",
      ],
    );
    assert.deepEqual(
      result.changes.map((change) => [change.action, change.target.kind, change.target.key]).sort(),
      [
        ["create", "assessment", "M702/S01/run-uat"],
        ["create", "milestone", "M702"],
        ["create", "milestone-status", "M702"],
        ["create", "requirement", "R701"],
        ["create", "slice", "M702/S01"],
        ["preserve", "legacy-knowledge-source", ".gsd/KNOWLEDGE.md"],
        ["preserve", "legacy-workflow-definition", ".gsd/workflows/capstone.yaml"],
        ["preserve", "legacy-workflow-event", ".gsd/event-log.jsonl#L001"],
        ["preserve", "legacy-workflow-run-artifact", ".gsd/workflow-runs/capstone/run-001/GRAPH.yaml"],
        ["preserve", "legacy-worktree-topology", "canonical/M008"],
      ].sort(),
    );
    assert.deepEqual(result.counts, {
      create: 5, update: 0, delete: 0, preserve: 5, unparsed: 3, unresolved: 5,
    });
    assert.equal(result.changes.some((change) => change.target.key.includes("M007")), false);
    assert.equal(result.changes.some((change) => change.target.key === "M701"), false);
    assertStableClassificationHashes(result);
  });
});

interface PublicPreviewFixture {
  database: NonNullable<ReturnType<typeof _getAdapter>>;
  input: LegacyImportPreviewCreateInput;
  statePath: string;
}

function publicPreviewFixture(t: { after(fn: () => void): void }): PublicPreviewFixture {
  const directory = temporaryLegacyCorpusDirectory(t);
  const gsdRoot = join(directory, ".gsd");
  const statePath = join(gsdRoot, "STATE.md");
  const databasePath = join(directory, "canonical.db");
  mkdirSync(gsdRoot);
  writeFileSync(statePath, "# State\n\nHuman narrative.\n");
  assert.equal(openDatabase(databasePath), true);
  const database = _getAdapter();
  assert.ok(database);
  return {
    database,
    input: {
      roots: [{
        id: "project-gsd",
        kind: "project",
        physical_path: gsdRoot,
        logical_path: ".gsd",
        presence: "required",
      }],
    },
    statePath,
  };
}

test("legacy public Preview composes and revalidates one deterministic read-only artifact", (t) => {
  const { database, input, statePath } = publicPreviewFixture(t);
  try {
    const authority = database.prepare(`
      SELECT revision, authority_epoch FROM project_authority WHERE singleton = 1
    `).get();
    assert.ok(authority);
    assert.equal(
      database.prepare("SELECT max(version) AS version FROM schema_version").get()?.["version"],
      LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION,
    );
    const totalChangesBefore = database.prepare("SELECT total_changes() AS count").get()?.["count"];

    const first = createLegacyImportPreview(input);
    const replay = createLegacyImportPreview(input);

    assert.deepEqual(replay, first);
    assert.equal(first.preview.import_kind, "legacy-markdown");
    assert.equal(first.preview.importer_version, "1");
    assert.equal(first.preview.base_project_revision, authority["revision"]);
    assert.equal(first.preview.base_authority_epoch, authority["authority_epoch"]);
    assert.equal(
      first.preview.base_database_schema_version,
      LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION,
    );
    assert.equal(first.preview_hash, hashLegacyImportValue(first.preview));
    assert.deepEqual(first.preview.counts, {
      create: 0,
      update: 0,
      delete: 0,
      preserve: 1,
      unparsed: 0,
      unresolved: 0,
    });
    assert.deepEqual(first.preview.sources.map((source) => ({
      path: source.path,
      parser_id: source.parser_id,
      parser_version: source.parser_version,
      outcome: source.outcome,
    })), [{
      path: ".gsd/STATE.md",
      parser_id: "gsd-artifact-classifier",
      parser_version: "1",
      outcome: "preserved",
    }]);
    assert.deepEqual(first.preview.changes.map((change) => ({
      action: change.action,
      target: change.target,
      normalized: change.normalized,
      reason_code: change.reason_code,
    })), [{
      action: "preserve",
      target: { kind: "legacy-artifact", key: ".gsd/STATE.md" },
      normalized: { path: ".gsd/STATE.md", preservation: "verbatim" },
      reason_code: "unrecognized-gsd-artifact-preserved",
    }]);
    assert.deepEqual(revalidateLegacyImportPreview(input, first), first);
    assert.equal(database.prepare("SELECT total_changes() AS count").get()?.["count"], totalChangesBefore);

    writeFileSync(statePath, "# State\n\nChanged after approval.\n");
    assert.throws(
      () => revalidateLegacyImportPreview(input, first),
      (error: unknown) => error instanceof LegacyImportPreviewError
        && error.stage === "revalidate"
        && error.code === "LEGACY_IMPORT_PREVIEW_CHANGED"
        && error.retryable,
    );
    assert.equal(database.prepare("SELECT total_changes() AS count").get()?.["count"], totalChangesBefore);
  } finally {
    closeDatabase();
  }
});

test("legacy public Preview records and revalidates a required preservation resolution", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "gsd-preview-resolution-"));
  t.after(() => {
    closeDatabase();
    rmSync(directory, { recursive: true, force: true });
  });
  const gsdRoot = join(directory, ".gsd");
  const milestone = join(gsdRoot, "milestones", "M001");
  const slice = join(milestone, "slices", "S01");
  mkdirSync(slice, { recursive: true });
  writeFileSync(join(milestone, "M001-ROADMAP.md"), [
    "# M001: Migration",
    "",
    "## Slices",
    "",
    "- [ ] **S01: Mixed content** `risk:low` `depends:[]`",
  ].join("\n"));
  writeFileSync(join(slice, "S01-RESEARCH.md"), "# Research\n\nPreserve these notes.\n");
  assert.equal(openDatabase(join(directory, "canonical.db")), true);
  const input: LegacyImportPreviewCreateInput = {
    roots: [{
      id: "mixed-content-gsd",
      kind: "project",
      physical_path: gsdRoot,
      logical_path: ".gsd",
      presence: "required",
    }],
  };

  const pending = createLegacyImportPreview(input);
  const diagnosis = pending.preview.diagnoses.find((entry) => (
    entry.code === "ambiguous-task-membership"
  ));
  assert.ok(diagnosis);
  const resolved = resolveLegacyImportPreview(pending, [{
    diagnosis_id: diagnosis.diagnosis_id,
    disposition: "preserved",
  }]);

  assert.equal(pending.preview.counts.unresolved, 1, "the original sealed Preview remains unchanged");
  assert.equal(resolved.preview.counts.unresolved, 0);
  assert.equal(resolved.preview.preview_id, pending.preview.preview_id);
  assert.notEqual(resolved.preview_hash, pending.preview_hash);
  assert.equal(
    resolved.preview.resolutions.find((entry) => entry.diagnosis_id === diagnosis.diagnosis_id)?.disposition,
    "preserved",
  );
  assert.doesNotThrow(() => compileLegacyImportApplicationPlan(resolved));
  assert.deepEqual(revalidateLegacyImportPreview(input, resolved), resolved);
  const assertInvalidResolution = (operation: () => unknown): void => {
    assert.throws(operation, (error) => {
      assert.ok(error instanceof LegacyImportPreviewError);
      assert.equal(error.stage, "resolve");
      assert.equal(error.code, "LEGACY_IMPORT_PREVIEW_RESOLUTION_INVALID");
      return true;
    });
  };
  assertInvalidResolution(() => resolveLegacyImportPreview(pending, [
    { diagnosis_id: diagnosis.diagnosis_id, disposition: "preserved" },
    { diagnosis_id: diagnosis.diagnosis_id, disposition: "preserved" },
  ]));
  assertInvalidResolution(() => resolveLegacyImportPreview(pending, [{
    diagnosis_id: diagnosis.diagnosis_id,
    disposition: "mapped",
  // Exercise the runtime contract with a disposition intentionally excluded from the public choice type.
  }] as never));
  assertInvalidResolution(() => resolveLegacyImportPreview(pending, [{
    diagnosis_id: `sha256:${"2".repeat(64)}` as LegacyImportSha256,
    disposition: "preserved",
  }]));
  assertInvalidResolution(() => resolveLegacyImportPreview(resolved, [{
    diagnosis_id: diagnosis.diagnosis_id,
    disposition: "preserved",
  }]));
  assertInvalidResolution(() => resolveLegacyImportPreview(
    { ...pending, preview_hash: ONE_HASH },
    [],
  ));
});

test("legacy public Preview leaves an anchor-incomplete v44 database supplemental-only", (t) => {
  const directory = temporaryLegacyCorpusDirectory(t);
  const gsdRoot = join(directory, ".gsd");
  mkdirSync(gsdRoot);
  cpSync(
    fileURLToPath(new URL("./composite-capstone/source/.gsd/gsd.db", LEGACY_CORPUS_ROOT)),
    join(gsdRoot, "gsd.db"),
  );
  assert.equal(openDatabase(join(directory, "canonical.db")), true);
  try {
    const artifact = createLegacyImportPreview({
      roots: [{
        id: "unsupported-composite-gsd",
        kind: "project",
        physical_path: gsdRoot,
        logical_path: ".gsd",
        presence: "required",
      }],
    });

    assert.deepEqual(artifact.preview.sources.map((source) => ({
      path: source.path,
      parser_id: source.parser_id,
      outcome: source.outcome,
    })), [{
      path: ".gsd/gsd.db",
      parser_id: "gsd-sqlite-target",
      outcome: "unparsed",
    }]);
    assert.deepEqual(artifact.preview.diagnoses.map((diagnosis) => diagnosis.code), [
      "unsupported-database-schema",
    ]);
    assert.deepEqual(artifact.preview.resolutions.map((resolution) => resolution.disposition), [
      "unsupported",
    ]);
    assert.deepEqual(artifact.preview.counts, {
      create: 0,
      update: 0,
      delete: 0,
      preserve: 0,
      unparsed: 1,
      unresolved: 1,
    });
  } finally {
    closeDatabase();
  }
});

test("legacy public Preview leaves duplicate v44 schema metadata unsupported", (t) => {
  const directory = temporaryLegacyCorpusDirectory(t);
  const gsdRoot = join(directory, ".gsd");
  mkdirSync(gsdRoot);
  const sourceDatabase = new DatabaseSync(join(gsdRoot, "gsd.db"));
  try {
    sourceDatabase.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL);
      INSERT INTO schema_version VALUES (44, 'first'), (44, 'duplicate');
      CREATE TABLE project_authority (singleton INTEGER);
      CREATE TABLE workflow_import_applications (id TEXT);
      CREATE TABLE trigger_anchor (id INTEGER);
      CREATE TRIGGER trg_workflow_lifecycle_reopen_authorization
      AFTER INSERT ON trigger_anchor BEGIN SELECT 1; END;
    `);
  } finally {
    sourceDatabase.close();
  }
  assert.equal(openDatabase(join(directory, "canonical.db")), true);
  try {
    const artifact = createLegacyImportPreview({
      roots: [{
        id: "duplicate-v44-gsd",
        kind: "project",
        physical_path: gsdRoot,
        logical_path: ".gsd",
        presence: "required",
      }],
    });

    assert.deepEqual(artifact.preview.sources.map((source) => ({
      path: source.path,
      parser_id: source.parser_id,
      outcome: source.outcome,
    })), [{
      path: ".gsd/gsd.db",
      parser_id: "gsd-sqlite-target",
      outcome: "unparsed",
    }]);
    assert.deepEqual(artifact.preview.diagnoses.map((diagnosis) => diagnosis.code), [
      "invalid-database-schema-metadata",
    ]);
    assert.deepEqual(artifact.preview.resolutions.map((resolution) => resolution.disposition), [
      "unsupported",
    ]);
    assert.equal(artifact.preview.counts.unparsed, 1);
    assert.equal(artifact.preview.counts.unresolved, 1);
  } finally {
    closeDatabase();
  }
});

test("legacy public Preview returns no artifact when a source changes after classification", (t) => {
  const { input, statePath } = publicPreviewFixture(t);
  let artifact: LegacyImportPreviewArtifact | undefined;
  try {
    assert.throws(
      () => {
        artifact = _createLegacyImportPreviewForTest(input, {
          afterClassification() {
            writeFileSync(statePath, "# State\n\nChanged during classification.\n");
          },
        });
      },
      (error: unknown) => error instanceof LegacyImportSourceError
        && error.stage === "revalidate"
        && error.code === "LEGACY_IMPORT_SOURCE_CHANGED",
    );
    assert.equal(artifact, undefined);
  } finally {
    closeDatabase();
  }
});

test("legacy public Preview detects relevant-row drift even when revision and epoch do not advance", (t) => {
  const { database, input } = publicPreviewFixture(t);
  const authorityBefore = database.prepare(`
    SELECT revision, authority_epoch FROM project_authority WHERE singleton = 1
  `).get();
  assert.ok(authorityBefore);
  let artifact: LegacyImportPreviewArtifact | undefined;
  try {
    assert.throws(
      () => {
        artifact = _createLegacyImportPreviewForTest(input, {
          afterSourceRevalidation() {
            database.prepare(`
              INSERT INTO decisions (id, decision) VALUES ('D-RACE', 'Changed without authority advance')
            `).run();
          },
        });
      },
      (error: unknown) => error instanceof LegacyImportPreviewError
        && error.stage === "create"
        && error.code === "LEGACY_IMPORT_PREVIEW_BASE_CHANGED"
        && error.retryable
        && error.context["expected_revision"] === authorityBefore["revision"]
        && error.context["observed_revision"] === authorityBefore["revision"]
        && error.context["expected_authority_epoch"] === authorityBefore["authority_epoch"]
        && error.context["observed_authority_epoch"] === authorityBefore["authority_epoch"]
        && error.context["expected_base_hash"] !== error.context["observed_base_hash"],
    );
    assert.equal(artifact, undefined);
  } finally {
    closeDatabase();
  }
});

test("legacy public Preview rejects invalid and semantically changed expected artifacts", (t) => {
  const { input } = publicPreviewFixture(t);
  try {
    const expected = createLegacyImportPreview(input);
    const invalidHash = structuredClone(expected) as LegacyImportPreviewArtifact;
    invalidHash.preview_hash = hashLegacyImportValue("tampered Preview hash");

    assert.throws(
      () => revalidateLegacyImportPreview(input, invalidHash),
      (error: unknown) => error instanceof LegacyImportPreviewError
        && error.stage === "revalidate"
        && error.code === "LEGACY_IMPORT_PREVIEW_EXPECTED_INVALID"
        && !error.retryable,
    );

    const changed = structuredClone(expected) as LegacyImportPreviewArtifact;
    assert.ok(changed.preview.diagnoses[0]);
    changed.preview.diagnoses[0].message = "A rehashed semantic change must not retain approval.";
    changed.preview_hash = hashLegacyImportValue(changed.preview);

    assert.throws(
      () => revalidateLegacyImportPreview(input, changed),
      (error: unknown) => error instanceof LegacyImportPreviewError
        && error.stage === "revalidate"
        && error.code === "LEGACY_IMPORT_PREVIEW_CHANGED"
        && error.retryable
        && error.context["expected_preview_hash"] === changed.preview_hash
        && error.context["observed_preview_hash"] === expected.preview_hash,
    );
  } finally {
    closeDatabase();
  }
});

describe("legacy public Preview expected artifact validation", () => {
  const malformedPreview = {
    preview_schema_version: 1,
    preview_id: "not-a-preview-hash",
    import_kind: "legacy-markdown",
    importer_version: "1",
    base_project_revision: -1,
    base_authority_epoch: -1,
    base_database_schema_version: LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION,
    source_set_hash: "not-a-source-hash",
    change_set_hash: "not-a-change-hash",
    counts: {},
    sources: [],
    changes: [],
    diagnoses: [],
    resolutions: [],
  };
  const invalidExpectedArtifacts: readonly (readonly [string, unknown])[] = [
    ["null artifact", null],
    ["null Preview", { preview: null, preview_hash: hashLegacyImportValue(null) }],
    ["rehashed malformed envelope", {
      preview: malformedPreview,
      preview_hash: hashLegacyImportValue(malformedPreview),
    }],
  ];

  for (const [label, invalidExpected] of invalidExpectedArtifacts) {
    test(`rejects ${label} before source capture`, (t) => {
      const missingRoot = join(temporaryLegacyCorpusDirectory(t), "missing-source-root");
      const input: LegacyImportPreviewCreateInput = {
        roots: [{
          id: "must-not-capture",
          kind: "project",
          physical_path: missingRoot,
          logical_path: ".gsd",
          presence: "required",
        }],
      };

      assert.throws(
        () => revalidateLegacyImportPreview(
          input,
          invalidExpected as LegacyImportPreviewArtifact,
        ),
        (error: unknown) => error instanceof LegacyImportPreviewError
          && error.stage === "revalidate"
          && error.code === "LEGACY_IMPORT_PREVIEW_EXPECTED_INVALID"
          && !error.retryable,
      );
    });
  }
});
