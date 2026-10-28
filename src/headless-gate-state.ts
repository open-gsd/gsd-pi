// Project/App: gsd-pi + wrapper-side read of the durable discussion write gate.
//
// A `gsd headless` run that ends parked on an unanswered discussion write gate
// never finished its work, but nothing in the wrapper looked at the gate state
// the RPC child left behind — the run reported complete/exit 0 over a parked
// discussion (#2987). This module reads the durable `write_gate_state` rows of
// the project database the same way headless-milestone-readiness.ts reads
// milestone rows: open the existing database, read, close.
//
// A database that exists but cannot be opened is NOT reported as "no gate":
// the readError field names the failure so the caller can say the gate state
// was unverifiable instead of silently claiming the run was complete.

import {
  closeWorkflowDatabase,
  openExistingWorkflowDatabase,
} from './resources/extensions/gsd/db-workspace.js'
import { listWriteGateRows } from './resources/extensions/gsd/db/writers/write-gate.js'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface PendingWriteGateRead {
  /** The pending gate id, or null when no gate is pending (or unreadable). */
  gateId: string | null
  /** Set when the database exists but could not be opened or queried. */
  readError: string | null
}

/**
 * Read the discussion gate currently pending in the project database for
 * `basePath`. A missing database reads as "no gate" — a run that never
 * touched a gate has nothing to report.
 */
export function readPendingWriteGateState(basePath: string): PendingWriteGateRead {
  let opened: { ok: boolean; reason: string; error?: Error }
  try {
    opened = openExistingWorkflowDatabase(basePath)
  } catch (err) {
    return { gateId: null, readError: `project database could not be opened: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (!opened.ok) {
    if (opened.reason === 'missing-database' || opened.reason === 'missing-gsd-dir') {
      // existsSync also returns false on permission errors (EACCES on an
      // ancestor), so "missing" needs one stat to stay honest: a .gsd
      // directory that is there while the database path is not accessible is
      // an access failure, not absence (#2987 review r2).
      const dbPath = join(basePath, '.gsd', 'gsd.db')
      if (existsSync(join(basePath, '.gsd'))) {
        try {
          statSync(dbPath)
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code
          if (code === 'EACCES' || code === 'EPERM') {
            return { gateId: null, readError: `project database is not accessible (${code})` }
          }
        }
      }
      return { gateId: null, readError: null }
    }
    const detail = opened.error ? `${opened.reason}: ${opened.error.message}` : opened.reason
    return { gateId: null, readError: `project database could not be opened (${detail})` }
  }
  try {
    const pending = listWriteGateRows().find((row) => row.gate_kind === 'pending')
    return { gateId: pending?.gate_id ?? null, readError: null }
  } catch (err) {
    return { gateId: null, readError: `write-gate rows could not be read: ${err instanceof Error ? err.message : String(err)}` }
  } finally {
    try {
      closeWorkflowDatabase()
    } catch {
      // Closing a read that already failed must not mask the first error.
    }
  }
}
