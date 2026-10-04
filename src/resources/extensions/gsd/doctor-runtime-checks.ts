import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { DoctorIssue, DoctorIssueCode } from "./doctor-types.js";
import { removeLockDirectory } from "./session-lock.js";
import { cleanNumberedGsdVariants } from "./repo-identity.js";
import { milestonesDir, gsdRoot, milestoneDirExists } from "./paths.js";
import { deriveState, invalidateStateCache, isGhostMilestone, isReusableGhostMilestone } from "./state.js";
import { renderStateContent, renderStateProjection } from "./workflow-projections.js";
import { saveFile } from "./files.js";
import { nativeIsRepo, nativeForEachRef, nativeUpdateRef } from "./native-git-bridge.js";
import { readCrashLock, isLockProcessAlive, clearStaleWorkerLock } from "./crash-recovery.js";
import { getActiveAutoWorkers } from "./db/auto-workers.js";
import { normalizeRealPath } from "./paths.js";
import { ensureGitignore, isGsdGitignored } from "./gitignore.js";
import { readAllSessionStatuses, isSessionStale, removeSessionStatus } from "./session-status-io.js";
import { isCurrentGsdStateIntactForMigratingCleanup, recoverFailedMigration } from "./migrate-external.js";
import { findMilestoneIds } from "./milestone-ids.js";
import { getAllMilestones, getSliceRunUatAssessment, isDbAvailable } from "./gsd-db.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { removeLegacyProjectionTreeSync, removeProjectionTreeSync } from "./atomic-write.js";
import {
  loadUnboundProjectionEvidence,
  previewUnboundProjectionEvidenceResolution,
  isControlPublicationIntentName,
  CONTROL_INTENT_QUARANTINE_MIN_AGE_MS,
} from "./managed-projection-history.js";
import {
  getSupersedingActiveMilestoneId,
  PAUSED_SESSION_KV_KEY,
  type PausedSessionMetadata,
} from "./interrupted-session.js";
import { deleteRuntimeKv, getRuntimeKv } from "./db/runtime-kv.js";
import { deleteUatRetryCounter, listUatRetryCounters, readHookStateJson } from "./db/writers/runtime-control.js";

const MAX_UAT_ATTEMPTS = 3;

export async function checkRuntimeHealth(
  basePath: string,
  issues: DoctorIssue[],
  fixesApplied: string[],
  shouldFix: (code: DoctorIssueCode) => boolean,
): Promise<void> {
  const root = gsdRoot(basePath);
  const hadDatabaseAtStart = existsSync(join(root, "gsd.db"));
  const gitPrefs = loadEffectiveGSDPreferences(basePath)?.preferences?.git;
  const manageGitignore = gitPrefs?.manage_gitignore;

  if (existsSync(root)) {
    try {
      for (const evidence of loadUnboundProjectionEvidence(basePath)) {
        const discard = previewUnboundProjectionEvidenceResolution(basePath, evidence.evidenceId, "discard");
        const preserve = previewUnboundProjectionEvidenceResolution(basePath, evidence.evidenceId, "preserve");
        const restore = previewUnboundProjectionEvidenceResolution(basePath, evidence.evidenceId, "restore");
        issues.push({
          severity: "error",
          code: "unresolved_projection_evidence",
          scope: "project",
          unitId: "project",
          message: `Unresolved ${evidence.scope} projection evidence for ${evidence.logicalPath} is retained at .gsd/${evidence.evidencePath}. Review exact content ${discard.contentDigest}. Resolve by ID: /gsd doctor resolve-evidence ${evidence.evidenceId} --action=discard --consent=${discard.consent}; --action=preserve --consent=${preserve.consent} retains it at .gsd/${preserve.destinationPath}; or --action=restore --consent=${restore.consent} restores it to .gsd/${restore.destinationPath}.`,
          file: `.gsd/${evidence.evidencePath}`,
          fixable: false,
        });
      }
    } catch (error) {
      issues.push({
        severity: "error",
        code: "unresolved_projection_evidence",
        scope: "project",
        unitId: "project",
        message: `Projection recovery evidence could not be assessed: ${error instanceof Error ? error.message : String(error)}`,
        file: ".gsd/migration/unbound-projection-evidence.json",
        fixable: false,
      });
    }
  }

  // ── Stale control-publication intents (#2154) ─────────────────────────
  // Lock-free scan: reads names only, never opens the projection-root
  // identity lock or replays anything, so it also reports on exactly the
  // wedged stores where every managed open throws. Only intents past the
  // supervised-quarantine age are listed: a fresh intent is either an
  // in-flight publication or drains on the next successful open.
  try {
    const journalDir = join(root, "migration", "projection-mutations");
    const staleIntentNames: string[] = [];
    let names: string[] = [];
    try {
      names = readdirSync(journalDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const name of names.sort()) {
      if (!isControlPublicationIntentName(name)) continue;
      const intentPath = join(journalDir, name);
      let stat;
      try {
        stat = lstatSync(intentPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        continue;
      }
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      if (Date.now() - stat.mtimeMs < CONTROL_INTENT_QUARANTINE_MIN_AGE_MS) continue;
      staleIntentNames.push(name);
    }
    for (const name of staleIntentNames) {
      issues.push({
        severity: "error",
        code: "stale_control_publication_intent",
        scope: "project",
        unitId: "project",
        message: `Stale prepared control-publication intent .gsd/migration/projection-mutations/${name} is pending native replay. A pending intent that still completes is drained on the next projection write; if every render fails with "control publication content evidence changed" or "control publication evidence retention is incomplete", quarantine it: with all GSD sessions stopped, move the intent file into .gsd/migration/quarantined-control-publications/ (keep the file; do not delete the journal entry alone). The next GSD operation quarantines it automatically and retries.`,
        file: `.gsd/migration/projection-mutations/${name}`,
        fixable: false,
      });
    }
    // Quarantined publications from the supervised reconciliation: listed so
    // the retained bytes stay reviewable after the wedge is defused.
    const quarantineDir = join(root, "migration", "quarantined-control-publications");
    let quarantinedNames: string[] = [];
    try {
      quarantinedNames = readdirSync(quarantineDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const name of quarantinedNames.sort()) {
      // Sidecars end in ".quarantined.json" and are skipped with the
      // artifact filter; only the quarantined artifacts themselves list.
      if (!name.endsWith(".quarantined")) continue;
      issues.push({
        severity: "warning",
        code: "stale_control_publication_intent",
        scope: "project",
        unitId: "project",
        message: `Control-publication artifact ${name} was quarantined to .gsd/migration/quarantined-control-publications/${name} after its native replay failed deterministically (#2154). Its bytes and provenance sidecar (${name}.json) are preserved for review; projections regenerate from gsd.db.`,
        file: `.gsd/migration/quarantined-control-publications/${name}`,
        fixable: false,
      });
    }
  } catch (error) {
    issues.push({
      severity: "warning",
      code: "stale_control_publication_intent",
      scope: "project",
      unitId: "project",
      message: `Control-publication intent scan could not read .gsd/migration: ${error instanceof Error ? error.message : String(error)}`,
      file: ".gsd/migration",
      fixable: false,
    });
  }

  // ── Stale paused session ──────────────────────────────────────────────
  // A pause is only resumable while it targets the milestone that state
  // derivation currently considers active. Keeping an older milestone in
  // runtime_kv can otherwise pin every new /gsd auto invocation to work that
  // has been superseded in the project queue (#1643).
  try {
    const pausedSession = getRuntimeKv<PausedSessionMetadata>(
      "global",
      "",
      PAUSED_SESSION_KV_KEY,
    );
    if (pausedSession?.milestoneId) {
      const state = await deriveState(basePath);
      const activeMilestoneId = getSupersedingActiveMilestoneId(pausedSession, state);
      if (activeMilestoneId) {
        if (shouldFix("stale_paused_session")) {
          deleteRuntimeKv("global", "", PAUSED_SESSION_KV_KEY);
          fixesApplied.push(
            `cleared stale paused session for ${pausedSession.milestoneId} (active milestone: ${activeMilestoneId})`,
          );
        } else {
          issues.push({
            severity: "error",
            code: "stale_paused_session",
            scope: "project",
            unitId: "project",
            message: `Paused auto-mode session targets ${pausedSession.milestoneId}, but the active milestone is ${activeMilestoneId}. The stale pause can pin auto-mode to the superseded milestone.`,
            file: ".gsd/gsd.db",
            fixable: true,
          });
        }
      }
    }
  } catch {
    // Non-fatal — paused-session check failed
  }

  // ── Stale crash lock ──────────────────────────────────────────────────
  // Phase C pt 2: the lock state lives in the workers + unit_dispatches
  // tables now, not auto.lock. readCrashLock synthesizes a LockData from
  // the DB; isLockProcessAlive is a pure OS PID check.
  try {
    const lock = readCrashLock(basePath);
    if (lock) {
      const alive = isLockProcessAlive(lock);
      if (!alive) {
        if (shouldFix("stale_crash_lock")) {
          clearStaleWorkerLock(basePath);
          fixesApplied.push("cleared stale auto-mode worker state");
        } else {
          issues.push({
            severity: "error",
            code: "stale_crash_lock",
            scope: "project",
            unitId: "project",
            message: `Stale auto-mode worker (PID ${lock.pid}, started ${lock.startedAt}, was executing ${lock.unitType} ${lock.unitId}) — process is no longer running`,
            file: "<workers table>",
            fixable: true,
          });
        }
      }
    }
  } catch {
    // Non-fatal — crash lock check failed
  }

  // ── Stranded lock directory ────────────────────────────────────────────
  // proper-lockfile creates a `.gsd.lock/` directory as the OS-level lock
  // mechanism. If the process was SIGKILLed or crashed hard, this directory
  // can remain on disk without any live process holding it. The next session
  // fails to acquire the lock until the directory is removed (#1245).
  try {
    const lockDir = join(dirname(root), `${basename(root)}.lock`);
    if (existsSync(lockDir)) {
      const statRes = statSync(lockDir);
      if (statRes.isDirectory()) {
        // Phase C pt 2: "any live process holds the lock?" check now means
        // "is any worker registered with status='active' AND a fresh
        // heartbeat for this project?" — readCrashLock returns null for
        // healthy live workers (it surfaces stale ones only), so we must
        // consult getActiveAutoWorkers directly.
        let lockHolderAlive = false;
        try {
          const projectRoot = normalizeRealPath(basePath);
          for (const worker of getActiveAutoWorkers()) {
            if (worker.project_root_realpath !== projectRoot) continue;
            try {
              if (isLockProcessAlive({
                pid: worker.pid,
                startedAt: worker.started_at,
                unitType: "starting",
                unitId: "bootstrap",
                unitStartedAt: worker.started_at,
              })) {
                lockHolderAlive = true;
                break;
              }
            } catch {
              // Ignore malformed worker rows or transient PID probe failures.
            }
          }
        } catch {
          // If worker lookup fails, continue with the stranded lock diagnosis.
        }
        if (!lockHolderAlive) {
          issues.push({
            severity: "error",
            code: "stranded_lock_directory",
            scope: "project",
            unitId: "project",
            message: `Stranded lock directory "${lockDir}" exists but no live process holds the session lock. This blocks new auto-mode sessions from starting.`,
            file: lockDir,
            fixable: true,
          });
          if (shouldFix("stranded_lock_directory")) {
            try {
              removeLockDirectory(lockDir);
              fixesApplied.push(`removed stranded lock directory ${lockDir}`);
            } catch (error) {
              fixesApplied.push(
                `failed to remove stranded lock directory ${lockDir}` +
                  ` (${error instanceof Error ? error.message : String(error)})`,
              );
            }
          }
        }
      }
    }
  } catch {
    // Non-fatal — stranded lock directory check failed
  }

  // ── Stale parallel sessions ────────────────────────────────────────────
  try {
    const parallelStatuses = readAllSessionStatuses(basePath);
    for (const status of parallelStatuses) {
      if (isSessionStale(status)) {
        issues.push({
          severity: "warning",
          code: "stale_parallel_session",
          scope: "project",
          unitId: status.milestoneId,
          message: `Stale parallel session for ${status.milestoneId} (PID ${status.pid}, started ${new Date(status.startedAt).toISOString()}, last heartbeat ${new Date(status.lastHeartbeat).toISOString()}) — process is no longer running`,
          file: `.gsd/parallel/${status.milestoneId}.status.json`,
          fixable: true,
        });

        if (shouldFix("stale_parallel_session")) {
          removeSessionStatus(basePath, status.milestoneId);
          fixesApplied.push(`cleaned up stale parallel session for ${status.milestoneId}`);
        }
      }
    }
  } catch {
    // Non-fatal — parallel session check failed
  }

  // ── Stale hook state ──────────────────────────────────────────────────
  try {
    // Hook state is a database row; hook-state.json is its diagnostic copy.
    const { hookStateScope } = await import("./rule-registry.js");
    const raw = readHookStateJson(hookStateScope(basePath));
    if (raw !== null) {
      const state = JSON.parse(raw);
      const hasCycleCounts = state.cycleCounts && typeof state.cycleCounts === "object"
        && Object.keys(state.cycleCounts).length > 0;
      // A persisted gate block re-arms a failed blocking gate on resume;
      // clearing it would let unreviewed work execute, so it is never stale (#2194).
      const hasPendingGateBlock = state.gateBlockPending
        && typeof state.gateBlockPending === "object"
        && typeof state.gateBlockPending.hookName === "string";

      // Only flag if there are actual cycle counts AND no auto-mode is running
      if (hasCycleCounts && !hasPendingGateBlock) {
        const lock = readCrashLock(basePath);
        const autoRunning = lock ? isLockProcessAlive(lock) : false;

        if (!autoRunning) {
          issues.push({
            severity: "info",
            code: "stale_hook_state",
            scope: "project",
            unitId: "project",
            message: `hook state has ${Object.keys(state.cycleCounts).length} residual cycle count(s) from a previous session`,
            fixable: true,
          });

          if (shouldFix("stale_hook_state")) {
            const { clearPersistedHookState } = await import("./post-unit-hooks.js");
            clearPersistedHookState(basePath);
            fixesApplied.push("cleared stale hook state");
          }
        }
      }
    } else if (existsSync(join(root, "hook-state.json"))) {
      // No row: the file is from a build that kept hook state in the file. It is never read.
      issues.push({
        severity: "info",
        code: "legacy_hook_state_file",
        scope: "project",
        unitId: "project",
        message: "hook-state.json is left from an older build; hook state is read from the database only",
        file: ".gsd/hook-state.json",
        fixable: true,
      });

      if (shouldFix("legacy_hook_state_file")) {
        rmSync(join(root, "hook-state.json"), { force: true });
        fixesApplied.push("removed legacy hook-state.json");
      }
    }
  } catch {
    // Non-fatal — hook state check failed
  }

  // ── Exhausted run-uat retry counters ──────────────────────────────────
  try {
    // The retry counter is a database row (uat_retry_counters).
    for (const counter of listUatRetryCounters()) {
      const mid = counter.milestone_id;
      const sid = counter.slice_id;
      const count = counter.attempts;
      // The run-uat verdict is the assessment row; ASSESSMENT.md is not read.
      if (count < MAX_UAT_ATTEMPTS || getSliceRunUatAssessment(mid, sid)?.status) continue;

      issues.push({
        severity: "warning",
        code: "uat_retry_exhausted",
        scope: "slice",
        unitId: `${mid}/${sid}`,
        message: `run-uat for ${mid}/${sid} exhausted ${count} attempt(s) without an ASSESSMENT verdict. Reset the retry counter after fixing the underlying UAT/tool issue, then rerun /gsd auto.`,
        fixable: true,
      });

      if (shouldFix("uat_retry_exhausted")) {
        deleteUatRetryCounter(mid, sid);
        fixesApplied.push(`reset exhausted run-uat retry counter for ${mid}/${sid}`);
      }
    }
  } catch {
    // Non-fatal — UAT retry counter check failed
  }

  // ── Activity log bloat ────────────────────────────────────────────────
  try {
    const activityDir = join(root, "activity");
    if (existsSync(activityDir)) {
      const files = readdirSync(activityDir);
      let totalSize = 0;
      for (const f of files) {
        try {
          totalSize += statSync(join(activityDir, f)).size;
        } catch {
          // stat failed — skip
        }
      }

      const totalMB = totalSize / (1024 * 1024);
      const BLOAT_FILE_THRESHOLD = 500;
      const BLOAT_SIZE_MB = 100;

      if (files.length > BLOAT_FILE_THRESHOLD || totalMB > BLOAT_SIZE_MB) {
        issues.push({
          severity: "warning",
          code: "activity_log_bloat",
          scope: "project",
          unitId: "project",
          message: `Activity logs: ${files.length} files, ${totalMB.toFixed(1)}MB (thresholds: ${BLOAT_FILE_THRESHOLD} files / ${BLOAT_SIZE_MB}MB)`,
          file: ".gsd/activity/",
          fixable: true,
        });

        if (shouldFix("activity_log_bloat")) {
          const { pruneActivityLogs } = await import("./activity-log.js");
          pruneActivityLogs(activityDir, 7); // 7-day retention
          fixesApplied.push("pruned activity logs (7-day retention)");
        }
      }
    }
  } catch {
    // Non-fatal — activity log check failed
  }

  // ── STATE.md health ───────────────────────────────────────────────────
  try {
    const stateFilePath = join(gsdRoot(basePath), "STATE.md");

    if (existsSync(milestonesDir(basePath))) {
      invalidateStateCache();
      const freshContent = renderStateContent(await deriveState(basePath));
      // With no DB there is nothing authoritative to compare against.
      if (isDbAvailable() && !existsSync(stateFilePath)) {
        issues.push({
          severity: "warning",
          code: "state_file_missing",
          scope: "project",
          unitId: "project",
          message: "STATE.md is missing — state display will not work",
          file: ".gsd/STATE.md",
          fixable: true,
        });

        if (shouldFix("state_file_missing") && !(await renderStateProjection(basePath)).stale) {
          fixesApplied.push("created STATE.md from derived state");
        }
      } else if (isDbAvailable() && readFileSync(stateFilePath, "utf-8") !== freshContent) {
        issues.push({
          severity: "warning",
          code: "state_file_stale",
          scope: "project",
          unitId: "project",
          message: "STATE.md is stale — its content differs from the database state",
          file: ".gsd/STATE.md",
          fixable: true,
        });

        if (shouldFix("state_file_stale") && !(await renderStateProjection(basePath)).stale) {
          fixesApplied.push("rebuilt STATE.md from derived state");
        }
      }
    }
  } catch {
    // Non-fatal — STATE.md check failed
  }

  // ── Gitignore drift ───────────────────────────────────────────────────
  try {
    const gitignorePath = join(basePath, ".gitignore");
    if (existsSync(gitignorePath) && nativeIsRepo(basePath)) {
      const content = readFileSync(gitignorePath, "utf-8");
      const existingLines = new Set(
        content.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#")),
      );

      // Check for critical runtime patterns that must be present.
      // NOTE: GSD_RUNTIME_PATTERNS in gitignore.ts is the canonical source of truth.
      // This is a minimal subset for the doctor check.
      const criticalPatterns = [
        ".gsd/activity/",
        ".gsd/runtime/",
        ".gsd/auto.lock",
        ".gsd/gsd.db*",
        ".gsd/completed-units*.json",
        ".gsd/event-log.jsonl",
      ];

      // If blanket .gsd/ or .gsd is present, all .gsd/* patterns are covered —
      // but NOT the .gsd-worktrees/ sibling, which always needs its own entry.
      const hasBlanketIgnore = existingLines.has(".gsd/") || existingLines.has(".gsd");
      const missing: string[] = [];
      if (!existingLines.has(".gsd-worktrees/") && !existingLines.has(".gsd-worktrees")) {
        missing.push(".gsd-worktrees/");
      }
      if (!existingLines.has(".gsd-backups/") && !existingLines.has(".gsd-backups")) {
        missing.push(".gsd-backups/");
      }
      if (!hasBlanketIgnore) {
        missing.push(...criticalPatterns.filter(p => !existingLines.has(p)));
      }

      if (missing.length > 0) {
        issues.push({
          severity: "warning",
          code: "gitignore_missing_patterns",
          scope: "project",
          unitId: "project",
          message: `${missing.length} critical GSD runtime pattern(s) missing from .gitignore: ${missing.join(", ")}`,
          file: ".gitignore",
          fixable: true,
        });

        if (shouldFix("gitignore_missing_patterns")) {
          ensureGitignore(basePath, { manageGitignore });
          fixesApplied.push("added missing GSD runtime patterns to .gitignore");
        }
      }
    }
  } catch {
    // Non-fatal — gitignore check failed
  }

  // ── External state symlink health ──────────────────────────────────────
  try {
    const localGsd = join(basePath, ".gsd");
    if (existsSync(localGsd)) {
      const stat = lstatSync(localGsd);

      // Check for .gsd.migrating (failed migration)
      const migratingPath = join(basePath, ".gsd.migrating");
      if (existsSync(migratingPath)) {
        issues.push({
          severity: "error",
          code: "failed_migration",
          scope: "project",
          unitId: "project",
          message: "Found .gsd.migrating — a previous external state migration failed. State may be incomplete.",
          file: ".gsd.migrating",
          fixable: true,
        });

        if (shouldFix("failed_migration")) {
          if (recoverFailedMigration(basePath)) {
            fixesApplied.push("recovered failed external state migration");
          } else if (isCurrentGsdStateIntactForMigratingCleanup(basePath)) {
            try {
              rmSync(migratingPath, { recursive: true, force: true });
              fixesApplied.push("removed stale .gsd.migrating orphan after validating current .gsd state");
            } catch (err) {
              fixesApplied.push(`failed to remove stale .gsd.migrating orphan at ${migratingPath}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      }

      // Check symlink target exists
      if (stat.isSymbolicLink()) {
        try {
          realpathSync(localGsd);
        } catch {
          issues.push({
            severity: "error",
            code: "broken_symlink",
            scope: "project",
            unitId: "project",
            message: ".gsd symlink target does not exist. External state directory may have been deleted.",
            file: ".gsd",
            fixable: false,
          });
        }

        // ── Symlinked .gsd without .gitignore entry (#4423) ──
        // When `.gsd` is a symlink AND not gitignored, `git add -A -- :!.gsd/...`
        // pathspecs fail with "beyond a symbolic link". Without self-heal this
        // silently drops new user files during auto-commit.
        if (nativeIsRepo(basePath) && !isGsdGitignored(basePath)) {
          issues.push({
            severity: "warning",
            code: "symlinked_gsd_unignored",
            scope: "project",
            unitId: "project",
            message: ".gsd is a symlink to external state but is not listed in .gitignore. This causes git pathspec exclusions to fail and can lead to silently dropped new files during auto-commit. Add `.gsd` to .gitignore.",
            file: ".gitignore",
            fixable: true,
          });

          if (shouldFix("symlinked_gsd_unignored")) {
            const modified = ensureGitignore(basePath, { manageGitignore });
            if (modified) fixesApplied.push("added .gsd to .gitignore (symlinked external state)");
          }
        }
      }
    }
  } catch {
    // Non-fatal — external state check failed
  }

  // ── Numbered .gsd collision variants (#2205) ───────────────────────────
  // macOS APFS can create ".gsd 2", ".gsd 3" etc. when a directory blocks
  // symlink creation. These must be removed so the canonical .gsd is used.
  try {
    const variantPattern = /^\.gsd \d+$/;
    const entries = readdirSync(basePath);
    const variants = entries.filter(e => variantPattern.test(e));
    if (variants.length > 0) {
      for (const v of variants) {
        issues.push({
          severity: "warning",
          code: "numbered_gsd_variant",
          scope: "project",
          unitId: "project",
          message: `Found macOS collision variant "${v}" — this can cause GSD state to appear deleted.`,
          file: v,
          fixable: true,
        });
      }

      if (shouldFix("numbered_gsd_variant")) {
        const removed = cleanNumberedGsdVariants(basePath);
        for (const name of removed) {
          fixesApplied.push(`removed numbered .gsd variant: ${name}`);
        }
      }
    }
  } catch {
    // Non-fatal — variant check failed
  }

  // ── Metrics ledger integrity ───────────────────────────────────────────
  try {
    const metricsPath = join(root, "metrics.json");
    if (existsSync(metricsPath)) {
      try {
        const raw = readFileSync(metricsPath, "utf-8");
        const ledger = JSON.parse(raw);
        if (ledger.version !== 1 || !Array.isArray(ledger.units)) {
          issues.push({
            severity: "warning",
            code: "metrics_ledger_corrupt",
            scope: "project",
            unitId: "project",
            message: "metrics.json has an unexpected structure (version !== 1 or units is not an array) — metrics data may be unreliable",
            file: ".gsd/metrics.json",
            fixable: false,
          });
        }
      } catch {
        issues.push({
          severity: "warning",
          code: "metrics_ledger_corrupt",
          scope: "project",
          unitId: "project",
          message: "metrics.json is not valid JSON — metrics data may be corrupt",
          file: ".gsd/metrics.json",
          fixable: false,
        });
      }
    }
  } catch {
    // Non-fatal — metrics check failed
  }

  // ── Metrics ledger bloat ──────────────────────────────────────────────
  // The metrics ledger has no TTL and grows by one entry per completed unit.
  // At 50 units/day a project can accumulate tens of thousands of entries over
  // months of use. Prune to the newest 1500 when the threshold is exceeded.
  try {
    const metricsFilePath = join(root, "metrics.json");
    if (existsSync(metricsFilePath)) {
      try {
        const raw = readFileSync(metricsFilePath, "utf-8");
        const parsed = JSON.parse(raw);
        const BLOAT_UNITS_THRESHOLD = 2000;
        if (parsed.version === 1 && Array.isArray(parsed.units) && parsed.units.length > BLOAT_UNITS_THRESHOLD) {
          const fileSizeMB = (statSync(metricsFilePath).size / (1024 * 1024)).toFixed(1);
          issues.push({
            severity: "warning",
            code: "metrics_ledger_bloat",
            scope: "project",
            unitId: "project",
            message: `metrics.json has ${parsed.units.length} unit entries (${fileSizeMB}MB) — threshold is ${BLOAT_UNITS_THRESHOLD}. Run /gsd doctor --fix to prune to the newest 1500 entries.`,
            file: ".gsd/metrics.json",
            fixable: true,
          });
          if (shouldFix("metrics_ledger_bloat")) {
            const { pruneMetricsLedger } = await import("./metrics.js");
            const removed = pruneMetricsLedger(basePath, 1500);
            fixesApplied.push(`pruned metrics ledger: removed ${removed} oldest entries (${parsed.units.length - removed} remain)`);
          }
        }
      } catch {
        // JSON parse failed — already handled by the integrity check above
      }
    }
  } catch {
    // Non-fatal — metrics bloat check failed
  }

  // ── Large planning file detection ──────────────────────────────────────
  // Files over 100KB can cause LLM context pressure. Report the worst offenders.
  try {
    const MAX_FILE_BYTES = 100 * 1024; // 100KB
    const milestonesPath = milestonesDir(basePath);
    if (existsSync(milestonesPath)) {
      const largeFiles: Array<{ path: string; sizeKB: number }> = [];
      function scanForLargeFiles(dir: string, depth = 0): void {
        if (depth > 6) return;
        try {
          for (const entry of readdirSync(dir)) {
            const full = join(dir, entry);
            try {
              const s = statSync(full);
              if (s.isDirectory()) { scanForLargeFiles(full, depth + 1); continue; }
              if (entry.endsWith(".md") && s.size > MAX_FILE_BYTES) {
                largeFiles.push({ path: full.replace(basePath + "/", ""), sizeKB: Math.round(s.size / 1024) });
              }
            } catch { /* skip entry */ }
          }
        } catch { /* skip dir */ }
      }
      scanForLargeFiles(milestonesPath);
      if (largeFiles.length > 0) {
        largeFiles.sort((a, b) => b.sizeKB - a.sizeKB);
        const worst = largeFiles[0]!;
        issues.push({
          severity: "warning",
          code: "large_planning_file",
          scope: "project",
          unitId: "project",
          message: `${largeFiles.length} planning file(s) exceed 100KB — largest: ${worst.path} (${worst.sizeKB}KB). Large files cause LLM context pressure.`,
          file: worst.path,
          fixable: false,
        });
      }
    }
  } catch {
    // Non-fatal — large file scan failed
  }

  // ── Snapshot ref bloat ────────────────────────────────────────────────
  // refs/gsd/snapshots/ accumulate over time. Prune to newest 5 per label
  // when total count exceeds threshold.
  try {
    if (nativeIsRepo(basePath)) {
      const refs = nativeForEachRef(basePath, "refs/gsd/snapshots/");
      if (refs.length > 50) {
        issues.push({
          severity: "warning",
          code: "snapshot_ref_bloat",
          scope: "project",
          unitId: "project",
          message: `${refs.length} snapshot refs found under refs/gsd/snapshots/ — pruning to newest 5 per label will reclaim git storage`,
          fixable: true,
        });

        if (shouldFix("snapshot_ref_bloat")) {
          const byLabel = new Map<string, string[]>();
          for (const ref of refs) {
            const parts = ref.split("/");
            const label = parts.slice(0, -1).join("/");
            if (!byLabel.has(label)) byLabel.set(label, []);
            byLabel.get(label)!.push(ref);
          }
          let pruned = 0;
          for (const [, labelRefs] of byLabel) {
            const sorted = labelRefs.sort();
            for (const old of sorted.slice(0, -5)) {
              try {
                nativeUpdateRef(basePath, old);
                pruned++;
              } catch { /* skip */ }
            }
          }
          if (pruned > 0) {
            fixesApplied.push(`pruned ${pruned} old snapshot ref(s)`);
          }
        }
      }
    }
  } catch {
    // Non-fatal — snapshot ref check failed
  }

  // ── Orphan milestone directories (#4996) ──────────────────────────────
  // Walk every milestone ID on disk. Any dir that has no DB row, no worktree,
  // and no content files is an orphaned stub — it skews nextMilestoneId and
  // was likely created by ensurePreconditions or showHeadlessMilestoneCreation
  // for a phantom forward-reference. Surface as a fixable warning.
  try {
    const milestoneIds = findMilestoneIds(basePath);
    const hasDbFile = hadDatabaseAtStart;
    for (const mid of milestoneIds) {
      const isOrphan = isReusableGhostMilestone(basePath, mid)
        || (!hasDbFile && isGhostMilestone(basePath, mid));
      if (isOrphan) {
        issues.push({
          severity: "warning",
          code: "orphan_milestone_dir",
          scope: "milestone",
          unitId: mid,
          message: `Orphan milestone directory: ${mid} — directory exists on disk with no DB row, no worktree, and no content files. This stub skews milestone ID generation and should be removed.`,
          file: `.gsd/milestones/${mid}`,
          fixable: true,
        });

        if (shouldFix("orphan_milestone_dir")) {
          try {
            const orphanPath = hasDbFile
              ? join(milestonesDir(basePath), mid)
              : join(root, "milestones", mid);
            if (hasDbFile) removeProjectionTreeSync(orphanPath);
            else removeLegacyProjectionTreeSync(basePath, orphanPath);
            fixesApplied.push(`removed orphan milestone directory: ${mid}`);
          } catch {
            // Non-fatal — leave for manual cleanup
          }
        }
      }
    }
  } catch {
    // Non-fatal — orphan milestone directory check failed
  }

  // ── Orphan milestone DB rows (DB present, filesystem missing) ─────────
  // A milestone row without a corresponding milestone directory can keep
  // stale milestones "active" and trigger unwanted continuation behavior.
  try {
    if (isDbAvailable()) {
      for (const milestone of getAllMilestones()) {
        // Every milestone status, including `queued`, is subject to the
        // missing-directory orphan check below. This is a directory-PRESENCE
        // check (milestoneDirExists), not a content-bearing one: the workflow
        // prompts create the milestone directory early (often before any
        // CONTEXT/ROADMAP is written), so a legitimate in-flight queued
        // milestone with only a scaffold directory (e.g. an empty slices/)
        // must not be flagged. resolveMilestonePath alone would return null for
        // such a legacy scaffold dir and produce a false positive during normal
        // planning. A `queued` phantom left by gsd_milestone_generate_id (no
        // directory at all) is correctly reported as an orphan to clean up
        // (#1524).
        if (!milestoneDirExists(basePath, milestone.id)) {
          issues.push({
            severity: "warning",
            code: "orphan_milestone_db",
            scope: "milestone",
            unitId: milestone.id,
            message: `Orphan milestone DB row: ${milestone.id} — DB row exists but milestone directory is missing from disk. This can cause stale milestone continuation.`,
            file: `.gsd/gsd.db`,
            fixable: false,
          });
        }
      }
    }
  } catch {
    // Non-fatal — orphan milestone DB row check failed
  }
}
