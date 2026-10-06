import type { DatabaseSync } from "node:sqlite"

import { resolveBridgeRuntimeConfig } from "./bridge-service.ts"
import { openProjectDatabaseReadOnly } from "./project-db-read.ts"
import type { InspectData } from "../../web/lib/remaining-command-types.ts"

/**
 * Collects project inspection data from `.gsd/gsd.db`, with the same queries
 * as the TUI `/gsd inspect` command. The read does not change the project (see
 * `openProjectDatabaseReadOnly`). A project with no readable database gives
 * the empty state.
 */
export async function collectInspectData(projectCwdOverride?: string): Promise<InspectData> {
  const { projectCwd } = resolveBridgeRuntimeConfig(undefined, projectCwdOverride)

  let db: DatabaseSync | undefined
  try {
    const connection = db = openProjectDatabaseReadOnly(projectCwd)
    const count = (table: string): number =>
      Number(connection.prepare(`SELECT count(*) AS cnt FROM ${table}`).get()?.cnt ?? 0)
    const version = connection.prepare("SELECT MAX(version) AS v FROM schema_version").get()?.v

    return {
      schemaVersion: typeof version === "number" ? version : null,
      counts: {
        decisions: count("decisions"),
        requirements: count("requirements"),
        artifacts: count("artifacts"),
      },
      recentDecisions: connection
        .prepare("SELECT id, decision, choice FROM decisions ORDER BY seq DESC LIMIT 5")
        .all()
        .map((d) => ({ id: String(d.id), decision: String(d.decision), choice: String(d.choice) })),
      recentRequirements: connection
        .prepare("SELECT id, status, description FROM requirements ORDER BY id DESC LIMIT 5")
        .all()
        .map((r) => ({ id: String(r.id), status: String(r.status), description: String(r.description) })),
      readMetadata: { source: "database", authority: "db-authoritative" },
    }
  } catch {
    // No database, no SQLite provider, or a schema older than these tables.
    return {
      schemaVersion: null,
      counts: { decisions: 0, requirements: 0, artifacts: 0 },
      recentDecisions: [],
      recentRequirements: [],
      readMetadata: { source: "projection", authority: "projection-fallback" },
    }
  } finally {
    db?.close()
  }
}
