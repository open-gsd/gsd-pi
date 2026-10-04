// gsd-pi Web — history service reads unit metrics from the workflow database, not metrics.json.

import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"

import { recordUnitMetricsRows } from "../resources/extensions/gsd/db/unit-metrics.ts"
import { closeDatabase, openDatabase } from "../resources/extensions/gsd/gsd-db.ts"
import type { UnitMetrics } from "../resources/extensions/gsd/metrics.ts"
import { collectHistoryData } from "../web/history-service.ts"

function useRepoAsPackageRoot(t: { after: (fn: () => void) => void }): void {
  const original = process.env.GSD_WEB_PACKAGE_ROOT
  process.env.GSD_WEB_PACKAGE_ROOT = process.cwd()
  t.after(() => {
    if (original === undefined) delete process.env.GSD_WEB_PACKAGE_ROOT
    else process.env.GSD_WEB_PACKAGE_ROOT = original
  })
}

function unit(id: string, startedAt: number, cost: number): UnitMetrics {
  return {
    type: "execute-task",
    id,
    model: "test-model",
    startedAt,
    finishedAt: startedAt + 1000,
    tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
    cost,
    toolCalls: 2,
    assistantMessages: 1,
    userMessages: 1,
  }
}

test("collectHistoryData returns database rows when metrics.json holds other units", async (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-web-history-")))
  t.after(() => {
    closeDatabase()
    rmSync(base, { recursive: true, force: true })
  })
  useRepoAsPackageRoot(t)
  mkdirSync(join(base, ".gsd"), { recursive: true })

  openDatabase(join(base, ".gsd", "gsd.db"))
  recordUnitMetricsRows([unit("M001/S01/T01", 1000, 0.5), unit("M001/S01/T02", 5000, 0.25)])
  closeDatabase()
  // A ledger file with a unit the database does not hold.
  writeFileSync(
    join(base, ".gsd", "metrics.json"),
    JSON.stringify({ version: 1, projectStartedAt: 1, units: [unit("M009/S09/T09", 9000, 99)] }),
  )

  const data = await collectHistoryData(base)

  assert.deepEqual(data.units.map((entry) => entry.id), ["M001/S01/T01", "M001/S01/T02"])
  assert.deepEqual([data.totals.units, data.totals.cost], [2, 0.75])
  assert.deepEqual(data.bySlice.map((slice) => [slice.sliceId, slice.cost]), [["M001/S01", 0.75]])
})

test("collectHistoryData fails when the project database is missing, even with a metrics.json", async (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-web-history-nodb-")))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  useRepoAsPackageRoot(t)
  mkdirSync(join(base, ".gsd"), { recursive: true })
  writeFileSync(
    join(base, ".gsd", "metrics.json"),
    JSON.stringify({ version: 1, projectStartedAt: 1, units: [unit("M001/S01/T01", 1000, 0.5)] }),
  )

  await assert.rejects(() => collectHistoryData(base), /project database unavailable/)
})
