// gsd-pi Web — captures service reads and writes the workflow database, not CAPTURES.md.

import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"

import { appendCapture, loadActionableCaptures, loadAllCaptures } from "../resources/extensions/gsd/captures.ts"
import { openWorkflowDatabase } from "../resources/extensions/gsd/db-workspace.ts"
import {
  _getAdapter,
  closeDatabase,
  executeDomainOperation,
  openDatabase,
  readDomainOperationFence,
} from "../resources/extensions/gsd/gsd-db.ts"
import { adoptOrTransitionLifecycle } from "../resources/extensions/gsd/db/writers/lifecycle-commands.ts"
import { registerMilestones } from "../resources/extensions/gsd/milestone-registration.ts"
import { collectCapturesData, resolveCaptureAction } from "../web/captures-service.ts"

function useRepoAsPackageRoot(t: { after: (fn: () => void) => void }): void {
  const original = process.env.GSD_WEB_PACKAGE_ROOT
  process.env.GSD_WEB_PACKAGE_ROOT = process.cwd()
  t.after(() => {
    if (original === undefined) delete process.env.GSD_WEB_PACKAGE_ROOT
    else process.env.GSD_WEB_PACKAGE_ROOT = original
  })
}

test("collectCapturesData returns database rows when CAPTURES.md is edited, and resolveCaptureAction writes the database", async (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-web-captures-")))
  t.after(() => {
    closeDatabase()
    rmSync(base, { recursive: true, force: true })
  })
  useRepoAsPackageRoot(t)
  mkdirSync(join(base, ".gsd"), { recursive: true })

  openDatabase(join(base, ".gsd", "gsd.db"))
  const id = appendCapture(base, "Capture from the database")
  closeDatabase()
  // A hand edit: the pending capture marked resolved, and a section the database does not hold.
  writeFileSync(
    join(base, ".gsd", "CAPTURES.md"),
    [
      "# Captures",
      "",
      `### ${id}`,
      "**Text:** Capture from the database",
      "**Captured:** 2026-01-01T00:00:00.000Z",
      "**Status:** resolved",
      "**Classification:** quick-task",
      "",
      "### CAP-byhand01",
      "**Text:** File-only capture",
      "**Captured:** 2026-01-01T00:00:00.000Z",
      "**Status:** pending",
      "",
    ].join("\n"),
  )

  const data = await collectCapturesData(base)

  assert.deepEqual(data.entries.map((entry) => [entry.id, entry.status]), [[id, "pending"]])
  assert.deepEqual([data.pendingCount, data.actionableCount], [1, 0])

  rmSync(join(base, ".gsd", "CAPTURES.md"))
  const result = await resolveCaptureAction(
    { captureId: id, classification: "quick-task", resolution: "fix inline", rationale: "small" },
    base,
  )

  assert.deepEqual(result, { ok: true, captureId: id })
  openDatabase(join(base, ".gsd", "gsd.db"))
  assert.deepEqual(
    loadAllCaptures(base).map((entry) => [entry.id, entry.status, entry.classification, entry.resolution]),
    [[id, "resolved", "quick-task", "fix inline"]],
  )
})

test("resolveCaptureAction records the dispatch milestone, not an earlier milestone with an unmet dependency", async (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-web-captures-stamp-")))
  t.after(() => {
    closeDatabase()
    rmSync(base, { recursive: true, force: true })
  })
  useRepoAsPackageRoot(t)
  mkdirSync(join(base, ".gsd"), { recursive: true })

  // Seed the project the way production holds it: the open after the one that
  // created the database cuts it over, and the milestones are written through
  // the Domain Operation layer so every hierarchy row has its lifecycle row.
  // M002 is the milestone dispatch runs under; M001 waits on it.
  assert.equal(openWorkflowDatabase(base).reason, "created-empty")
  closeDatabase()
  assert.equal(openWorkflowDatabase(base).ok, true)
  assert.deepEqual(registerMilestones([{ id: "M001", title: "Blocked" }, { id: "M002", title: "Dispatch" }], "test"), ["M001", "M002"])
  _getAdapter()!.exec(`UPDATE milestones SET depends_on = '["M002"]' WHERE id = 'M001'`)
  const fence = readDomainOperationFence()
  executeDomainOperation({
    operationType: "test.start-milestone",
    idempotencyKey: "captures-service/start-milestone",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: {},
  }, (context) => {
    adoptOrTransitionLifecycle(context, { itemKind: "milestone", milestoneId: "M002", lifecycleStatus: "in_progress" })
    return {
      events: [{ eventType: "test.milestone-started", entityType: "milestone", entityId: "M002", payload: {}, destinations: ["test"] }],
      projections: [{ projectionKey: "test/start-milestone", projectionKind: "test", rendererVersion: "1" }],
    }
  })
  const id = appendCapture(base, "Fix the dialog width")
  closeDatabase()

  await resolveCaptureAction(
    { captureId: id, classification: "quick-task", resolution: "fix inline", rationale: "small" },
    base,
  )

  openDatabase(join(base, ".gsd", "gsd.db"))
  assert.equal(loadAllCaptures(base).find((entry) => entry.id === id)?.resolvedInMilestone, "M002")
  assert.deepEqual(loadActionableCaptures(base, "M002").map((entry) => entry.id), [id])
  assert.deepEqual(loadActionableCaptures(base, "M001"), [])
})

test("collectCapturesData fails when the project database is missing, even with a CAPTURES.md", async (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-web-captures-nodb-")))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  useRepoAsPackageRoot(t)
  mkdirSync(join(base, ".gsd"), { recursive: true })
  writeFileSync(
    join(base, ".gsd", "CAPTURES.md"),
    "# Captures\n\n### CAP-0000aaaa\n**Text:** File capture\n**Captured:** 2026-01-01T00:00:00.000Z\n**Status:** pending\n",
  )

  await assert.rejects(() => collectCapturesData(base), /project database unavailable/)
})
