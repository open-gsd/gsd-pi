// Project/App: gsd-pi
// File Purpose: Enforce exact-merged UAT evidence required by source-declared closure dossiers.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getDb } from "./db/engine.js";
import type { TaskTechnicalVerdictSnapshot } from "./task-verification-domain-operation.js";
import { readUatExecEvidenceMetadata } from "./uat-run.js";

export interface ExactMergedUatClosureInput {
  basePath: string;
  task: {
    milestoneId: string;
    sliceId: string;
    taskId: string;
  };
  verdict: TaskTechnicalVerdictSnapshot;
}

interface ClosureDossier {
  milestoneId?: unknown;
  sliceId?: unknown;
  canonicalClosure?: {
    blockedEntities?: unknown;
    requiredEvidence?: {
      automatedUatVerdict?: unknown;
      durableVerdictReceipt?: unknown;
      sourceBinding?: unknown;
    };
  };
  hashes?: {
    dossierHash?: unknown;
    capstoneEvidenceHash?: unknown;
  };
}

interface VerificationEvidenceRow {
  command_or_tool: string;
  durable_output_ref: string;
  environment_json: string;
  source_revision: string;
  observation: string;
}

const DOSSIER_PATH = join("docs", "dev", "m003-s07-cutover-dossier.json");
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

function readClosureDossier(input: ExactMergedUatClosureInput): ClosureDossier | null {
  const path = join(input.basePath, DOSSIER_PATH);
  if (!existsSync(path)) return null;

  let dossier: ClosureDossier;
  try {
    dossier = JSON.parse(readFileSync(path, "utf8")) as ClosureDossier;
  } catch {
    throw new Error("Verified Task publication found an invalid closure dossier");
  }
  if (dossier.milestoneId !== input.task.milestoneId || dossier.sliceId !== input.task.sliceId) {
    return null;
  }
  const entityId = `${input.task.milestoneId}/${input.task.sliceId}/${input.task.taskId}`;
  if (!Array.isArray(dossier.canonicalClosure?.blockedEntities) ||
      !dossier.canonicalClosure.blockedEntities.includes(entityId)) {
    return null;
  }
  const required = dossier.canonicalClosure.requiredEvidence;
  if (required?.automatedUatVerdict !== "pass" ||
      required.durableVerdictReceipt !== "required" ||
      required.sourceBinding !== "exact_merged_revision") {
    throw new Error("Verified Task publication found an invalid exact-merged closure contract");
  }
  return dossier;
}

function requiredHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`Verified Task publication requires a valid ${field}`);
  }
  return value;
}

function requiredEnvironmentString(
  environment: Record<string, unknown>,
  field: string,
): string {
  const value = environment[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Verified Task publication requires exact-merged ${field} evidence`);
  }
  return value;
}

function gitOutput(basePath: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: basePath, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function readVerificationEvidence(verdict: TaskTechnicalVerdictSnapshot): VerificationEvidenceRow {
  const row = getDb().prepare(`
    SELECT command_or_tool, durable_output_ref, environment_json,
           source_revision, observation
    FROM workflow_verification_evidence
    WHERE evidence_id = :evidence_id
      AND verdict_id = :verdict_id
      AND attempt_id = :attempt_id
  `).get({
    ":evidence_id": verdict.evidenceId,
    ":verdict_id": verdict.verdictId,
    ":attempt_id": verdict.attemptId,
  }) as unknown as VerificationEvidenceRow | undefined;
  if (!row) {
    throw new Error("Verified Task publication requires durable exact-merged verification evidence");
  }
  return row;
}

function readEnvironment(row: VerificationEvidenceRow): Record<string, unknown> {
  let environment: unknown;
  try {
    environment = JSON.parse(row.environment_json) as unknown;
  } catch {
    throw new Error("Verified Task publication requires valid exact-merged evidence metadata");
  }
  if (environment && typeof environment === "object" && !Array.isArray(environment)) {
    return environment as Record<string, unknown>;
  }
  throw new Error("Verified Task publication requires valid exact-merged evidence metadata");
}

function requireExactMergeBinding(
  input: ExactMergedUatClosureInput,
  dossier: ClosureDossier,
  row: VerificationEvidenceRow,
): Record<string, unknown> {
  if (row.command_or_tool !== "gsd_uat_exec" || row.observation !== "passed" ||
      row.source_revision !== input.verdict.testedSourceRevision) {
    throw new Error("Verified Task publication requires passing gsd_uat_exec evidence for the tested source");
  }
  const environment = readEnvironment(row);
  const dossierHash = requiredHash(dossier.hashes?.dossierHash, "dossier hash");
  const capstoneHash = requiredHash(dossier.hashes?.capstoneEvidenceHash, "capstone hash");
  if (requiredEnvironmentString(environment, "dossierHash") !== dossierHash ||
      requiredEnvironmentString(environment, "capstoneEvidenceHash") !== capstoneHash ||
      requiredEnvironmentString(environment, "sourceContentRevision") !== input.verdict.testedSourceRevision ||
      requiredEnvironmentString(environment, "authorityBaseline") !== "4/4") {
    throw new Error("Verified Task publication exact-merged evidence does not match the closure dossier");
  }
  const mergeCommit = requiredEnvironmentString(environment, "localMergeCommit");
  if (!COMMIT_PATTERN.test(mergeCommit) || gitOutput(input.basePath, ["rev-parse", "--verify", "HEAD"]) !== mergeCommit) {
    throw new Error("Verified Task publication exact-merged evidence does not match the current HEAD");
  }
  if (gitOutput(input.basePath, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    ".",
    ":(exclude).gsd/**",
  ])) {
    throw new Error("Verified Task publication exact-merged source must be clean");
  }
  return environment;
}

function requireUatExecEvidence(
  input: ExactMergedUatClosureInput,
  row: VerificationEvidenceRow,
): string {
  const metadata = readUatExecEvidenceMetadata(input.basePath, row.durable_output_ref);
  if (!metadata || metadata.metadata?.kind !== "uat_exec" ||
      metadata.metadata.milestoneId !== input.task.milestoneId ||
      metadata.metadata.sliceId !== input.task.sliceId ||
      metadata.exit_code !== 0 || metadata.signal !== null ||
      metadata.timed_out !== false || metadata.aborted === true) {
    throw new Error("Verified Task publication requires successful typed gsd_uat_exec evidence");
  }
  if (typeof metadata.id !== "string" || !metadata.id.trim()) {
    throw new Error("Verified Task publication requires identified gsd_uat_exec evidence");
  }
  return metadata.id;
}

function requireCanonicalUatReceipt(
  input: ExactMergedUatClosureInput,
  environment: Record<string, unknown>,
  evidenceId: string,
): void {
  const assessment = getDb().prepare(`
    SELECT full_content
    FROM assessments
    WHERE milestone_id = :milestone_id
      AND slice_id = :slice_id
      AND scope = 'run-uat'
      AND lower(status) = 'pass'
    ORDER BY created_at DESC, path DESC
    LIMIT 1
  `).get({
    ":milestone_id": input.task.milestoneId,
    ":slice_id": input.task.sliceId,
  }) as Record<string, unknown> | undefined;
  const content = assessment ? String(assessment["full_content"] ?? "") : "";
  const requiredValues = [
    `gsd_uat_exec:${evidenceId}`,
    requiredEnvironmentString(environment, "localMergeCommit"),
    requiredEnvironmentString(environment, "sourceContentRevision"),
    requiredEnvironmentString(environment, "dossierHash"),
    requiredEnvironmentString(environment, "capstoneEvidenceHash"),
  ];
  if (!content || requiredValues.some((value) => !content.includes(value))) {
    throw new Error("Verified Task publication requires a matching database-backed exact-merged UAT assessment");
  }
  const runId = /^runId:\s*(\S+)\s*$/m.exec(content)?.[1];
  if (!runId) {
    throw new Error("Verified Task publication requires an identified exact-merged UAT run");
  }
  const gate = getDb().prepare(`
    SELECT 1 AS present
    FROM quality_gates
    WHERE milestone_id = :milestone_id
      AND slice_id = :slice_id
      AND gate_id = 'UAT'
      AND task_id = ''
      AND status = 'complete'
      AND verdict = 'pass'
  `).get({
    ":milestone_id": input.task.milestoneId,
    ":slice_id": input.task.sliceId,
  });
  const run = getDb().prepare(`
    SELECT findings
    FROM gate_runs
    WHERE turn_id = :run_id
      AND milestone_id = :milestone_id
      AND slice_id = :slice_id
      AND gate_id = 'UAT'
      AND gate_type = 'uat'
      AND unit_type = 'run-uat'
      AND outcome = 'pass'
    ORDER BY id DESC
    LIMIT 1
  `).get({
    ":run_id": runId,
    ":milestone_id": input.task.milestoneId,
    ":slice_id": input.task.sliceId,
  }) as Record<string, unknown> | undefined;
  if (!gate || String(run?.["findings"] ?? "") !== content) {
    throw new Error("Verified Task publication requires a passing canonical exact-merged UAT gate receipt");
  }
}

export function requireExactMergedUatClosureEvidence(input: ExactMergedUatClosureInput): void {
  const dossier = readClosureDossier(input);
  if (!dossier) return;
  const row = readVerificationEvidence(input.verdict);
  const environment = requireExactMergeBinding(input, dossier, row);
  const evidenceId = requireUatExecEvidence(input, row);
  requireCanonicalUatReceipt(input, environment, evidenceId);
}
