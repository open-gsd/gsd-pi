/**
 * worktree-sync-milestones.test.ts — Regression tests for #1311 and #1678.
 *
 * Verifies that syncProjectRootToWorktree copies milestone artifacts
 * from the main repo's .gsd/ into the worktree's .gsd/ for the
 * specified milestone, and deletes gsd.db so it rebuilds from fresh state.
 *
 * Covers:
 *   - Milestone directory synced from main to worktree
 *   - Missing slices within a milestone are synced
 *   - gsd.db deleted in worktree after sync
 *   - No-op when paths are equal
 *   - No-op when milestoneId is null
 *   - Non-existent directories handled gracefully
 *   - syncGsdStateToWorktree syncs non-standard milestone dir names (#1547)
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  syncGsdStateToWorktree,
  syncProjectRootToWorktree,
} from '../auto-worktree-sync.ts';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';


function createBase(name: string): string {
  const base = mkdtempSync(join(tmpdir(), `gsd-wt-sync-${name}-`));
  mkdirSync(join(base, '.gsd', 'milestones'), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

describe('worktree-sync-milestones', async () => {

  // ─── 1. Milestone directory synced from main to worktree ──────────────
  console.log('\n=== 1. milestone directory synced from main to worktree ===');
  {
    const mainBase = createBase('main');
    const wtBase = createBase('wt');

    try {
      const m001Dir = join(mainBase, '.gsd', 'milestones', 'M001');
      mkdirSync(m001Dir, { recursive: true });
      writeFileSync(join(m001Dir, 'M001-CONTEXT.md'), '# M001\nContext.');
      writeFileSync(join(m001Dir, 'M001-ROADMAP.md'), '# Roadmap');

      // Worktree has no M001
      assert.ok(!existsSync(join(wtBase, '.gsd', 'milestones', 'M001')), 'M001 missing before sync');

      syncProjectRootToWorktree(mainBase, wtBase, 'M001');

      assert.ok(existsSync(join(wtBase, '.gsd', 'milestones', 'M001')), '#1311: M001 synced to worktree');
      assert.ok(existsSync(join(wtBase, '.gsd', 'milestones', 'M001', 'M001-CONTEXT.md')), 'M001 CONTEXT synced');
      assert.ok(existsSync(join(wtBase, '.gsd', 'milestones', 'M001', 'M001-ROADMAP.md')), 'M001 ROADMAP synced');
    } finally {
      cleanup(mainBase);
      cleanup(wtBase);
    }
  }

  // ─── 2. Missing slices synced ──────────────────────────────────────────
  console.log('\n=== 2. missing slices within milestone are synced ===');
  {
    const mainBase = createBase('main');
    const wtBase = createBase('wt');

    try {
      const m001Dir = join(mainBase, '.gsd', 'milestones', 'M001');
      mkdirSync(join(m001Dir, 'slices', 'S01'), { recursive: true });
      mkdirSync(join(m001Dir, 'slices', 'S02'), { recursive: true });
      writeFileSync(join(m001Dir, 'M001-ROADMAP.md'), '# Roadmap');
      writeFileSync(join(m001Dir, 'slices', 'S01', 'S01-PLAN.md'), '# S01 Plan');
      writeFileSync(join(m001Dir, 'slices', 'S02', 'S02-PLAN.md'), '# S02 Plan');

      // Worktree only has S01
      const wtM001Dir = join(wtBase, '.gsd', 'milestones', 'M001');
      mkdirSync(join(wtM001Dir, 'slices', 'S01'), { recursive: true });
      writeFileSync(join(wtM001Dir, 'slices', 'S01', 'S01-PLAN.md'), '# S01 Plan');

      syncProjectRootToWorktree(mainBase, wtBase, 'M001');

      assert.ok(existsSync(join(wtBase, '.gsd', 'milestones', 'M001', 'slices', 'S02')), '#1311: S02 synced');
      assert.ok(existsSync(join(wtBase, '.gsd', 'milestones', 'M001', 'slices', 'S02', 'S02-PLAN.md')), 'S02 PLAN synced');
    } finally {
      cleanup(mainBase);
      cleanup(wtBase);
    }
  }

  // ─── 3. empty gsd.db deleted in worktree after sync ────────────────────
  console.log('\n=== 3. empty gsd.db deleted in worktree after sync ===');
  {
    const mainBase = createBase('main');
    const wtBase = createBase('wt');

    try {
      const m001Dir = join(mainBase, '.gsd', 'milestones', 'M001');
      mkdirSync(m001Dir, { recursive: true });
      writeFileSync(join(m001Dir, 'M001-ROADMAP.md'), '# Roadmap');

      // Worktree has an empty (0-byte) gsd.db — stale/corrupt
      writeFileSync(join(wtBase, '.gsd', 'gsd.db'), '');
      assert.ok(existsSync(join(wtBase, '.gsd', 'gsd.db')), 'gsd.db exists before sync');

      syncProjectRootToWorktree(mainBase, wtBase, 'M001');

      assert.ok(!existsSync(join(wtBase, '.gsd', 'gsd.db')), '#853: empty gsd.db deleted after sync');
    } finally {
      cleanup(mainBase);
      cleanup(wtBase);
    }
  }

  // ─── 3b. non-empty gsd.db preserved in worktree after sync (#2815) ───
  console.log('\n=== 3b. non-empty gsd.db preserved in worktree after sync (#2815) ===');
  {
    const mainBase = createBase('main');
    const wtBase = createBase('wt');

    try {
      const m001Dir = join(mainBase, '.gsd', 'milestones', 'M001');
      mkdirSync(m001Dir, { recursive: true });
      writeFileSync(join(m001Dir, 'M001-ROADMAP.md'), '# Roadmap');

      // Worktree has a populated gsd.db (e.g. from gsd-migrate on respawn)
      writeFileSync(join(wtBase, '.gsd', 'gsd.db'), 'migrated-db-content');
      assert.ok(existsSync(join(wtBase, '.gsd', 'gsd.db')), 'gsd.db exists before sync');

      syncProjectRootToWorktree(mainBase, wtBase, 'M001');

      assert.ok(existsSync(join(wtBase, '.gsd', 'gsd.db')), '#2815: non-empty gsd.db preserved after sync');
    } finally {
      cleanup(mainBase);
      cleanup(wtBase);
    }
  }

  // ─── 3c. artifact file/dir collisions preserve existing worktree files ─
  console.log('\n=== 3c. artifact file/dir collisions preserve existing worktree files (#1157) ===');
  {
    const mainBase = createBase('main');
    const wtBase = createBase('wt');

    try {
      const mainSliceDir = join(mainBase, '.gsd', 'milestones', 'M001', 'slices', 'S01');
      mkdirSync(join(mainSliceDir, 'S01-SUMMARY.md'), { recursive: true });
      mkdirSync(join(mainSliceDir, 'S01-ASSESSMENT.md'), { recursive: true });

      const wtSliceDir = join(wtBase, '.gsd', 'milestones', 'M001', 'slices', 'S01');
      mkdirSync(wtSliceDir, { recursive: true });
      writeFileSync(join(wtSliceDir, 'S01-SUMMARY.md'), '# Valid summary\n');
      writeFileSync(join(wtSliceDir, 'S01-ASSESSMENT.md'), '---\nverdict: pass\n---\n# Valid assessment\n');

      syncProjectRootToWorktree(mainBase, wtBase, 'M001');

      const summaryPath = join(wtSliceDir, 'S01-SUMMARY.md');
      const assessmentPath = join(wtSliceDir, 'S01-ASSESSMENT.md');
      assert.ok(statSync(summaryPath).isFile(), 'existing SUMMARY.md stays a file');
      assert.ok(statSync(assessmentPath).isFile(), 'existing ASSESSMENT.md stays a file');
      assert.equal(readFileSync(summaryPath, 'utf-8'), '# Valid summary\n');
      assert.equal(readFileSync(assessmentPath, 'utf-8'), '---\nverdict: pass\n---\n# Valid assessment\n');
    } finally {
      cleanup(mainBase);
      cleanup(wtBase);
    }
  }

  // ─── 4. No-op when paths are equal ────────────────────────────────────
  console.log('\n=== 4. no-op when paths are equal ===');
  {
    const base = createBase('same');
    try {
      // Should not throw
      syncProjectRootToWorktree(base, base, 'M001');
      assert.ok(true, 'no crash when paths are equal');
    } finally {
      cleanup(base);
    }
  }

  // ─── 5. No-op when milestoneId is null ────────────────────────────────
  console.log('\n=== 5. no-op when milestoneId is null ===');
  {
    const mainBase = createBase('main');
    const wtBase = createBase('wt');
    try {
      syncProjectRootToWorktree(mainBase, wtBase, null);
      assert.ok(true, 'no crash when milestoneId is null');
    } finally {
      cleanup(mainBase);
      cleanup(wtBase);
    }
  }

  // ─── 6. Non-existent directories handled gracefully ───────────────────
  console.log('\n=== 6. non-existent directories → no-op ===');
  {
    syncProjectRootToWorktree('/tmp/does-not-exist-main', '/tmp/does-not-exist-wt', 'M001');
    assert.ok(true, 'no crash on missing directories');
  }

  // ─── 7. milestones/ directory created in worktree when missing ────────
  console.log('\n=== 7. milestones/ directory created in worktree when missing ===');
  {
    const mainBase = createBase('main');
    const wtBase = mkdtempSync(join(tmpdir(), 'gsd-wt-sync-wt-'));

    try {
      // Worktree has .gsd/ but NO milestones/ subdirectory
      mkdirSync(join(wtBase, '.gsd'), { recursive: true });

      // Main repo has M001
      const m001Dir = join(mainBase, '.gsd', 'milestones', 'M001');
      mkdirSync(m001Dir, { recursive: true });
      writeFileSync(join(m001Dir, 'M001-CONTEXT.md'), '# M001 Context');
      writeFileSync(join(m001Dir, 'M001-ROADMAP.md'), '# M001 Roadmap');

      assert.ok(!existsSync(join(wtBase, '.gsd', 'milestones')), 'milestones/ missing before sync');

      const result = syncGsdStateToWorktree(mainBase, wtBase);

      assert.ok(existsSync(join(wtBase, '.gsd', 'milestones')), 'milestones/ created in worktree');
      assert.ok(existsSync(join(wtBase, '.gsd', 'milestones', 'M001')), 'M001 synced to worktree');
      assert.ok(existsSync(join(wtBase, '.gsd', 'milestones', 'M001', 'M001-CONTEXT.md')), 'M001 CONTEXT synced');
      assert.ok(existsSync(join(wtBase, '.gsd', 'milestones', 'M001', 'M001-ROADMAP.md')), 'M001 ROADMAP synced');
      assert.ok(result.synced.length > 0, 'sync reported files');
    } finally {
      cleanup(mainBase);
      rmSync(wtBase, { recursive: true, force: true });
    }
  }

  // ─── 7b. flat-phase sync skips empty legacy milestones root ───────────
  console.log('\n=== 7b. flat-phase sync skips empty legacy milestones root ===');
  {
    const mainBase = mkdtempSync(join(tmpdir(), 'gsd-wt-sync-flat-main-'));
    const wtBase = mkdtempSync(join(tmpdir(), 'gsd-wt-sync-flat-wt-'));

    try {
      const phaseDir = join(mainBase, '.gsd', 'phases', '01-foundation');
      mkdirSync(phaseDir, { recursive: true });
      mkdirSync(join(mainBase, '.gsd', 'milestones'), { recursive: true });
      mkdirSync(join(wtBase, '.gsd'), { recursive: true });
      writeFileSync(join(phaseDir, '01-CONTEXT.md'), '# Foundation\n');

      syncGsdStateToWorktree(mainBase, wtBase);

      assert.ok(
        existsSync(join(wtBase, '.gsd', 'phases', '01-foundation', '01-CONTEXT.md')),
        'flat-phase artifact is synced to worktree',
      );
      assert.ok(
        !existsSync(join(wtBase, '.gsd', 'milestones')),
        'empty legacy milestones/ root is not recreated in worktree',
      );
    } finally {
      rmSync(mainBase, { recursive: true, force: true });
      rmSync(wtBase, { recursive: true, force: true });
    }
  }

  // ─── 7c. flat-phase sync skips metadata-only legacy milestone dirs ────
  console.log('\n=== 7c. flat-phase sync skips metadata-only legacy milestone dirs ===');
  {
    const mainBase = mkdtempSync(join(tmpdir(), 'gsd-wt-sync-flat-meta-main-'));
    const wtBase = mkdtempSync(join(tmpdir(), 'gsd-wt-sync-flat-meta-wt-'));

    try {
      const phaseDir = join(mainBase, '.gsd', 'phases', '01-foundation');
      const metaDir = join(mainBase, '.gsd', 'milestones', 'M001');
      mkdirSync(phaseDir, { recursive: true });
      mkdirSync(metaDir, { recursive: true });
      mkdirSync(join(wtBase, '.gsd'), { recursive: true });
      writeFileSync(join(phaseDir, '01-CONTEXT.md'), '# Foundation\n');
      writeFileSync(join(metaDir, 'M001-META.json'), '{"integrationBranch":"main"}\n');

      syncGsdStateToWorktree(mainBase, wtBase);

      assert.ok(
        existsSync(join(wtBase, '.gsd', 'phases', '01-foundation', '01-CONTEXT.md')),
        'flat-phase artifact is synced to worktree',
      );
      assert.ok(
        !existsSync(join(wtBase, '.gsd', 'milestones')),
        'metadata-only legacy milestones/ scaffold is not recreated in worktree',
      );
    } finally {
      rmSync(mainBase, { recursive: true, force: true });
      rmSync(wtBase, { recursive: true, force: true });
    }
  }

  // ─── 14. syncGsdStateToWorktree syncs non-standard milestone dir names (#1547) ──
  console.log('\n=== 14. syncGsdStateToWorktree syncs non-standard milestone dir names (#1547) ===');
  {
    const mainBase = createBase('main');
    const wtBase = createBase('wt');

    try {
      // Main has milestone dirs with non-standard names
      const customDir = join(mainBase, '.gsd', 'milestones', 'sprint-alpha');
      mkdirSync(customDir, { recursive: true });
      writeFileSync(join(customDir, 'CONTEXT.md'), '# Sprint Alpha Context');

      const suffixDir = join(mainBase, '.gsd', 'milestones', 'M001-abc123');
      mkdirSync(suffixDir, { recursive: true });
      writeFileSync(join(suffixDir, 'M001-abc123-CONTEXT.md'), '# M001 Context');

      assert.ok(!existsSync(join(wtBase, '.gsd', 'milestones', 'sprint-alpha')), 'sprint-alpha missing before sync');
      assert.ok(!existsSync(join(wtBase, '.gsd', 'milestones', 'M001-abc123')), 'M001-abc123 missing before sync');

      const result = syncGsdStateToWorktree(mainBase, wtBase);

      assert.ok(
        existsSync(join(wtBase, '.gsd', 'milestones', 'sprint-alpha', 'CONTEXT.md')),
        '#1547: non-standard milestone dir "sprint-alpha" synced to worktree',
      );
      assert.ok(
        existsSync(join(wtBase, '.gsd', 'milestones', 'M001-abc123', 'M001-abc123-CONTEXT.md')),
        '#1547: suffixed milestone dir "M001-abc123" synced to worktree',
      );
      assert.ok(result.synced.length > 0, 'sync reported files');
    } finally {
      cleanup(mainBase);
      cleanup(wtBase);
    }
  }

  // ─── 16. pre-dispatch sync projects missing future milestone top-level artifacts (#5687) ──
  console.log('\n=== 16. pre-dispatch sync projects missing future milestone top-level artifacts (#5687) ===');
  {
    const mainBase = createBase('main');
    const wtBase = createBase('wt');

    try {
      // Canonical .gsd has M003 context draft that complete-milestone needs.
      const mainM003 = join(mainBase, '.gsd', 'milestones', 'M003');
      mkdirSync(mainM003, { recursive: true });
      writeFileSync(join(mainM003, 'M003-CONTEXT-DRAFT.md'), '# M003 Context Draft');
      writeFileSync(join(mainM003, 'M003-ROADMAP.md'), '# M003 Roadmap');

      // Worktree only has skeletal roadmap for M003.
      const wtM003 = join(wtBase, '.gsd', 'milestones', 'M003');
      mkdirSync(wtM003, { recursive: true });
      writeFileSync(join(wtM003, 'M003-ROADMAP.md'), '# WT Roadmap');

      // Worktree has current milestone file that must not be overwritten.
      const mainM002 = join(mainBase, '.gsd', 'milestones', 'M002');
      mkdirSync(mainM002, { recursive: true });
      writeFileSync(join(mainM002, 'M002-ROADMAP.md'), '# Main M002 Roadmap');
      const wtM002 = join(wtBase, '.gsd', 'milestones', 'M002');
      mkdirSync(wtM002, { recursive: true });
      writeFileSync(join(wtM002, 'M002-ROADMAP.md'), '# Worktree M002 Roadmap');

      // Canonical .gsd has M004 with no corresponding worktree directory at all.
      const mainM004 = join(mainBase, '.gsd', 'milestones', 'M004');
      mkdirSync(mainM004, { recursive: true });
      writeFileSync(join(mainM004, 'M004-CONTEXT-DRAFT.md'), '# M004 Context Draft');

      syncProjectRootToWorktree(mainBase, wtBase, 'M002');

      assert.ok(
        existsSync(join(wtBase, '.gsd', 'milestones', 'M003', 'M003-CONTEXT-DRAFT.md')),
        '#5687: future milestone context draft projected into worktree',
      );
      assert.equal(
        readFileSync(join(wtBase, '.gsd', 'milestones', 'M003', 'M003-ROADMAP.md'), 'utf-8'),
        '# WT Roadmap',
        '#5687: existing worktree-local M003 file is not overwritten',
      );
      assert.equal(
        readFileSync(join(wtBase, '.gsd', 'milestones', 'M002', 'M002-ROADMAP.md'), 'utf-8'),
        '# Worktree M002 Roadmap',
        '#5687: existing worktree-local files are not overwritten',
      );
      assert.ok(
        existsSync(join(wtBase, '.gsd', 'milestones', 'M004', 'M004-CONTEXT-DRAFT.md')),
        '#5687: future milestone context draft projected into worktree when no wt dir existed',
      );
    } finally {
      cleanup(mainBase);
      cleanup(wtBase);
    }
  }

  // ─── 17. pre-dispatch sync creates absent worktree milestone dir before projecting artifacts (#5687) ──
  console.log('\n=== 17. pre-dispatch sync creates absent worktree milestone dir before projecting artifacts (#5687) ===');
  {
    const mainBase = createBase('main');
    const wtBase = createBase('wt');

    try {
      // Canonical .gsd has a future milestone M004 with a context draft.
      const mainM004 = join(mainBase, '.gsd', 'milestones', 'M004');
      mkdirSync(mainM004, { recursive: true });
      writeFileSync(join(mainM004, 'M004-CONTEXT-DRAFT.md'), '# M004 Context Draft');

      // Active milestone M002 exists in both main and worktree.
      const mainM002 = join(mainBase, '.gsd', 'milestones', 'M002');
      mkdirSync(mainM002, { recursive: true });
      writeFileSync(join(mainM002, 'M002-ROADMAP.md'), '# Main M002 Roadmap');
      const wtM002 = join(wtBase, '.gsd', 'milestones', 'M002');
      mkdirSync(wtM002, { recursive: true });
      writeFileSync(join(wtM002, 'M002-ROADMAP.md'), '# Worktree M002 Roadmap');

      // M004 does NOT exist in the worktree at all before sync.
      assert.ok(
        !existsSync(join(wtBase, '.gsd', 'milestones', 'M004')),
        '#5687: worktree M004 dir must not exist before sync',
      );

      syncProjectRootToWorktree(mainBase, wtBase, 'M002');

      assert.ok(
        existsSync(join(wtBase, '.gsd', 'milestones', 'M004', 'M004-CONTEXT-DRAFT.md')),
        '#5687: context draft projected into worktree even when milestone dir was absent',
      );
    } finally {
      cleanup(mainBase);
      cleanup(wtBase);
    }
  }
});
