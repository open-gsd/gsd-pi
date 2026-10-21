// Project/App: gsd-pi
// File Purpose: State manifest snapshot and restore orchestration for GSD workflow data.

import {
  _getAdapter,
  readTransaction,
  restoreManifest,
} from "./gsd-db.js";
import type { ArtifactRow, MilestoneRow } from "./db-milestone-artifact-rows.js";
import type { SliceRow, TaskRow } from "./db-task-slice-rows.js";
import type { VerificationEvidenceRow } from "./db-verification-evidence-rows.js";
import type { Decision, GateRow, Requirement } from "./types.js";
import { atomicWriteAsync, atomicWriteSync } from "./atomic-write.js";
import { buildStateContract } from "./state-contract.js";
import {
  getAllDecisionsFromMemories,
  getDeletedDecisionIdsFromMemories,
} from "./context-store.js";
import { backfillDecisionsToMemories } from "./memory-backfill.js";
import { invalidateAllCaches } from "./cache.js";
import { logWarning } from "./workflow-logger.js";
import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

// ─── Manifest Types ──────────────────────────────────────────────────────

export interface ManifestArtifactRow extends ArtifactRow {
  content_hash: string | null;
}

export interface ReplanHistoryManifestRow {
  id: number;
  milestone_id: string;
  slice_id: string | null;
  task_id: string | null;
  summary: string;
  previous_artifact_path: string | null;
  replacement_artifact_path: string | null;
  created_at: string;
}

export interface AssessmentManifestRow {
  path: string;
  milestone_id: string;
  slice_id: string | null;
  task_id: string | null;
  status: string;
  scope: string;
  full_content: string;
  created_at: string;
}

export interface MilestoneCommitAttributionManifestRow {
  commit_sha: string;
  milestone_id: string;
  slice_id: string | null;
  task_id: string | null;
  source: string;
  confidence: number;
  files_json: string;
  created_at: string;
}

export interface StateManifest {
  version: 1;
  exported_at: string; // ISO 8601
  requirements?: Requirement[];
  artifacts?: ManifestArtifactRow[];
  milestones: MilestoneRow[];
  slices: SliceRow[];
  tasks: TaskRow[];
  decisions: Decision[];
  replan_history?: ReplanHistoryManifestRow[];
  assessments?: AssessmentManifestRow[];
  quality_gates?: GateRow[];
  verification_evidence: VerificationEvidenceRow[];
  milestone_commit_attributions?: MilestoneCommitAttributionManifestRow[];
}

// ─── helpers ─────────────────────────────────────────────────────────────

function requireDb() {
  const db = _getAdapter();
  if (!db) throw new Error("workflow-manifest: No database open");
  return db;
}

/**
 * Coerce a raw DB value to a number, returning `fallback` for
 * null/undefined/non-numeric strings (e.g. "-", "N/A", "").
 * SQLite can store TEXT in INTEGER columns after migrations or manual inserts.
 */
export function toNumeric(value: unknown, fallback: number | null = null): number | null {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "" || trimmed === "-" || trimmed === "N/A") return fallback;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

function mergeDecisionSurfaces(
  legacyDecisions: Decision[],
  memoryDecisions: Decision[],
  deletedDecisionIds: ReadonlySet<string>,
): Decision[] {
  const byId = new Map<string, Decision>();
  for (const decision of legacyDecisions) {
    if (!deletedDecisionIds.has(decision.id)) byId.set(decision.id, decision);
  }
  for (const decision of memoryDecisions) {
    byId.set(decision.id, decision);
  }
  return Array.from(byId.values()).sort((a, b) => {
    const seqDelta = (a.seq ?? 0) - (b.seq ?? 0);
    return seqDelta === 0 ? a.id.localeCompare(b.id) : seqDelta;
  });
}

// ─── snapshotState ───────────────────────────────────────────────────────

/**
 * Capture DB-backed workflow state as a StateManifest.
 * Runtime soft state and append-only audit streams stay outside this recovery
 * substrate; correctness records and persisted evidence are included.
 *
 * Note: rows returned from raw queries are plain objects with TEXT columns for
 * JSON arrays. We parse them into typed Row objects using the same logic as
 * gsd-db helper functions.
 */
export function snapshotState(): StateManifest {
  const db = requireDb();

  // Wrap all reads in a deferred transaction so the snapshot is consistent
  // (all SELECTs see the same DB state even if a concurrent write lands between them).
  return readTransaction(() => {
  const rawRequirements = db.prepare("SELECT * FROM requirements ORDER BY id").all() as Record<string, unknown>[];
  const requirements: Requirement[] = rawRequirements.map((r) => ({
    id: r["id"] as string,
    class: (r["class"] as string) ?? "",
    status: (r["status"] as string) ?? "",
    description: (r["description"] as string) ?? "",
    why: (r["why"] as string) ?? "",
    source: (r["source"] as string) ?? "",
    primary_owner: (r["primary_owner"] as string) ?? "",
    supporting_slices: (r["supporting_slices"] as string) ?? "",
    validation: (r["validation"] as string) ?? "",
    notes: (r["notes"] as string) ?? "",
    full_content: (r["full_content"] as string) ?? "",
    superseded_by: (r["superseded_by"] as string) ?? null,
  }));

  const rawArtifacts = db.prepare("SELECT * FROM artifacts ORDER BY path").all() as Record<string, unknown>[];
  const artifacts: ManifestArtifactRow[] = rawArtifacts.map((r) => ({
    path: r["path"] as string,
    artifact_type: (r["artifact_type"] as string) ?? "",
    milestone_id: (r["milestone_id"] as string) ?? null,
    slice_id: (r["slice_id"] as string) ?? null,
    task_id: (r["task_id"] as string) ?? null,
    full_content: (r["full_content"] as string) ?? "",
    imported_at: (r["imported_at"] as string) ?? "",
    content_hash: (r["content_hash"] as string) ?? null,
  }));

  const rawMilestones = db.prepare(
    "SELECT * FROM milestones ORDER BY CASE WHEN sequence > 0 THEN 0 ELSE 1 END, sequence, id",
  ).all() as Record<string, unknown>[];
  const milestones: MilestoneRow[] = rawMilestones.map((r) => ({
    id: r["id"] as string,
    title: r["title"] as string,
    status: r["status"] as string,
    depends_on: JSON.parse((r["depends_on"] as string) || "[]"),
    created_at: r["created_at"] as string,
    completed_at: (r["completed_at"] as string) ?? null,
    vision: (r["vision"] as string) ?? "",
    success_criteria: JSON.parse((r["success_criteria"] as string) || "[]"),
    key_risks: JSON.parse((r["key_risks"] as string) || "[]"),
    proof_strategy: JSON.parse((r["proof_strategy"] as string) || "[]"),
    verification_contract: (r["verification_contract"] as string) ?? "",
    verification_integration: (r["verification_integration"] as string) ?? "",
    verification_operational: (r["verification_operational"] as string) ?? "",
    verification_uat: (r["verification_uat"] as string) ?? "",
    definition_of_done: JSON.parse((r["definition_of_done"] as string) || "[]"),
    requirement_coverage: (r["requirement_coverage"] as string) ?? "",
    boundary_map_markdown: (r["boundary_map_markdown"] as string) ?? "",
    sequence: Number(r["sequence"] ?? 0),
  }));

  const rawSlices = db.prepare("SELECT * FROM slices ORDER BY milestone_id, sequence, id").all() as Record<string, unknown>[];
  const slices: SliceRow[] = rawSlices.map((r) => ({
    milestone_id: r["milestone_id"] as string,
    id: r["id"] as string,
    title: r["title"] as string,
    status: r["status"] as string,
    risk: r["risk"] as string,
    depends: JSON.parse((r["depends"] as string) || "[]"),
    demo: (r["demo"] as string) ?? "",
    created_at: r["created_at"] as string,
    completed_at: (r["completed_at"] as string) ?? null,
    full_summary_md: (r["full_summary_md"] as string) ?? "",
    full_uat_md: (r["full_uat_md"] as string) ?? "",
    goal: (r["goal"] as string) ?? "",
    success_criteria: (r["success_criteria"] as string) ?? "",
    proof_level: (r["proof_level"] as string) ?? "",
    integration_closure: (r["integration_closure"] as string) ?? "",
    observability_impact: (r["observability_impact"] as string) ?? "",
    target_repositories: JSON.parse((r["target_repositories"] as string) || "[]"),
    sequence: toNumeric(r["sequence"], 0) as number,
    replan_triggered_at: (r["replan_triggered_at"] as string) ?? null,
    is_sketch: toNumeric(r["is_sketch"], 0) as number,
    sketch_scope: (r["sketch_scope"] as string) ?? "",
  }));

  const rawTasks = db.prepare("SELECT * FROM tasks ORDER BY milestone_id, slice_id, sequence, id").all() as Record<string, unknown>[];
  const tasks: TaskRow[] = rawTasks.map((r) => ({
    milestone_id: r["milestone_id"] as string,
    slice_id: r["slice_id"] as string,
    id: r["id"] as string,
    title: r["title"] as string,
    status: r["status"] as string,
    one_liner: (r["one_liner"] as string) ?? "",
    narrative: (r["narrative"] as string) ?? "",
    verification_result: (r["verification_result"] as string) ?? "",
    duration: (r["duration"] as string) ?? "",
    completed_at: (r["completed_at"] as string) ?? null,
    blocker_discovered: (r["blocker_discovered"] as number) === 1,
    deviations: (r["deviations"] as string) ?? "",
    known_issues: (r["known_issues"] as string) ?? "",
    key_files: JSON.parse((r["key_files"] as string) || "[]"),
    key_decisions: JSON.parse((r["key_decisions"] as string) || "[]"),
    full_summary_md: (r["full_summary_md"] as string) ?? "",
    description: (r["description"] as string) ?? "",
    estimate: (r["estimate"] as string) ?? "",
    files: JSON.parse((r["files"] as string) || "[]"),
    verify: (r["verify"] as string) ?? "",
    inputs: JSON.parse((r["inputs"] as string) || "[]"),
    expected_output: JSON.parse((r["expected_output"] as string) || "[]"),
    observability_impact: (r["observability_impact"] as string) ?? "",
    full_plan_md: (r["full_plan_md"] as string) ?? "",
    target_repositories: JSON.parse((r["target_repositories"] as string) || "[]"),
    sequence: toNumeric(r["sequence"], 0) as number,
    blocker_source: (r["blocker_source"] as string) ?? "",
    escalation_pending: toNumeric(r["escalation_pending"], 0) as number,
    escalation_awaiting_review: toNumeric(r["escalation_awaiting_review"], 0) as number,
    escalation_artifact_path: (r["escalation_artifact_path"] as string) ?? null,
    escalation_override_applied_at: (r["escalation_override_applied_at"] as string) ?? null,
  }));

  const rawDecisions = db.prepare("SELECT * FROM decisions ORDER BY seq").all() as Record<string, unknown>[];
  const legacyDecisions: Decision[] = rawDecisions.map((r) => ({
    seq: toNumeric(r["seq"], 0) as number,
    id: r["id"] as string,
    when_context: (r["when_context"] as string) ?? "",
    scope: (r["scope"] as string) ?? "",
    decision: (r["decision"] as string) ?? "",
    choice: (r["choice"] as string) ?? "",
    rationale: (r["rationale"] as string) ?? "",
    revisable: (r["revisable"] as string) ?? "",
    made_by: (r["made_by"] as string as Decision["made_by"]) ?? "agent",
    source: (r["source"] as string) ?? "discussion",
    superseded_by: (r["superseded_by"] as string) ?? null,
  }));
  const decisions = mergeDecisionSurfaces(
    legacyDecisions,
    getAllDecisionsFromMemories(),
    getDeletedDecisionIdsFromMemories(),
  );

  const rawReplanHistory = db.prepare("SELECT * FROM replan_history ORDER BY id").all() as Record<string, unknown>[];
  const replan_history: ReplanHistoryManifestRow[] = rawReplanHistory.map((r) => ({
    id: toNumeric(r["id"], 0) as number,
    milestone_id: (r["milestone_id"] as string) ?? "",
    slice_id: (r["slice_id"] as string) ?? null,
    task_id: (r["task_id"] as string) ?? null,
    summary: (r["summary"] as string) ?? "",
    previous_artifact_path: (r["previous_artifact_path"] as string) ?? null,
    replacement_artifact_path: (r["replacement_artifact_path"] as string) ?? null,
    created_at: (r["created_at"] as string) ?? "",
  }));

  const rawAssessments = db.prepare("SELECT * FROM assessments ORDER BY path").all() as Record<string, unknown>[];
  const assessments: AssessmentManifestRow[] = rawAssessments.map((r) => ({
    path: r["path"] as string,
    milestone_id: (r["milestone_id"] as string) ?? "",
    slice_id: (r["slice_id"] as string) ?? null,
    task_id: (r["task_id"] as string) ?? null,
    status: (r["status"] as string) ?? "",
    scope: (r["scope"] as string) ?? "",
    full_content: (r["full_content"] as string) ?? "",
    created_at: (r["created_at"] as string) ?? "",
  }));

  const rawQualityGates = db.prepare("SELECT * FROM quality_gates ORDER BY milestone_id, slice_id, gate_id, task_id").all() as Record<string, unknown>[];
  const quality_gates: GateRow[] = rawQualityGates.map((r) => ({
    milestone_id: r["milestone_id"] as string,
    slice_id: r["slice_id"] as string,
    gate_id: r["gate_id"] as GateRow["gate_id"],
    scope: r["scope"] as GateRow["scope"],
    task_id: (r["task_id"] as string) ?? "",
    status: r["status"] as GateRow["status"],
    verdict: r["status"] === "pending" ? null : (r["verdict"] as GateRow["verdict"]),
    rationale: (r["rationale"] as string) ?? "",
    findings: (r["findings"] as string) ?? "",
    evaluated_at: (r["evaluated_at"] as string) ?? null,
  }));

  const rawEvidence = db.prepare("SELECT * FROM verification_evidence ORDER BY id").all() as Record<string, unknown>[];
  const verification_evidence: VerificationEvidenceRow[] = rawEvidence.map((r) => ({
    id: r["id"] as number,
    task_id: r["task_id"] as string,
    slice_id: r["slice_id"] as string,
    milestone_id: r["milestone_id"] as string,
    command: r["command"] as string,
    exit_code: toNumeric(r["exit_code"]),
    verdict: (r["verdict"] as string) ?? "",
    duration_ms: toNumeric(r["duration_ms"]),
    created_at: r["created_at"] as string,
  }));

  const rawCommitAttributions = db.prepare(
    "SELECT * FROM milestone_commit_attributions ORDER BY milestone_id, commit_sha",
  ).all() as Record<string, unknown>[];
  const milestone_commit_attributions: MilestoneCommitAttributionManifestRow[] = rawCommitAttributions.map((r) => ({
    commit_sha: r["commit_sha"] as string,
    milestone_id: r["milestone_id"] as string,
    slice_id: (r["slice_id"] as string) ?? null,
    task_id: (r["task_id"] as string) ?? null,
    source: (r["source"] as string) ?? "recorded",
    confidence: toNumeric(r["confidence"], 1) as number,
    files_json: (r["files_json"] as string) ?? "[]",
    created_at: (r["created_at"] as string) ?? "",
  }));

  const result: StateManifest = {
    version: 1,
    exported_at: new Date().toISOString(),
    requirements,
    artifacts,
    milestones,
    slices,
    tasks,
    decisions,
    replan_history,
    assessments,
    quality_gates,
    verification_evidence,
    milestone_commit_attributions,
  };

  return result;
  });
}

// ─── restore ─────────────────────────────────────────────────────────────
//
// The actual restore() implementation lives in gsd-db.ts (single-writer
// invariant). This module only orchestrates reading the manifest file
// and handing it to the writer.

// ─── writeManifest ───────────────────────────────────────────────────────

interface ManifestWriteState {
  latestJson: string | null;
  inFlightJson: string | null;
  /** Set by sync exit flush so an in-flight async write cannot leave stale data on disk. */
  syncFlushJson: string | null;
  active: Promise<void> | null;
}

const manifestWrites = new Map<string, ManifestWriteState>();
let processTeardownFlushInstalled = false;
let beforeExitFlushStarted = false;

function manifestFilePath(basePath: string): string {
  return join(resolve(basePath), ".gsd", "state-manifest.json");
}

function stateContractFilePath(basePath: string): string {
  return join(resolve(basePath), ".gsd", "state.json");
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function logManifestWriteFailure(filePath: string, err: unknown): void {
  logWarning("manifest", `state manifest write failed: ${describeError(err)}`, { file: filePath });
}

async function drainManifestWrites(key: string, state: ManifestWriteState): Promise<void> {
  let lastWriteError: unknown = null;
  try {
    while (state.latestJson !== null && state.syncFlushJson === null) {
      const json = state.latestJson;
      state.latestJson = null;
      state.inFlightJson = json;
      try {
        await atomicWriteAsync(key, json);
        if (state.syncFlushJson !== null) {
          atomicWriteSync(key, state.syncFlushJson);
          break;
        }
        lastWriteError = null;
      } catch (err) {
        lastWriteError = err;
        logManifestWriteFailure(key, err);
      } finally {
        state.inFlightJson = null;
      }
    }
  } finally {
    state.active = null;
    if (state.latestJson === null && state.inFlightJson === null) {
      manifestWrites.delete(key);
    }
  }
  if (lastWriteError !== null && state.syncFlushJson === null) {
    throw lastWriteError;
  }
}

function enqueueManifestWrite(filePath: string, json: string): void {
  const key = filePath;
  let state = manifestWrites.get(key);
  if (!state) {
    state = {
      latestJson: null,
      inFlightJson: null,
      syncFlushJson: null,
      active: null,
    };
    manifestWrites.set(key, state);
  }

  state.latestJson = json;
  if (!state.active) {
    const active = drainManifestWrites(key, state);
    void active.catch(() => {});
    state.active = active;
  }
}

/**
 * Queue current DB state for an async atomic write to .gsd/state-manifest.json,
 * plus the state contract v1 projection to .gsd/state.json (read by external
 * tools like GSD Workbench). The contract deliberately tracks this write
 * boundary: every skill step boundary uses writeManifest/writeManifestAndFlush,
 * while placeholder milestone inserts, queue-order reconciliation, and out-of-
 * band edits refresh on the next skill run as allowed by contract v1 rule 2 and
 * ADR-0004. Uses JSON.stringify with 2-space indent for git three-way merge
 * friendliness.
 */
export function writeManifest(basePath: string): void {
  const manifest = snapshotState();
  enqueueManifestWrite(manifestFilePath(basePath), JSON.stringify(manifest, null, 2));
  const contract = buildStateContract(manifest.milestones, manifest.slices, manifest.exported_at);
  enqueueManifestWrite(stateContractFilePath(basePath), JSON.stringify(contract, null, 2));
}

export async function writeManifestAndFlush(basePath: string): Promise<void> {
  writeManifest(basePath);
  await flushManifest(basePath);
}

async function flushManifestByKey(key: string): Promise<void> {
  for (;;) {
    const active = manifestWrites.get(key)?.active;
    if (!active) return;
    await active;
  }
}

/**
 * Wait for every queued write under this base path (state-manifest.json and
 * the state contract projection) to become durable.
 */
export async function flushManifest(basePath: string): Promise<void> {
  const prefix = join(resolve(basePath), ".gsd") + sep;
  const results = await Promise.allSettled(
    Array.from(manifestWrites.keys())
      .filter((key) => key.startsWith(prefix))
      .map((key) => flushManifestByKey(key)),
  );
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
}

export async function flushAllManifests(): Promise<void> {
  await Promise.all(Array.from(manifestWrites.keys(), key => flushManifestByKey(key)));
}

function flushAllManifestsSync(): void {
  for (const [key, state] of manifestWrites) {
    const json = state.latestJson ?? state.inFlightJson;
    if (json === null) continue;
    try {
      atomicWriteSync(key, json);
      state.latestJson = null;
      state.inFlightJson = null;
      state.syncFlushJson = json;
      manifestWrites.delete(key);
    } catch (err) {
      logManifestWriteFailure(key, err);
    }
  }
}

export function installManifestFlushOnProcessTeardown(): void {
  if (processTeardownFlushInstalled) return;
  processTeardownFlushInstalled = true;

  process.once("beforeExit", () => {
    if (beforeExitFlushStarted) return;
    beforeExitFlushStarted = true;
    void flushAllManifests();
  });
  process.once("exit", () => {
    flushAllManifestsSync();
  });
}

// ─── readManifest ────────────────────────────────────────────────────────

/**
 * Read state-manifest.json and return parsed manifest, or null if not found.
 */
export function readManifest(basePath: string): StateManifest | null {
  const manifestPath = join(basePath, ".gsd", "state-manifest.json");

  if (!existsSync(manifestPath)) {
    return null;
  }

  const raw = readFileSync(manifestPath, "utf-8");
  const parsed = JSON.parse(raw) as StateManifest;

  if (parsed.version !== 1) {
    throw new Error(`Unsupported manifest version: ${parsed.version}`);
  }

  // Validate required fields to avoid cryptic errors during restore.
  if (!Array.isArray(parsed.milestones) || !Array.isArray(parsed.slices) ||
      !Array.isArray(parsed.tasks) || !Array.isArray(parsed.decisions) ||
      !Array.isArray(parsed.verification_evidence)) {
    throw new Error("Malformed manifest: missing or invalid required arrays");
  }

  for (const key of ["requirements", "artifacts", "replan_history", "assessments", "quality_gates", "milestone_commit_attributions"] as const) {
    if (parsed[key] !== undefined && !Array.isArray(parsed[key])) {
      throw new Error(`Malformed manifest: ${key} must be an array when present`);
    }
  }

  return parsed;
}

function stripGsdPrefix(path: string): string {
  return path.startsWith(".gsd/") ? path.slice(".gsd/".length) : path;
}

function artifactProjectionPath(basePath: string, artifactPath: string): string {
  const gsdDir = resolve(basePath, ".gsd");
  const fullPath = resolve(gsdDir, stripGsdPrefix(artifactPath));
  const rel = relative(gsdDir, fullPath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Malformed manifest: artifact path escapes .gsd: ${artifactPath}`);
  }
  return fullPath;
}

function restoreArtifactProjections(basePath: string, manifest: StateManifest): void {
  if (manifest.artifacts === undefined) return;

  for (const artifact of manifest.artifacts) {
    const content = artifact.full_content ?? "";
    if (content === "") continue;

    atomicWriteSync(
      artifactProjectionPath(basePath, artifact.path),
      content,
    );
  }
}

// ─── bootstrapFromManifest ──────────────────────────────────────────────

/**
 * Read state-manifest.json and restore DB state from it.
 * Rehydrates artifact projection files for restored artifacts so file-based
 * fallback paths see the same evidence as the DB.
 * Re-mirrors restored legacy decisions into memories so the ADR-013
 * memory-backed decision readers see bootstrapped decisions immediately.
 * Returns true if bootstrap succeeded, false if manifest file doesn't exist.
 */
export function bootstrapFromManifest(basePath: string): boolean {
  const manifest = readManifest(basePath);

  if (!manifest) {
    return false;
  }

  restoreManifest(manifest);
  restoreArtifactProjections(basePath, manifest);
  backfillDecisionsToMemories();
  invalidateAllCaches();
  return true;
}
