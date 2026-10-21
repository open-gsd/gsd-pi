// Project/App Name: gsd-pi + DB-authoritative milestone readiness for `--auto` chaining
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>
//
// The `new-milestone --auto` chain decision historically hinged on regex-matching
// a specific notify string ("Milestone <id> ready."), which is only emitted on one
// of several planning success paths. Any run that finishes planning through a
// different branch — or takes an early-return handoff path — completes successfully
// yet never chains into execution (issue #1295).
//
// This module makes the decision authoritative by querying the workflow DB directly:
// a milestone is executable when the derived active (non-terminal) milestone has at
// least one slice. For `new-milestone --auto`, callers can pass a pre-run snapshot
// so the fallback only trusts readiness produced by the current planning command.
// The notify-text signal remains a fast path; this is the deciding fallback.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  closeWorkflowDatabase,
  openExistingWorkflowDatabase,
} from './resources/extensions/gsd/db-workspace.js'
import type { MilestoneRow } from './resources/extensions/gsd/db-milestone-artifact-rows.js'
import {
  getAllMilestones,
  getMilestoneSlices,
  getSlicesByMilestoneIds,
} from './resources/extensions/gsd/gsd-db.js'
import { classifyMilestoneReadiness } from './resources/extensions/gsd/milestone-readiness.js'
import {
  buildMilestoneFileName,
  resolveFile,
  resolveMilestonePath,
} from './resources/extensions/gsd/paths.js'
import { isClosedStatus } from './resources/extensions/gsd/status-guards.js'

export interface MilestoneExecutionSnapshot {
  milestones: Record<string, {
    status: string
    sliceCount: number
    dependsOn: string[]
  }>
}

function milestoneArtifactExistsInResolvedDir(
  milestoneDir: string | null,
  milestoneId: string,
  suffix: string,
): boolean {
  if (!milestoneDir) return false
  const flatPath = join(milestoneDir, buildMilestoneFileName(milestoneId, suffix))
  return existsSync(flatPath) || resolveFile(milestoneDir, milestoneId, suffix) !== null
}

/**
 * Mirror `buildRegistryAndFindActive` active-milestone selection: defer queued-shell
 * milestones (queued, no context, zero slices) so a later planned milestone is
 * treated as active instead of an older orphan shell (#1295).
 */
function findDerivedActiveMilestone(basePath: string): MilestoneRow | null {
  const milestones = getAllMilestones()
  const completeMilestoneIds = new Set<string>()
  const parkedMilestoneIds = new Set<string>()

  for (const m of milestones) {
    if (m.status === 'parked') {
      parkedMilestoneIds.add(m.id)
      continue
    }
    if (isClosedStatus(m.status)) {
      completeMilestoneIds.add(m.id)
    }
  }

  const activeMilestoneIds = milestones
    .filter((m) => !parkedMilestoneIds.has(m.id))
    .map((m) => m.id)
  const slicesByMilestone = getSlicesByMilestoneIds(activeMilestoneIds)

  let firstDeferredQueuedShell: MilestoneRow | null = null
  let activeMilestoneFound = false

  for (const m of milestones) {
    if (parkedMilestoneIds.has(m.id)) continue
    if (completeMilestoneIds.has(m.id)) continue

    const slices = slicesByMilestone.get(m.id) ?? []
    const milestoneDir = resolveMilestonePath(basePath, m.id)
    const hasContext = milestoneArtifactExistsInResolvedDir(milestoneDir, m.id, 'CONTEXT')
    const hasDraftContext = !hasContext && milestoneArtifactExistsInResolvedDir(milestoneDir, m.id, 'CONTEXT-DRAFT')
    const readiness = classifyMilestoneReadiness({
      status: m.status,
      hasContext,
      hasDraftContext,
      sliceCount: slices.length,
    })

    if (!activeMilestoneFound) {
      const depsUnmet = m.depends_on.some((dep) => !completeMilestoneIds.has(dep))
      if (depsUnmet) continue

      if (readiness.kind === 'queued-shell') {
        if (!firstDeferredQueuedShell) firstDeferredQueuedShell = m
        continue
      }

      activeMilestoneFound = true
      return m
    }
  }

  return firstDeferredQueuedShell
}

function buildMilestoneExecutionSnapshot(): MilestoneExecutionSnapshot {
  const milestones = getAllMilestones()
  const slicesByMilestone = getSlicesByMilestoneIds(milestones.map((m) => m.id))
  const snapshot: MilestoneExecutionSnapshot = { milestones: {} }

  for (const milestone of milestones) {
    snapshot.milestones[milestone.id] = {
      status: milestone.status,
      sliceCount: (slicesByMilestone.get(milestone.id) ?? []).length,
      dependsOn: milestone.depends_on,
    }
  }

  return snapshot
}

function milestoneSnapshotEntryChanged(
  before: MilestoneExecutionSnapshot['milestones'][string] | undefined,
  after: MilestoneExecutionSnapshot['milestones'][string] | undefined,
): boolean {
  if (!after) return false
  if (!before) return true
  return (
    before.status !== after.status ||
    before.sliceCount !== after.sliceCount ||
    before.dependsOn.join('\0') !== after.dependsOn.join('\0')
  )
}

/**
 * Capture the milestone execution state before a `new-milestone --auto` run.
 * Missing DBs are treated as an empty pre-run snapshot; unreadable DBs return
 * null so callers can conservatively skip the DB fallback.
 */
export function captureMilestoneExecutionSnapshot(basePath: string): MilestoneExecutionSnapshot | null {
  const opened = openExistingWorkflowDatabase(basePath)
  if (!opened.ok) {
    return opened.reason === 'missing-database' || opened.reason === 'missing-gsd-dir'
      ? { milestones: {} }
      : null
  }
  try {
    return buildMilestoneExecutionSnapshot()
  } catch {
    return null
  } finally {
    closeWorkflowDatabase()
  }
}

function findExecutableMilestoneInDb(
  basePath: string,
  options: { changedSince?: MilestoneExecutionSnapshot } = {},
): string | null {
  const opened = openExistingWorkflowDatabase(basePath)
  if (!opened.ok) return null
  try {
    const active = findDerivedActiveMilestone(basePath)
    if (active == null || getMilestoneSlices(active.id).length === 0) return null

    if (options.changedSince) {
      const after = buildMilestoneExecutionSnapshot()
      if (!milestoneSnapshotEntryChanged(options.changedSince.milestones[active.id], after.milestones[active.id])) {
        return null
      }
    }

    return active.id
  } catch {
    return null
  } finally {
    closeWorkflowDatabase()
  }
}

/**
 * Return true when the workflow DB for `basePath` holds an executable milestone —
 * an active (non-terminal) milestone with at least one slice — meaning auto-mode
 * has real work to pick up.
 * When `changedSince` is supplied, the executable milestone must also be newly
 * created or materially changed since that snapshot.
 *
 * Never throws: returns false when the DB is missing or cannot be opened/queried,
 * so the caller can fall back to the notify-text signal.
 */
export function isMilestoneExecutableInDb(
  basePath: string,
  options: { changedSince?: MilestoneExecutionSnapshot } = {},
): boolean {
  return findExecutableMilestoneInDb(basePath, options) != null
}
