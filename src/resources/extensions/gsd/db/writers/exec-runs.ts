// Project/App: gsd-pi
// File Purpose: Single-writer layer for exec_runs — the host record of every
// gsd_exec / gsd_uat_exec command, bound to the Attempt it ran in.
//
// A row is a host fact (see db-exec-run-schema.ts). Evidence checks read these
// rows; they never read `.gsd/exec/<id>.meta.json`.

import { getDb, transaction } from "../engine.js";
import { findWorktreeSegment } from "../../worktree-root.js";

export interface ExecRunRow {
  id: string;
  kind: "exec" | "uat_exec";
  runtime: string;
  command: string;
  cwd: string;
  exit_code: number | null;
  signal: string | null;
  timed_out: number;
  aborted: number;
  started_at: string;
  duration_ms: number;
  output_hash: string;
  milestone_id: string | null;
  slice_id: string | null;
  check_id: string | null;
  attempt_ref: string | null;
}

export type ExecRunInput =
  & Pick<ExecRunRow, "id" | "runtime" | "command" | "cwd" | "exit_code" | "signal" | "started_at" | "duration_ms" | "output_hash">
  & { timedOut: boolean; aborted: boolean }
  & ({ kind: "exec" } | { kind: "uat_exec"; milestoneId: string; sliceId: string; checkId: string });

/** Identity of one run-uat attempt. It is also the run id of the saved UAT result. */
export function uatAttemptRef(milestoneId: string, sliceId: string, attempt: number): string {
  return `uat:${milestoneId}:${sliceId}:attempt-${attempt}`;
}

/**
 * The Attempt a run belongs to, read in the transaction that stores the run.
 * A UAT run belongs to the run-uat attempt that is not saved yet. Another run
 * belongs to the Task Attempt of its caller that is not settled. The caller is
 * known by the scope of its worker: `<MID>` for a Milestone, `<MID>-<SID>` for
 * a Slice. The scope is the worker lock (GSD_MILESTONE_LOCK, GSD_SLICE_LOCK);
 * without a lock it is the name of the worktree the run is in. So parallel
 * workers each bind their own runs.
 * With no such Attempt, or with more than one, the run is unbound and proves
 * nothing.
 */
/** Name of the GSD worktree a path is in ("" outside one). */
function worktreeNameOf(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const segment = findWorktreeSegment(normalized);
  return segment ? normalized.slice(segment.afterWorktrees).split("/")[0] ?? "" : "";
}

function callerScopeOf(cwd: string): string {
  const milestoneLock = process.env.GSD_MILESTONE_LOCK?.trim();
  if (!milestoneLock) return worktreeNameOf(cwd);
  const sliceLock = process.env.GSD_SLICE_LOCK?.trim();
  return sliceLock ? `${milestoneLock}-${sliceLock}` : milestoneLock;
}

function currentAttemptRef(input: ExecRunInput): string | null {
  if (input.kind === "uat_exec") {
    const row = getDb().prepare(`
      SELECT MAX(attempt) AS attempt
      FROM gate_runs
      WHERE gate_id = 'UAT' AND gate_type = 'uat' AND unit_type = 'run-uat'
        AND milestone_id = :milestone_id AND slice_id = :slice_id
    `).get({ ":milestone_id": input.milestoneId, ":slice_id": input.sliceId });
    return uatAttemptRef(input.milestoneId, input.sliceId, Number(row?.["attempt"] ?? 0) + 1);
  }
  const open = getDb().prepare(`
    SELECT attempt.attempt_id
    FROM workflow_execution_attempts attempt
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.lifecycle_id = attempt.lifecycle_id
     AND lifecycle.project_id = attempt.project_id
    WHERE lifecycle.item_kind = 'task' AND attempt.attempt_state != 'settled'
      AND (
        lifecycle.milestone_id = :scope
        OR lifecycle.milestone_id || '-' || lifecycle.slice_id = :scope
        OR (
          NOT EXISTS (SELECT 1 FROM milestones WHERE id = :scope)
          AND NOT EXISTS (SELECT 1 FROM slices WHERE milestone_id || '-' || id = :scope)
        )
      )
    LIMIT 2
  `).all({ ":scope": callerScopeOf(input.cwd) });
  return open.length === 1 ? String(open[0]!["attempt_id"]) : null;
}

export function recordExecRun(input: ExecRunInput): ExecRunRow {
  return transaction(() => {
    const uat = input.kind === "uat_exec" ? input : null;
    const row: ExecRunRow = {
      id: input.id,
      kind: input.kind,
      runtime: input.runtime,
      command: input.command,
      cwd: input.cwd,
      exit_code: input.exit_code,
      signal: input.signal,
      timed_out: input.timedOut ? 1 : 0,
      aborted: input.aborted ? 1 : 0,
      started_at: input.started_at,
      duration_ms: input.duration_ms,
      output_hash: input.output_hash,
      milestone_id: uat?.milestoneId ?? null,
      slice_id: uat?.sliceId ?? null,
      check_id: uat?.checkId ?? null,
      attempt_ref: currentAttemptRef(input),
    };
    const columns = Object.keys(row);
    getDb().prepare(
      `INSERT INTO exec_runs (${columns.join(", ")}) VALUES (${columns.map((column) => `:${column}`).join(", ")})`,
    ).run(Object.fromEntries(columns.map((column) => [`:${column}`, row[column as keyof ExecRunRow]])));
    return row;
  });
}

export function readExecRun(id: string): ExecRunRow | null {
  const row = getDb().prepare("SELECT * FROM exec_runs WHERE id = :id").get({ ":id": id });
  return (row as unknown as ExecRunRow | undefined) ?? null;
}

export function listExecRunsOfAttempt(attemptRef: string): ExecRunRow[] {
  return getDb().prepare(
    "SELECT * FROM exec_runs WHERE attempt_ref = :attempt_ref ORDER BY started_at, id",
  ).all({ ":attempt_ref": attemptRef }) as unknown as ExecRunRow[];
}

/** Exit 0 and no signal, timeout or abort. */
export function execRunSucceeded(run: ExecRunRow): boolean {
  return run.exit_code === 0 && run.signal === null && run.timed_out === 0 && run.aborted === 0;
}
