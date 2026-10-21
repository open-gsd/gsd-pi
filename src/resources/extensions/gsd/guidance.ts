// Project/App: gsd-pi
// File Purpose: Guidance module — the single catalog mapping typed findings
// (Recovery kinds, milestone blocker kinds, doctor issue codes, crash unit
// classes) to user-facing remediation: what happened and what to do next.
//
// Emit sites pass the typed finding; phrasing, command names, and step
// ordering live here. A missing catalog row is a visible gap, not a silent
// omission scattered across call sites.

import type { RecoveryFailureKind } from "./recovery-classification.js";
import type { DoctorIssueCode } from "./doctor-types.js";

// ─── Shape ──────────────────────────────────────────────────────────────

export interface Guidance {
  summary: string;
  steps: string[];
}

/** Flatten guidance into a notification / pause-banner string. */
export function formatGuidance(guidance: Guidance): string {
  if (guidance.steps.length === 0) return guidance.summary;
  const numbered = guidance.steps.map((step, index) => `${index + 1}. ${step}`).join("\n");
  return `${guidance.summary}\n\n${numbered}`;
}

// ─── Recovery Classification remediation ────────────────────────────────
// Keyed by RecoveryFailureKind. The provider kind is split by transience,
// which Recovery Classification resolves before looking up guidance.

export type RecoveryGuidanceKey =
  | Exclude<RecoveryFailureKind, "provider">
  | "provider-transient"
  | "provider-permanent";

const RECOVERY_REMEDIATION: Record<RecoveryGuidanceKey, string> = {
  "tool-schema": "Fix the Unit Tool Contract or tool schema before retrying.",
  "tool-contract":
    "Fix the Unit Tool Contract or prompt so the Unit is only asked to use tools owned by its phase.",
  "tool-unavailable":
    "The tool surface had not finished registering when the Unit called it (workflow MCP startup race). Retry after the surface is ready; escalate if the tool never appears.",
  "deterministic-policy": "Resolve the policy blocker; retrying the same Unit will repeat the failure.",
  "lifecycle-progression":
    "Route to the required owning Unit or restore the missing artifact before advancing lifecycle state.",
  "stale-worker":
    "Run `/gsd doctor` to detect and clear the stale worker or lock, then run `/gsd auto` to resume.",
  "worktree-invalid":
    "Run `/gsd doctor` to diagnose the milestone worktree (`gsd worktree list` shows its state). Repair it, or merge salvageable work with `gsd worktree merge <name>` before recreating — recreating discards uncommitted work.",
  "verification-drift":
    "Run `/gsd status` to see the verification finding, fix or re-run the verification, then run `/gsd auto` to resume. `/gsd doctor` can repair stale state files.",
  "reconciliation-drift":
    "Run `/gsd doctor` to surface the persistent or repair-failed drift kinds, apply its fixes, then run `/gsd auto` to resume.",
  "illegal-transition":
    "A derived Phase edge rejected by the Phase Transition Invariant survived reconciliation; inspect deriveState and the State Reconciliation Module before resuming.",
  "projection-lock-transient":
    "Another Windows process temporarily holds the projection root. Retry through the existing transient budget; if contention persists, use `/gsd doctor` to inspect stale workers and orphaned worktrees.",
  "runtime-unknown":
    "Inspect the observed runtime error, then recover with /gsd doctor and /gsd auto. If it repeats, add a dedicated recovery classification.",
  "provider-transient": "Retry after the provider/network condition clears.",
  "provider-permanent": "Inspect provider credentials, model entitlement, or request shape.",
};

export function recoveryRemediation(key: RecoveryGuidanceKey, observedError?: string): string {
  const catalog = RECOVERY_REMEDIATION[key];
  if (key !== "runtime-unknown") return catalog;
  const observed = observedError?.trim() || "an unclassified runtime error";
  return (
    `Runtime error: ${observed}. ` +
    `Recovery options: inspect that error, run /gsd doctor, then /gsd auto to resume. ` +
    `If it repeats, add a dedicated recovery classification.`
  );
}

// ─── Milestone validation blockers ──────────────────────────────────────
// NOTE: the first line of each blocker is load-bearing — validation-block-guard
// matches /milestone validation returned needs-(?:attention|remediation)/i.
// Keep that phrase intact when editing.

export function needsAttentionBlockerGuidance(
  milestoneId: string,
  allowLegacyOverride = true,
): string {
  if (!allowLegacyOverride) {
    return [
      `Milestone ${milestoneId} is blocked because milestone validation returned needs-attention.`,
      `Fix options:`,
      `1. Review the validation details: \`/gsd status\``,
      `2. Fix the issue or gather the missing proof, then re-run milestone validation with current structured evidence: \`/gsd validate-milestone\``,
      `3. Run \`/gsd auto\` after canonical validation passes.`,
    ].join("\n");
  }
  return [
    `Milestone ${milestoneId} is blocked because milestone validation returned needs-attention.`,
    `Fix options:`,
    `1. Review the validation details: \`/gsd status\``,
    `2. If you fixed the missing evidence or issue, re-run milestone validation: \`/gsd validate-milestone\``,
    `3. If the finding is acceptable, override it: \`/gsd verdict pass --rationale "why this is okay"\``,
    `4. If this should wait, defer it explicitly: \`/gsd park ${milestoneId}\``,
    `After validation or override passes, run \`/gsd auto\` to complete and merge the milestone.`,
  ].join("\n");
}

export function needsRemediationBlockerGuidance(
  milestoneId: string,
  allowLegacyOverride = true,
): string {
  if (!allowLegacyOverride) {
    return [
      `Milestone ${milestoneId} is blocked because milestone validation returned needs-remediation, but all slices are complete.`,
      `Fix options:`,
      `1. Run \`/gsd dispatch reassess\` to add remediation slices, then complete the new work.`,
      `2. Re-run milestone validation with current structured evidence: \`/gsd validate-milestone\``,
      `3. Run \`/gsd auto\` after canonical validation passes.`,
    ].join("\n");
  }
  return [
    `Milestone ${milestoneId} is blocked because milestone validation returned needs-remediation, but all slices are complete.`,
    `Fix options:`,
    `1. Run \`/gsd dispatch reassess\` to add remediation slices, then run \`/gsd auto\``,
    `2. If the finding is acceptable, override it: \`/gsd verdict pass --rationale "why this is okay"\``,
    `3. If this should wait, defer it explicitly: \`/gsd park ${milestoneId}\``,
  ].join("\n");
}

// ─── Milestone closeout UAT sign-off blockers ───────────────────────────
// The first sentence is the blocker finding; the numbered steps are the
// resolution path. `verdict` is the recorded non-PASS verdict, or undefined
// when no verdict has been recorded at all.

export function uatSignoffBlockerGuidance(
  milestoneId: string,
  sliceId: string,
  verdict?: string,
): string {
  const finding =
    verdict === undefined
      ? `missing UAT PASS verdict for ${sliceId}`
      : `UAT verdict for ${sliceId} is "${verdict}"`;
  const sliceSpecificRerunStep =
    `If ${sliceId} is not the most recently completed slice, type a chat request to re-run UAT for ${sliceId}; run-uat will record the verdict through \`gsd_uat_result_save\`.`;
  const steps =
    verdict === undefined
      ? [
          `1. Run UAT for the most recently completed slice to record a verdict: \`/gsd dispatch uat\``,
          `2. ${sliceSpecificRerunStep}`,
          `3. Review the UAT criteria and progress: \`/gsd status\``,
          `4. After UAT records PASS, run \`/gsd auto\` to complete the milestone.`,
        ]
      : [
          `1. Review the failing UAT findings: \`/gsd status\` (the ${sliceId} ASSESSMENT records what failed)`,
          `2. Fix the issue, then re-run UAT for the most recently completed slice to record a fresh verdict: \`/gsd dispatch uat\``,
          `3. ${sliceSpecificRerunStep}`,
          `4. If the fix needs new implementation work, add remediation slices: \`/gsd dispatch reassess\``,
          `5. After UAT records PASS, run \`/gsd auto\` to complete the milestone.`,
        ];
  return [
    `Cannot complete milestone ${milestoneId}: ${finding}. Manual UAT sign-off (PASS) is required before milestone closure.`,
    `Fix options:`,
    ...steps,
  ].join("\n");
}

// ─── Worktree isolation degradation ─────────────────────────────────────
// The first sentence of each notice is load-bearing for log matching and
// tests — keep it intact and append guidance after it.

function restoreIsolationHint(milestoneId: string): string {
  return `To restore isolation: close any processes using the old worktree, merge salvageable work with \`/gsd worktree merge ${milestoneId}\` or remove the stale worktree with \`/gsd worktree remove ${milestoneId}\`, then run \`/gsd doctor fix\`.`;
}

export function worktreeCreationFailedGuidance(milestoneId: string, error: string): string {
  return [
    `Auto-worktree creation for ${milestoneId} failed: ${error}. Continuing in project root.`,
    `Worktree isolation is degraded for this session.`,
    restoreIsolationHint(milestoneId),
  ].join("\n");
}

export function isolationDegradedFallbackGuidance(milestoneId: string): string {
  return [
    `Worktree isolation is degraded. Fell back to branch milestone/${milestoneId}.`,
    `Work continues safely on the milestone branch in the project root.`,
    restoreIsolationHint(milestoneId),
  ].join("\n");
}

/** Hard entry blockers from auto-start: bootstrap stopped, user must act. */
export function milestoneEntryBlockedGuidance(
  milestoneId: string,
  reason: "creation-failed" | "isolation-degraded",
): string {
  const finding =
    reason === "creation-failed"
      ? `worktree/branch creation failed. Isolation is degraded.`
      : `isolation is degraded from a prior worktree failure.`;
  return [
    `Cannot enter milestone ${milestoneId}: ${finding}`,
    restoreIsolationHint(milestoneId),
    `Then run \`/gsd auto\` to retry.`,
  ].join("\n");
}

// ─── Crash recovery resume hints ────────────────────────────────────────

/** Resume hint for an interrupted auto-mode unit, by unit class. */
export function crashResumeHint(unitType: string, unitId: string): string | undefined {
  if (unitType === "starting" && unitId === "bootstrap") {
    return `No work was lost. Run /gsd auto to restart.`;
  }
  if (unitType.includes("research") || unitType.includes("plan")) {
    return `The ${unitType} unit may be incomplete. Run /gsd auto to re-run it.`;
  }
  if (unitType.includes("execute")) {
    return `Task execution was interrupted. Run /gsd auto to resume — completed work is preserved.`;
  }
  if (unitType.includes("complete")) {
    return `Slice/milestone completion was interrupted. Run /gsd auto to finish.`;
  }
  return undefined;
}

// ─── Doctor issue fix hints ─────────────────────────────────────────────
// Partial by design: codes without a row render no hint. Add rows here as
// guidance is authored — the gap is visible in one place.

const DOCTOR_FIX_HINTS: Partial<Record<DoctorIssueCode, string>> = {
  db_locked:
    "On macOS/Linux, run `/gsd doctor --fix` to stop proven dormant GSD holders, or stop the listed PID(s) manually. On Windows, identify the process using gsd.db in Resource Monitor and stop it.",
  db_unavailable:
    "The workflow database could not be opened — state derivation is degraded. Restart the session; if it persists, run `/gsd doctor` from the project root.",
  stale_crash_lock: "Run `/gsd doctor fix` to clear the stale lock, then `/gsd auto` to resume.",
  stale_paused_session: "Run `/gsd doctor fix` to clear the stale pause, then `/gsd auto` to resume the active milestone.",
  stale_parallel_session: "Run `/gsd doctor fix` to clear the stale session registration.",
  unresolved_git_conflicts:
    "Resolve the conflict markers, commit, then re-run `/gsd auto`.",
  conflict_markers_in_tracked_files:
    "Search the listed files for `<<<<<<<` markers, resolve, and commit.",
  worktree_dirty:
    "Commit or merge the worktree's changes (`gsd worktree merge <name>`) before removing it.",
  worktree_branch_merged: "The branch is merged — remove the worktree to reclaim space.",
  orphaned_auto_worktree: "Run `/gsd doctor fix` to fix, or merge salvageable work with `gsd worktree merge <name>`.",
  gitignore_missing_patterns: "Run `/gsd doctor fix` to append the missing .gitignore patterns.",
  invalid_preferences: "Edit .gsd/PREFERENCES.md to fix the invalid field, then re-run the command.",
  provider_key_missing: "Add the provider API key to your environment or provider config, then retry.",
  provider_key_backedoff: "The key is cooling down after repeated failures — wait, or switch the phase model in .gsd/PREFERENCES.md.",
  state_file_stale: "Run `/gsd doctor fix` to rebuild the projection from the database.",
  state_file_missing: "Run `/gsd doctor fix` to rebuild the projection from the database.",
  projection_drift: "Run `/gsd doctor fix` to rebuild markdown projections from the database (DB is the source of truth).",
  validation_source_revision_mismatch:
    "If GSD's pre-merge auto-commit captured unintended files, run `git reset --mixed HEAD^` to preserve them as working-tree changes, remove or ignore unwanted files, then retry. Otherwise re-run `/gsd validate-milestone <id>` against the intended content before `/gsd auto`.",
  artifact_user_content_missing:
    "Doctor cannot recreate user-authored content from the database. Re-run `/gsd discuss` for CONTEXT artifacts or `/gsd auto` for RESEARCH artifacts in that milestone.",
  uat_retry_exhausted: "Review the failing UAT criteria via `/gsd status`, fix the issue, then re-run `/gsd auto`.",
};

export function doctorFixHint(code: DoctorIssueCode): string | undefined {
  return DOCTOR_FIX_HINTS[code];
}
