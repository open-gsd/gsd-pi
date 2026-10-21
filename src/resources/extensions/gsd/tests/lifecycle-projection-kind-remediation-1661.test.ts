// Project/App: gsd-pi
// File Purpose: Remediation proof (#1661) that doctor detects and repairs lifecycle/*
// projection heads imported as kind "markdown" by pre-#1659 builds, unwedging closeout.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import type { DbAdapter } from "../db-adapter.ts";
import { checkLifecycleProjectionKinds } from "../doctor-engine-checks.ts";
import type { DoctorIssue } from "../doctor-types.ts";
import { legacyImportProjectionKind } from "../legacy-import-application-plan.ts";
import {
  MARKDOWN_PROJECTION_KIND,
  MILESTONE_LIFECYCLE_PROJECTION_KIND,
  SLICE_LIFECYCLE_PROJECTION_KIND,
  TASK_LIFECYCLE_PROJECTION_KIND,
  canonicalProjectionKind,
  lifecycleProjectionKind,
} from "../projection-identity.ts";
import {
  _getAdapter,
  closeDatabase,
  executeDomainOperation,
  findWrongKindLifecycleProjectionHeads,
  openDatabase,
  readDomainOperationFence,
} from "../gsd-db.ts";

const SLICE_KEY = "lifecycle/m001/s01";
const tempDirectories = new Set<string>();

afterEach(() => {
  closeDatabase();
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  tempDirectories.clear();
});

function db(): DbAdapter {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function openFreshDatabase(): void {
  const workspace = mkdtempSync(join(tmpdir(), "gsd-projection-kind-1661-"));
  tempDirectories.add(workspace);
  assert.equal(openDatabase(join(workspace, "gsd.db")), true);
}

function enqueueProjection(idempotencyKey: string, projectionKind: string): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "slice.complete",
    idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "agent",
    sourceTransport: "test",
    payload: { sliceKey: SLICE_KEY },
  }, () => ({
    events: [{
      eventType: "slice.completed",
      entityType: "slice",
      entityId: SLICE_KEY,
      payload: { closeout: true },
      destinations: ["projection"],
    }],
    projections: [{
      projectionKey: SLICE_KEY,
      projectionKind,
      rendererVersion: "1",
    }],
  }));
}

/** Seeds the durable pre-#1659 import signature: a markdown-kind lifecycle head. */
function seedPreFixMarkdownHead(): void {
  enqueueProjection("1661/pre-fix-import", MARKDOWN_PROJECTION_KIND);
}

function projectionChain(): Array<Record<string, unknown>> {
  return db().prepare(`
    SELECT projection_kind, supersedes_projection_work_id FROM workflow_projection_work
    WHERE projection_key = '${SLICE_KEY}'
    ORDER BY source_project_revision
  `).all() as Array<Record<string, unknown>>;
}

test("projection-identity is the single kind authority and the import mapping delegates to it (#1661)", () => {
  // legacyImportProjectionKind IS canonicalProjectionKind — a re-export, not a copy.
  assert.equal(legacyImportProjectionKind, canonicalProjectionKind);
  assert.equal(canonicalProjectionKind("lifecycle/m001"), MILESTONE_LIFECYCLE_PROJECTION_KIND);
  assert.equal(canonicalProjectionKind("lifecycle/m001/s01"), SLICE_LIFECYCLE_PROJECTION_KIND);
  assert.equal(canonicalProjectionKind("lifecycle/m001/s01/t01"), TASK_LIFECYCLE_PROJECTION_KIND);
  assert.equal(canonicalProjectionKind("planning/m001/s01"), MARKDOWN_PROJECTION_KIND);
  assert.equal(canonicalProjectionKind("legacy-import/abc"), MARKDOWN_PROJECTION_KIND);
  assert.equal(lifecycleProjectionKind(SLICE_KEY), SLICE_LIFECYCLE_PROJECTION_KIND);
});

test("a pre-fix markdown lifecycle head wedges canonical closeout and doctor reports it fixable (#1661)", () => {
  openFreshDatabase();
  seedPreFixMarkdownHead();

  // The wedge #1659 left behind: the canonical slice-lifecycle enqueue cannot
  // extend the markdown-kind chain.
  assert.throws(
    () => enqueueProjection("1661/wedged-closeout", SLICE_LIFECYCLE_PROJECTION_KIND),
    /projection work must extend the current logical target head/,
  );

  const heads = findWrongKindLifecycleProjectionHeads();
  assert.equal(heads.length, 1);
  assert.deepEqual(heads[0], {
    projectionKey: SLICE_KEY,
    projectionKind: MARKDOWN_PROJECTION_KIND,
    expectedKind: SLICE_LIFECYCLE_PROJECTION_KIND,
  });

  const issues: DoctorIssue[] = [];
  const fixesApplied: string[] = [];
  checkLifecycleProjectionKinds(issues, fixesApplied, false);
  assert.equal(fixesApplied.length, 0);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.code, "lifecycle_projection_wrong_kind");
  assert.equal(issues[0]?.severity, "error");
  assert.equal(issues[0]?.unitId, SLICE_KEY);
  assert.equal(issues[0]?.fixable, true);
  // The message must name the exact healing command.
  assert.match(issues[0]?.message ?? "", /gsd doctor --fix/);
});

test("doctor --fix rewrites the kind, restores the guard triggers, and closeout extends the chain (#1661)", () => {
  openFreshDatabase();
  seedPreFixMarkdownHead();

  const issues: DoctorIssue[] = [];
  const fixesApplied: string[] = [];
  checkLifecycleProjectionKinds(issues, fixesApplied, true);
  assert.equal(issues.length, 0);
  assert.equal(fixesApplied.length, 1);
  assert.match(fixesApplied[0] ?? "", /lifecycle\/m001\/s01/);
  assert.match(fixesApplied[0] ?? "", /markdown → slice-lifecycle/);

  // The chain now carries the canonical kind and nothing remains to detect.
  assert.equal(projectionChain()[0]?.["projection_kind"], SLICE_LIFECYCLE_PROJECTION_KIND);
  assert.equal(findWrongKindLifecycleProjectionHeads().length, 0);

  // The dropped UPDATE-guard triggers were recreated…
  const guardTriggers = db().prepare(`
    SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name IN (
      'trg_workflow_projection_identity_immutable',
      'trg_workflow_projection_current_head_update',
      'trg_workflow_projection_delivery_transition'
    )
  `).get() as { count: number };
  assert.equal(Number(guardTriggers.count), 3);
  // …and enforce again: kind is immutable once more.
  assert.throws(
    () => db().prepare(`
      UPDATE workflow_projection_work SET projection_kind = 'markdown'
      WHERE projection_key = '${SLICE_KEY}'
    `).run(),
    /invalid projection delivery transition|projection desired identity is immutable/,
  );

  // ACCEPTANCE (#1661): the wedge is actually gone — the canonical
  // slice-lifecycle enqueue for the repaired key SUCCEEDS and extends the head.
  enqueueProjection("1661/healed-closeout", SLICE_LIFECYCLE_PROJECTION_KIND);
  const chain = projectionChain();
  assert.equal(chain.length, 2);
  assert.equal(chain[0]?.["projection_kind"], SLICE_LIFECYCLE_PROJECTION_KIND);
  assert.equal(chain[1]?.["projection_kind"], SLICE_LIFECYCLE_PROJECTION_KIND);
  assert.notEqual(chain[1]?.["supersedes_projection_work_id"], null);
});
