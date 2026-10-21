#!/usr/bin/env node

// Project/App: gsd-pi
// File Purpose: Collect local canonical inputs for the M003/S07 cutover dossier.

import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import {
  COMMAND_INVENTORY,
  buildDossier,
  DEFERRED_BLOCKERS,
  renderDossier,
} from "./m003-s07-cutover-dossier.mjs";
import {
  REPO_ROOT as NO_CUTOVER_ROOT,
  runSemanticShadowNoCutoverGate,
} from "./semantic-shadow-no-cutover-gate.mjs";
import {
  REPO_ROOT as AUTHORITY_BASELINE_ROOT,
  runWorkflowAuthorityBaseline,
} from "./workflow-authority-baseline.mjs";
import { compareLifecycleShadow } from "../src/resources/extensions/gsd/db/lifecycle-shadow-comparison.ts";
import {
  normalizeSemanticShadowCapstoneEvidence,
  M003_S07_DOSSIER_SOURCE_EXCLUSIONS,
  type NormalizedSemanticShadowCapstoneEvidence,
} from "../src/resources/extensions/gsd/tests/semantic-shadow-capstone-harness.ts";
import {
  captureMilestoneVerificationSourceRevision,
} from "../src/resources/extensions/gsd/verification-source-integrity.ts";
import { externalGsdRoot } from "../src/resources/extensions/gsd/repo-identity.ts";

export interface DossierInputPaths {
  sourceRoot: string;
  databasePath: string;
  capstonePath: string;
}

interface CollectorDependencies {
  runNoCutover?: () => Record<string, any>;
  runAuthorityBaseline?: () => Record<string, any>;
  captureSourceRevision?: typeof captureMilestoneVerificationSourceRevision;
  resolveCanonicalDatabasePath?: (sourceRoot: string) => string;
}

interface DossierInputCliOptions extends DossierInputPaths {
  outputPath?: string;
  checkDossierPath?: string;
}

interface CanonicalSnapshot {
  authority: { projectId: string; projectRevision: number; authorityEpoch: number };
  repairHistory: Array<Record<string, unknown>>;
  liveDrift: Array<Record<string, unknown>>;
  taskReceiptHistory: Array<Record<string, unknown>>;
  taskReceiptHeads: Array<Record<string, unknown>>;
}

const CAPSTONE_LIFECYCLE_PLACEHOLDER = "capstone-fixture-lifecycle-present";
const LOCAL_INPUT_PATTERN = /(?:^[a-z][a-z0-9+.-]*:\/\/|^git@|^\\\\|^\/\/|github\.com)/iu;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalValue(nested)]),
  );
}

function hashCanonical(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex")}`;
}

function localPath(value: string, label: string): string {
  if (!value.trim() || LOCAL_INPUT_PATTERN.test(value)) throw new Error(`${label} must be a local filesystem path`);
  return resolve(value);
}

function readCanonicalSnapshot(databasePath: string): CanonicalSnapshot {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  database.exec("PRAGMA query_only = ON; BEGIN");
  try {
    const authorityRow = database.prepare(`
      SELECT project_id AS projectId, revision AS projectRevision, authority_epoch AS authorityEpoch
      FROM project_authority
    `).get() as Record<string, unknown> | undefined;
    if (!authorityRow) throw new Error("Canonical project authority is missing");

    const repairHistory = database.prepare(`
      SELECT
        event.project_revision AS resultingRevision,
        event.event_index AS eventIndex,
        event.event_id AS eventId,
        event.event_type AS eventType,
        json_extract(event.payload_json, '$.disposition') AS disposition,
        json_extract(event.payload_json, '$.comparison.kind') AS comparisonKind,
        json_extract(event.payload_json, '$.evidence.evidenceDigest') AS evidenceDigest,
        (SELECT COUNT(*) FROM workflow_domain_events sibling
          WHERE sibling.operation_id = event.operation_id) AS eventCount,
        (SELECT COUNT(*) FROM workflow_outbox outbox
          JOIN workflow_domain_events source_event ON source_event.event_id = outbox.event_id
          WHERE source_event.operation_id = event.operation_id) AS outboxCount,
        (SELECT COUNT(*) FROM workflow_projection_work projection
          WHERE projection.enqueue_operation_id = event.operation_id) AS projectionCount
      FROM workflow_domain_events event
      JOIN workflow_operations operation ON operation.operation_id = event.operation_id
        AND operation.project_id = event.project_id
      WHERE event.event_type IN ('lifecycle.shadow.advanced', 'lifecycle.shadow.repaired')
        AND operation.operation_type = 'lifecycle.shadow.repair'
        AND operation.idempotency_key LIKE 'internal:m003:s07:t02:repair:%'
        AND operation.project_id = (SELECT project_id FROM project_authority WHERE singleton = 1)
      ORDER BY event.project_revision, event.event_index, event.event_id
    `).all().map((row) => ({ ...row }));
    if (repairHistory.length !== 33) {
      throw new Error(`Canonical repair lineage must contain exactly 33 events; found ${repairHistory.length}`);
    }

    const hierarchyPairs = database.prepare(`
      WITH hierarchy AS (
        SELECT 'milestone' AS itemKind, id AS milestoneId, NULL AS sliceId, NULL AS taskId, status AS legacyStatus
        FROM milestones WHERE id = 'M003'
        UNION ALL
        SELECT 'slice', milestone_id, id, NULL, status
        FROM slices WHERE milestone_id = 'M003'
        UNION ALL
        SELECT 'task', milestone_id, slice_id, id, status
        FROM tasks WHERE milestone_id = 'M003'
      ), pairs AS (
        SELECT hierarchy.*, lifecycle.lifecycle_id AS lifecycleId,
               lifecycle.lifecycle_status AS canonicalStatus
        FROM hierarchy
        LEFT JOIN workflow_item_lifecycles lifecycle
          ON lifecycle.item_kind = hierarchy.itemKind
         AND lifecycle.milestone_id = hierarchy.milestoneId
         AND lifecycle.slice_id IS hierarchy.sliceId
         AND lifecycle.task_id IS hierarchy.taskId
        UNION ALL
        SELECT lifecycle.item_kind, lifecycle.milestone_id, lifecycle.slice_id, lifecycle.task_id,
               NULL, lifecycle.lifecycle_id, lifecycle.lifecycle_status
        FROM workflow_item_lifecycles lifecycle
        WHERE lifecycle.milestone_id = 'M003'
          AND NOT EXISTS (
            SELECT 1 FROM hierarchy
            WHERE hierarchy.itemKind = lifecycle.item_kind
              AND hierarchy.milestoneId = lifecycle.milestone_id
              AND hierarchy.sliceId IS lifecycle.slice_id
              AND hierarchy.taskId IS lifecycle.task_id
          )
      )
      SELECT * FROM pairs
      ORDER BY CASE itemKind WHEN 'milestone' THEN 0 WHEN 'slice' THEN 1 ELSE 2 END,
               milestoneId, COALESCE(sliceId, ''), COALESCE(taskId, '')
    `).all() as Array<Record<string, unknown>>;
    const liveDrift = hierarchyPairs.map((row) => {
      const legacyStatus = row["legacyStatus"] === null ? null : String(row["legacyStatus"]);
      const canonicalStatus = row["canonicalStatus"] === null ? null : String(row["canonicalStatus"]);
      const comparison = compareLifecycleShadow(legacyStatus, canonicalStatus);
      return {
        lifecycleId: row["lifecycleId"] === null ? null : String(row["lifecycleId"]),
        itemKind: String(row["itemKind"]),
        milestoneId: String(row["milestoneId"]),
        sliceId: row["sliceId"] === null ? null : String(row["sliceId"]),
        taskId: row["taskId"] === null ? null : String(row["taskId"]),
        legacyStatus,
        canonicalStatus,
        classification: comparison.kind,
      };
    });

    const receiptRows = database.prepare(`
      SELECT
        lifecycle.task_id AS taskId,
        lifecycle.lifecycle_status AS lifecycleStatus,
        attempt.attempt_number AS attemptNumber,
        attempt.attempt_id AS attemptId,
        attempt.attempt_state AS attemptState,
        result.result_id AS resultId,
        result.outcome AS resultOutcome,
        verdict.verdict_id AS verdictId,
        verdict.verdict AS verdict,
        verdict.tested_source_revision AS testedSourceRevision,
        evidence.evidence_id AS evidenceId,
        evidence.source_revision AS evidenceSourceRevision,
        evidence.observation AS observation,
        evidence.content_hash AS evidenceHash,
        evidence.durable_output_ref AS durableOutputRef,
        evidence.environment_json AS environmentJson,
        verdict.project_revision AS verdictRevision,
        CASE WHEN attempt.attempt_number = (
          SELECT MAX(latest.attempt_number)
          FROM workflow_execution_attempts latest
          WHERE latest.lifecycle_id = attempt.lifecycle_id
            AND latest.project_id = attempt.project_id
        ) THEN 1 ELSE 0 END AS current
      FROM workflow_item_lifecycles lifecycle
      JOIN workflow_execution_attempts attempt
        ON attempt.lifecycle_id = lifecycle.lifecycle_id
       AND attempt.project_id = lifecycle.project_id
      JOIN workflow_attempt_results result
        ON result.attempt_id = attempt.attempt_id
       AND result.project_id = attempt.project_id
      JOIN workflow_technical_verdicts verdict
        ON verdict.attempt_id = attempt.attempt_id
       AND verdict.project_id = attempt.project_id
       AND NOT EXISTS (
         SELECT 1 FROM workflow_technical_verdicts successor
         WHERE successor.supersedes_verdict_id = verdict.verdict_id
           AND successor.project_id = verdict.project_id
       )
      JOIN workflow_verification_evidence evidence
        ON evidence.verdict_id = verdict.verdict_id
       AND evidence.attempt_id = attempt.attempt_id
       AND evidence.project_id = attempt.project_id
      WHERE lifecycle.item_kind = 'task'
        AND lifecycle.milestone_id = 'M003'
        AND lifecycle.slice_id = 'S07'
        AND lifecycle.task_id IN ('T01', 'T02', 'T03', 'T04', 'T05', 'T06')
        AND lifecycle.project_id = (SELECT project_id FROM project_authority WHERE singleton = 1)
      ORDER BY lifecycle.task_id, attempt.attempt_number, verdict.project_revision, evidence.evidence_id
    `).all() as Array<Record<string, unknown>>;
    const taskReceiptHistory = receiptRows.map((row) => ({
      taskId: String(row["taskId"]),
      lifecycleStatus: String(row["lifecycleStatus"]),
      attemptNumber: Number(row["attemptNumber"]),
      attemptId: String(row["attemptId"]),
      attemptState: String(row["attemptState"]),
      resultId: String(row["resultId"]),
      resultOutcome: String(row["resultOutcome"]),
      verdictId: String(row["verdictId"]),
      verdict: String(row["verdict"]),
      evidenceId: String(row["evidenceId"]),
      evidenceSourceRevision: String(row["evidenceSourceRevision"]),
      observation: String(row["observation"]),
      testedSourceRevision: String(row["testedSourceRevision"]),
      evidenceHash: String(row["evidenceHash"]),
      durableOutputRef: String(row["durableOutputRef"]),
      environment: JSON.parse(String(row["environmentJson"])),
      verdictRevision: Number(row["verdictRevision"]),
      current: row["current"] === 1,
    }));
    const taskReceiptHeads = taskReceiptHistory.filter((row) => row["current"] === true);
    // T01-T06 are closed prerequisites. Their frozen history is six initial
    // Attempts plus T05's one source-drift retry; any extra row is new drift.
    if (taskReceiptHistory.length !== 7 || taskReceiptHeads.length !== 6) {
      throw new Error("Canonical T01-T06 receipt history must contain seven Attempts and six current heads");
    }

    database.exec("COMMIT");
    return {
      authority: {
        projectId: String(authorityRow["projectId"]),
        projectRevision: Number(authorityRow["projectRevision"]),
        authorityEpoch: Number(authorityRow["authorityEpoch"]),
      },
      repairHistory,
      liveDrift,
      taskReceiptHistory,
      taskReceiptHeads,
    };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

function adaptCapstone(capstone: NormalizedSemanticShadowCapstoneEvidence) {
  const observations = capstone.evidence.observations.map((observation) => ({
    ...observation,
    items: observation.items.map((item) => ({
      ...item,
      itemIdentity: {
        itemKind: item.itemIdentity.itemKind,
        milestoneId: item.itemIdentity.milestoneId,
        sliceId: item.itemIdentity.sliceId,
        taskId: item.itemIdentity.taskId,
        lifecycleId: item.itemIdentity.lifecyclePresent ? CAPSTONE_LIFECYCLE_PLACEHOLDER : null,
      },
    })),
  }));
  const lossDisposition = capstone.evidence.dispositions.find(
    (entry) => entry.disposition === "observation_loss",
  );
  if (!lossDisposition) throw new Error("Capstone observation-loss proof is missing");
  const loss = lossDisposition.proof["observationLossAccounting"] as Record<string, unknown>;
  const causes = Array.isArray(loss["causes"])
    ? loss["causes"]
    : [{ reason: loss["reason"], errorHash: loss["errorHash"] }];
  if (causes.some((cause) => !cause || typeof cause !== "object")) {
    throw new Error("Capstone observation-loss causes are incomplete");
  }
  const lossId = "capstone-observation-loss";
  return {
    observations,
    dispositionProof: capstone.evidence.dispositions.map((entry) => ({
      outcome: entry.disposition,
      evidenceHash: hashCanonical(entry),
      residueFree: entry.disposition === "rejected" && entry.proof["authorityUnchanged"] === true,
      accounted: entry.disposition === "observation_loss",
      ...(entry.disposition === "observation_loss" ? { lossRef: lossId } : {}),
    })),
    observationLosses: [{
      id: lossId,
      lossCount: Number(loss["lossCount"]),
      persistedCount: Number(loss["persistedCount"]),
      terminalRecords: 1,
      accounted: true,
      causes,
    }],
  };
}

function summarizeReports(noCutover: Record<string, any>, authorityBaseline: Record<string, any>) {
  if (noCutover.verdict !== "pass" || noCutover.githubMetadataUsed !== false) {
    throw new Error("Semantic-shadow no-cutover report must pass without GitHub metadata");
  }
  if (authorityBaseline.verdict !== "pass") throw new Error("Workflow authority baseline must pass");
  return {
    compatibilityInventory: noCutover.behavioralChecks.map((check: Record<string, unknown>) => ({
      id: check["id"],
      file: check["file"],
      title: check["title"],
      verdict: check["verdict"],
    })),
    noCutover: {
      structural: {
        passed: noCutover.structuralChecks.filter((check: Record<string, unknown>) => check["verdict"] === "pass").length,
        total: noCutover.structuralChecks.length,
      },
      behavioral: {
        passed: noCutover.behavioralChecks.filter((check: Record<string, unknown>) => check["verdict"] === "pass").length,
        total: noCutover.behavioralChecks.length,
      },
    },
    authorityBaseline: {
      passed: authorityBaseline.invariants.filter((check: Record<string, unknown>) => check["verdict"] === "pass").length,
      total: authorityBaseline.invariants.length,
    },
  };
}

export async function collectM003S07DossierInput(
  paths: DossierInputPaths,
  dependencies: CollectorDependencies = {},
): Promise<Record<string, any>> {
  const sourceRoot = localPath(paths.sourceRoot, "Source root");
  const databasePath = localPath(paths.databasePath, "Canonical database");
  const capstonePath = localPath(paths.capstonePath, "Capstone evidence");
  if (sourceRoot !== resolve(NO_CUTOVER_ROOT) || sourceRoot !== resolve(AUTHORITY_BASELINE_ROOT)) {
    throw new Error("Source root must be the local repository used by the no-cutover and authority reports");
  }
  const resolveCanonicalDatabasePath = dependencies.resolveCanonicalDatabasePath
    ?? ((root: string) => join(externalGsdRoot(root), "gsd.db"));
  const canonicalDatabasePath = localPath(resolveCanonicalDatabasePath(sourceRoot), "Resolved canonical database");
  if (realpathSync(databasePath) !== realpathSync(canonicalDatabasePath)) {
    throw new Error("Supplied database does not match the source project's canonical database identity");
  }

  const parsedCapstone = JSON.parse(readFileSync(capstonePath, "utf8"));
  const capstone = normalizeSemanticShadowCapstoneEvidence(parsedCapstone);
  const captureSourceRevision = dependencies.captureSourceRevision
    ?? ((basePath, preferences) => captureMilestoneVerificationSourceRevision(
      basePath,
      preferences,
      { excludePaths: M003_S07_DOSSIER_SOURCE_EXCLUSIONS },
    ));
  const source = captureSourceRevision(sourceRoot, undefined);
  if (!source.ok) throw new Error(`Unable to capture dossier source: ${source.error}`);
  if (capstone.evidence.sourceRevision !== source.sourceRevision) {
    throw new Error("Capstone evidence source revision does not match the current local source");
  }
  const snapshot = readCanonicalSnapshot(databasePath);
  const noCutover = await (dependencies.runNoCutover ?? runSemanticShadowNoCutoverGate)();
  const authorityBaseline = await (dependencies.runAuthorityBaseline ?? runWorkflowAuthorityBaseline)();
  const input = {
    recommendation: "NO_GO",
    observationEvidencePlane: "capstone_fixture",
    canonicalHistoryEvidencePlane: "live_project",
    evidenceSourceRevision: source.sourceRevision,
    publicResponseHash: capstone.evidence.responseHash,
    sourceCapstoneEvidenceHash: capstone.evidenceHash,
    authority: snapshot.authority,
    ...adaptCapstone(capstone),
    repairHistory: snapshot.repairHistory,
    liveDrift: snapshot.liveDrift,
    taskReceiptHistory: snapshot.taskReceiptHistory,
    taskReceiptHeads: snapshot.taskReceiptHeads,
    ...summarizeReports(noCutover, authorityBaseline),
    commands: COMMAND_INVENTORY.map((command) => ({ ...command })),
    deferredCutoverBlockers: [...DEFERRED_BLOCKERS],
  };
  const confirmedSource = captureSourceRevision(sourceRoot, undefined);
  if (!confirmedSource.ok) throw new Error(`Unable to confirm dossier source: ${confirmedSource.error}`);
  if (confirmedSource.sourceRevision !== source.sourceRevision) {
    throw new Error("Dossier source changed during collection");
  }
  const confirmedSnapshot = readCanonicalSnapshot(databasePath);
  if (hashCanonical(confirmedSnapshot) !== hashCanonical(snapshot)) {
    throw new Error("Dossier database evidence changed during collection");
  }
  return input;
}

export function parseDossierInputArgs(args: string[]): DossierInputCliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!option || ![
      "--source-root",
      "--database",
      "--capstone",
      "--output",
      "--check-dossier",
    ].includes(option)) {
      throw new Error(`Unknown argument: ${option ?? ""}`);
    }
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}`);
    if (values.has(option)) throw new Error(`Duplicate argument: ${option}`);
    values.set(option, value);
  }
  const sourceRoot = values.get("--source-root");
  const databasePath = values.get("--database");
  const capstonePath = values.get("--capstone");
  if (!sourceRoot || !databasePath || !capstonePath) {
    throw new Error(
      "Usage: m003-s07-dossier-input --source-root <path> --database <path> --capstone <path> [--output <path> | --check-dossier <path>]",
    );
  }
  const outputPath = values.get("--output");
  const checkDossierPath = values.get("--check-dossier");
  if (outputPath && checkDossierPath) {
    throw new Error("--output and --check-dossier are mutually exclusive");
  }
  return {
    sourceRoot: localPath(sourceRoot, "Source root"),
    databasePath: localPath(databasePath, "Canonical database"),
    capstonePath: localPath(capstonePath, "Capstone evidence"),
    ...(outputPath ? { outputPath: localPath(outputPath, "Output") } : {}),
    ...(checkDossierPath
      ? { checkDossierPath: localPath(checkDossierPath, "Checked dossier") }
      : {}),
  };
}

export async function main(
  args = process.argv.slice(2),
  dependencies: CollectorDependencies = {},
): Promise<void> {
  const { outputPath, checkDossierPath, ...paths } = parseDossierInputArgs(args);
  const input = await collectM003S07DossierInput(paths, dependencies);
  if (checkDossierPath) {
    const dossier = buildDossier(input);
    const expected = renderDossier(dossier);
    if (readFileSync(checkDossierPath, "utf8") !== expected) {
      throw new Error("Checked dossier is stale relative to freshly collected local evidence");
    }
    process.stdout.write(`M003/S07 live dossier valid: ${dossier.hashes.dossierHash}\n`);
    return;
  }
  const serialized = `${JSON.stringify(input, null, 2)}\n`;
  if (outputPath) writeFileSync(outputPath, serialized, "utf8");
  else process.stdout.write(serialized);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
