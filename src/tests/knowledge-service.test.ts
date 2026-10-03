// gsd-pi Web — knowledge service reads the workflow database, not KNOWLEDGE.md.

import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"

import { closeDatabase, openDatabase } from "../resources/extensions/gsd/gsd-db.ts"
import { createMemory } from "../resources/extensions/gsd/memory-store.ts"
import { collectKnowledgeData } from "../web/knowledge-service.ts"

function useRepoAsPackageRoot(t: { after: (fn: () => void) => void }): void {
  const original = process.env.GSD_WEB_PACKAGE_ROOT
  process.env.GSD_WEB_PACKAGE_ROOT = process.cwd()
  t.after(() => {
    if (original === undefined) delete process.env.GSD_WEB_PACKAGE_ROOT
    else process.env.GSD_WEB_PACKAGE_ROOT = original
  })
}

test("collectKnowledgeData returns database rows when KNOWLEDGE.md is stale", async (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-web-knowledge-")))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  useRepoAsPackageRoot(t)
  mkdirSync(join(base, ".gsd"), { recursive: true })

  openDatabase(join(base, ".gsd", "gsd.db"))
  createMemory({
    category: "rule",
    content: "Rule from the database",
    scope: "project",
    structuredFields: { sourceKnowledgeId: "K001", rule: "Rule from the database", scopeText: "project", why: "new", added: "today" },
  })
  closeDatabase()
  writeFileSync(
    join(base, ".gsd", "KNOWLEDGE.md"),
    "# Project Knowledge\n\n## Rules\n\n| # | Scope | Rule | Why | Added |\n|---|-------|------|-----|-------|\n| K001 | project | Stale file rule | old | 2026-01-01 |\n",
  )

  const data = await collectKnowledgeData(base)

  assert.deepEqual(
    data.entries.filter((entry) => entry.type === "rule"),
    [{ id: "K001", title: "project", content: "Rule from the database — new — today", type: "rule" }],
  )
  assert.equal(JSON.stringify(data.entries).includes("Stale file rule"), false)
})

test("collectKnowledgeData fails when the project database is missing, even with a KNOWLEDGE.md", async (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-web-knowledge-nodb-")))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  useRepoAsPackageRoot(t)
  mkdirSync(join(base, ".gsd"), { recursive: true })
  writeFileSync(join(base, ".gsd", "KNOWLEDGE.md"), "# Project Knowledge\n\n## Deployment\n\nNotes.\n")

  await assert.rejects(() => collectKnowledgeData(base), /project database unavailable/)
})
