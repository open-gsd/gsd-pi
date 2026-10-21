// Project/App: gsd-pi
// File Purpose: Repairs pre-#1659 legacy imports whose lifecycle/* projection
// heads were enqueued with kind "markdown" (#1661).
//
// trg_workflow_projection_lineage forbids extending a (project, key) chain
// across a kind change, forbids starting a second chain for a key, and the
// identity/delete triggers make kind immutable and rows undeletable — so a
// wrong-kind head has no in-band repair path. SQLite has no trigger-disable
// pragma either, so this writer transactionally drops the UPDATE-guard
// triggers, rewrites the wrong kinds to the canonical lifecycle kinds, and
// recreates the triggers verbatim via the owning schema module.

import { getDbOrNull, transaction } from "../engine.js";
import { createProjectionImportKernelCloseoutFoundationSchemaV35 } from "../../db-projection-import-kernel-closeout-foundation-schema.js";
import {
  LIFECYCLE_PROJECTION_KEY_PREFIX,
  lifecycleProjectionKind,
} from "../../projection-identity.js";

export interface WrongKindLifecycleProjectionHead {
  projectionKey: string;
  projectionKind: string;
  expectedKind: string;
}

/** The UPDATE guards that must yield while kinds are being rewritten. */
const PROJECTION_UPDATE_GUARD_TRIGGERS = [
  "trg_workflow_projection_identity_immutable",
  "trg_workflow_projection_current_head_update",
  "trg_workflow_projection_delivery_transition",
] as const;

function hasProjectionWorkTable(db: NonNullable<ReturnType<typeof getDbOrNull>>): boolean {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workflow_projection_work'")
    .get() !== undefined;
}

/**
 * Current (unsuperseded) lifecycle/* projection heads whose kind differs from
 * the canonical lifecycle kind — the durable signature of a pre-#1659 import.
 */
export function findWrongKindLifecycleProjectionHeads(): WrongKindLifecycleProjectionHead[] {
  const db = getDbOrNull();
  if (!db || !hasProjectionWorkTable(db)) return [];
  const rows = db
    .prepare(`
      SELECT head.projection_key AS projection_key, head.projection_kind AS projection_kind
      FROM workflow_projection_work head
      WHERE head.projection_key LIKE :prefix || '%'
        AND NOT EXISTS (
          SELECT 1 FROM workflow_projection_work successor
          WHERE successor.supersedes_projection_work_id = head.projection_work_id
        )
      ORDER BY head.projection_key
    `)
    .all({ ":prefix": LIFECYCLE_PROJECTION_KEY_PREFIX }) as Array<{
      projection_key: string;
      projection_kind: string;
    }>;
  return rows
    .map((row) => ({
      projectionKey: row.projection_key,
      projectionKind: row.projection_kind,
      expectedKind: lifecycleProjectionKind(row.projection_key),
    }))
    .filter((head) => head.projectionKind !== head.expectedKind);
}

/**
 * Rewrites every wrong-kind lifecycle/* projection row (whole chains, not just
 * heads, so a chain never mixes kinds) to its canonical kind and restores the
 * guard triggers. Returns the repaired projection keys.
 */
export function repairWrongKindLifecycleProjections(): WrongKindLifecycleProjectionHead[] {
  const heads = findWrongKindLifecycleProjectionHeads();
  if (heads.length === 0) return [];
  const db = getDbOrNull();
  if (!db) return [];
  transaction(() => {
    for (const trigger of PROJECTION_UPDATE_GUARD_TRIGGERS) {
      db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    }
    const rewrite = db.prepare(`
      UPDATE workflow_projection_work
      SET projection_kind = :kind
      WHERE projection_key = :key AND projection_kind != :kind
    `);
    for (const head of heads) {
      rewrite.run({ ":key": head.projectionKey, ":kind": head.expectedKind });
    }
    // Recreate the dropped triggers byte-identical to the schema authority
    // (everything else in the module is CREATE ... IF NOT EXISTS and no-ops).
    createProjectionImportKernelCloseoutFoundationSchemaV35(db);
  });
  return heads;
}
