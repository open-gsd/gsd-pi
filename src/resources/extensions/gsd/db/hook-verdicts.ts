// Project/App: gsd-pi
// File Purpose: Post-unit hook gate verdict rows. The verdict of a blocking
// post-unit hook (a gate) is a database row; the hook's artifact file is a
// render for the operator and decides nothing. A verdict arrives as a
// gsd_hook_verdict_save tool call, which writes the row (owner default,
// P18d). db/writers/hook-verdicts.ts owns the write SQL.

import { getDbOrNull } from "./engine.js";

/**
 * Deterministic row key of one hook gate verdict. It is derived from the hook
 * name and the trigger unit id alone, so the row is addressable without the
 * filesystem and the artifact layout cannot move it.
 */
export function hookGateVerdictPath(hookName: string, unitId: string): string {
  return `hook-verdicts/${hookName}/${unitId}.md`;
}

/**
 * The recorded verdict of the hook gate for the trigger unit, or null when
 * the hook has not recorded one. The verdict vocabulary is the hook outcome
 * vocabulary: pass, advisory, needs-rework, needs-remediation,
 * needs-attention.
 */
export function getHookGateVerdict(
  hookName: string,
  unitId: string,
): { verdict: string; rationale: string } | null {
  if (!getDbOrNull()!) return null;
  const row = getDbOrNull()!.prepare(
    `SELECT status, full_content AS rationale FROM assessments
     WHERE path = :path AND scope = 'hook-gate'`,
  ).get({ ":path": hookGateVerdictPath(hookName, unitId) }) as {
    status?: unknown;
    rationale?: unknown;
  } | undefined;
  if (!row) return null;
  return { verdict: String(row.status ?? ""), rationale: String(row.rationale ?? "") };
}
