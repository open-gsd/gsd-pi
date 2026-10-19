/**
 * Regression test for #3671 — isGhostMilestone detects phantom queued rows
 *
 * gsd_milestone_generate_id inserts a DB row with status "queued" as a side
 * effect. If the milestone is never planned, isGhostMilestone previously
 * returned false for any milestone with a DB row, blocking the state machine.
 *
 * A "queued" DB row is a ghost until the database holds planning content for
 * it: a saved CONTEXT or CONTEXT-DRAFT row, or a slice row. A projection file
 * on disk is not content.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDatabase, insertArtifact, insertMilestone, insertSlice, openDatabase } from '../gsd-db.ts';
import { clearPathCache } from '../paths.ts';
import { isGhostMilestone } from '../state.ts';

function saveMilestoneArtifact(milestoneId: string, artifactType: string): void {
  insertArtifact({
    path: `milestones/${milestoneId}/${milestoneId}-${artifactType}.md`,
    artifact_type: artifactType,
    milestone_id: milestoneId,
    slice_id: null,
    task_id: null,
    full_content: `# ${artifactType}\n`,
  });
}

describe('isGhostMilestone phantom queued detection (#3671)', () => {
  test('queued DB row is a ghost until the database holds planning content', (t) => {
    const base = mkdtempSync(join(tmpdir(), 'gsd-phantom-ghost-'));
    t.after(() => {
      closeDatabase();
      rmSync(base, { recursive: true, force: true });
    });
    openDatabase(':memory:');
    for (const id of ['M001', 'M002', 'M003']) {
      insertMilestone({ id, title: 'Reserved only', status: 'queued' });
      mkdirSync(join(base, '.gsd', 'milestones', id), { recursive: true });
    }
    assert.equal(isGhostMilestone(base, 'M001'), true);

    // Projection files with no rows are not content.
    for (const suffix of ['CONTEXT', 'ROADMAP', 'SUMMARY']) {
      writeFileSync(join(base, '.gsd', 'milestones', 'M001', `M001-${suffix}.md`), `# ${suffix}\n`);
    }
    clearPathCache();
    assert.equal(isGhostMilestone(base, 'M001'), true);

    saveMilestoneArtifact('M001', 'CONTEXT');
    assert.equal(isGhostMilestone(base, 'M001'), false);

    saveMilestoneArtifact('M002', 'CONTEXT-DRAFT');
    assert.equal(isGhostMilestone(base, 'M002'), false);

    insertSlice({ id: 'S01', milestoneId: 'M003', title: 'Planned slice' });
    assert.equal(isGhostMilestone(base, 'M003'), false);
  });
});
