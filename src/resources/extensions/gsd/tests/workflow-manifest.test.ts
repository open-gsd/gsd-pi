// GSD Extension — workflow-manifest unit tests
// Tests writeManifest, readManifest, snapshotState, bootstrapFromManifest.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  openDatabase,
  closeDatabase,
  insertRequirement,
  insertArtifact,
  insertMilestone,
  insertSlice,
  insertTask,
  insertMemoryRow,
  insertDecision,
  insertAssessment,
  insertGateRow,
  insertReplanHistory,
  recordMilestoneCommitAttribution,
  saveGateResult,
  _getAdapter,
} from '../gsd-db.ts';
import {
  writeManifest,
  flushManifest,
  readManifest,
  snapshotState,
  bootstrapFromManifest,
} from '../workflow-manifest.ts';
import { getAllDecisionsFromMemories } from '../context-store.ts';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-manifest-'));
}

function tempDbPath(base: string): string {
  return path.join(base, 'test.db');
}

function cleanupDir(dirPath: string): void {
  try { fs.rmSync(dirPath, { recursive: true, force: true }); } catch { /* best effort */ }
}

async function writeManifestAndFlush(base: string): Promise<void> {
  writeManifest(base);
  await flushManifest(base);
}

function insertMemoryBackedDecision(
  id: string,
  structuredOverrides: Readonly<Record<string, unknown>> = {},
): void {
  const now = '2026-01-01T00:00:00.000Z';
  insertMemoryRow({
    id: `MEM-${id}`,
    category: 'architecture',
    content: `Decision ${id} content`,
    confidence: 0.85,
    sourceUnitType: null,
    sourceUnitId: null,
    createdAt: now,
    updatedAt: now,
    scope: 'project',
    tags: [],
    structuredFields: {
      sourceDecisionId: id,
      when_context: 'M001',
      scope: 'architecture',
      decision: `Decision ${id}`,
      choice: `Choice ${id}`,
      rationale: `Rationale ${id}`,
      made_by: 'agent',
      revisable: 'Yes',
      superseded_by: null,
      ...structuredOverrides,
    },
  });
}

// ─── readManifest: no file ────────────────────────────────────────────────

test('workflow-manifest: readManifest returns null when file does not exist', () => {
  const base = tempDir();
  try {
    const result = readManifest(base);
    assert.strictEqual(result, null);
  } finally {
    cleanupDir(base);
  }
});

// ─── writeManifest + readManifest round-trip ─────────────────────────────

test('workflow-manifest: writeManifest creates state-manifest.json with version 1 after flush', async () => {
  const base = tempDir();
  openDatabase(tempDbPath(base));
  try {
    writeManifest(base);
    const manifestPath = path.join(base, '.gsd', 'state-manifest.json');
    assert.equal(fs.existsSync(manifestPath), false, 'writeManifest should not synchronously write state-manifest.json');
    await flushManifest(base);
    assert.ok(fs.existsSync(manifestPath), 'state-manifest.json should exist');
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    assert.strictEqual(raw.version, 1);
  } finally {
    closeDatabase();
    cleanupDir(base);
  }
});

test('workflow-manifest: readManifest parses manifest written by writeManifest', async () => {
  const base = tempDir();
  openDatabase(tempDbPath(base));
  try {
    await writeManifestAndFlush(base);
    const manifest = readManifest(base);
    assert.ok(manifest !== null);
    assert.strictEqual(manifest!.version, 1);
    assert.ok(typeof manifest!.exported_at === 'string');
    assert.ok(Array.isArray(manifest!.milestones));
    assert.ok(Array.isArray(manifest!.slices));
    assert.ok(Array.isArray(manifest!.tasks));
    assert.ok(Array.isArray(manifest!.decisions));
    assert.ok(Array.isArray(manifest!.requirements));
    assert.ok(Array.isArray(manifest!.artifacts));
    assert.ok(Array.isArray(manifest!.replan_history));
    assert.ok(Array.isArray(manifest!.assessments));
    assert.ok(Array.isArray(manifest!.quality_gates));
    assert.ok(Array.isArray(manifest!.milestone_commit_attributions));
    assert.ok(Array.isArray(manifest!.verification_evidence));
  } finally {
    closeDatabase();
    cleanupDir(base);
  }
});

test('workflow-manifest: flushManifest writes the latest queued payload', async () => {
  const base = tempDir();
  openDatabase(tempDbPath(base));
  try {
    insertMilestone({ id: 'M001', title: 'First Milestone' });
    writeManifest(base);
    insertMilestone({ id: 'M002', title: 'Latest Milestone' });
    writeManifest(base);

    await flushManifest(base);

    const manifest = readManifest(base);
    assert.ok(manifest?.milestones.some((m) => m.id === 'M002'), 'latest queued write should be durable');
  } finally {
    closeDatabase();
    cleanupDir(base);
  }
});

// ─── snapshotState: captures DB rows ─────────────────────────────────────

test('workflow-manifest: snapshotState includes inserted milestone', () => {
  const base = tempDir();
  openDatabase(tempDbPath(base));
  try {
    insertMilestone({ id: 'M001', title: 'Auth Milestone' });
    const snap = snapshotState();
    assert.strictEqual(snap.version, 1);
    const m = snap.milestones.find((r) => r.id === 'M001');
    assert.ok(m !== undefined, 'M001 should appear in snapshot');
    assert.strictEqual(m!.title, 'Auth Milestone');
  } finally {
    closeDatabase();
    cleanupDir(base);
  }
});

test('workflow-manifest: snapshotState captures tasks', () => {
  const base = tempDir();
  openDatabase(tempDbPath(base));
  try {
    insertMilestone({ id: 'M001' });
    insertSlice({ id: 'S01', milestoneId: 'M001', planning: { targetRepositories: ['project', 'frontend'] } });
    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'Do thing', status: 'complete', planning: { targetRepositories: ['backend'] } });
    const snap = snapshotState();
    const s = snap.slices.find((r) => r.id === 'S01');
    assert.deepStrictEqual(s?.target_repositories, ['project', 'frontend']);
    const t = snap.tasks.find((r) => r.id === 'T01');
    assert.ok(t !== undefined, 'T01 should appear in snapshot');
    assert.strictEqual(t!.status, 'complete');
    assert.deepStrictEqual(t!.target_repositories, ['backend']);
  } finally {
    closeDatabase();
    cleanupDir(base);
  }
});

test('workflow-manifest: snapshotState captures memory-backed decisions', () => {
  const base = tempDir();
  openDatabase(tempDbPath(base));
  try {
    insertMemoryBackedDecision('D900');

    const snap = snapshotState();
    const decision = snap.decisions.find((r) => r.id === 'D900');

    assert.ok(decision !== undefined, 'D900 should appear in manifest decisions');
    assert.strictEqual(decision!.decision, 'Decision D900');
    assert.strictEqual(decision!.choice, 'Choice D900');
    assert.strictEqual(decision!.rationale, 'Rationale D900');
  } finally {
    closeDatabase();
    cleanupDir(base);
  }
});

test('workflow-manifest: a canonical tombstone suppresses its legacy decision', () => {
  const base = tempDir();
  openDatabase(tempDbPath(base));
  try {
    insertDecision({
      id: 'D902',
      when_context: 'During import',
      scope: 'project',
      decision: 'Retire compatibility decision',
      choice: 'Legacy',
      rationale: 'Stale compatibility row',
      revisable: 'yes',
      made_by: 'agent',
      source: 'discussion',
      superseded_by: null,
    });
    insertMemoryBackedDecision('D902', { deleted: true });

    assert.equal(snapshotState().decisions.some((decision) => decision.id === 'D902'), false);
  } finally {
    closeDatabase();
    cleanupDir(base);
  }
});

test('workflow-manifest: malformed decision tombstone authority fails loud', () => {
  const base = tempDir();
  openDatabase(tempDbPath(base));
  try {
    _getAdapter()!.prepare(`INSERT INTO memories (
      id, category, content, confidence, created_at, updated_at, scope, tags, structured_fields
    ) VALUES (
      'memory-malformed', 'architecture', 'malformed', 0.85,
      '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z',
      'project', '[]', '{"sourceDecisionId":"D903"'
    )`).run();

    assert.throws(() => snapshotState(), /^Error: decision memory structured fields contain invalid JSON$/);
  } finally {
    closeDatabase();
    cleanupDir(base);
  }
});

test('workflow-manifest: bootstrapFromManifest restores extended correctness rows', async () => {
  const base = tempDir();
  openDatabase(tempDbPath(base));
  try {
    insertRequirement({
      id: 'R100',
      class: 'functional',
      status: 'active',
      description: 'Persist requirements',
      why: 'Recovery needs requirements',
      source: 'test',
      primary_owner: 'S01',
      supporting_slices: 'S00',
      validation: 'manifest round-trip',
      notes: 'important',
      full_content: 'Full requirement content',
      superseded_by: null,
    });
    insertArtifact({
      path: '.gsd/milestones/M001/M001-VALIDATION.md',
      artifact_type: 'VALIDATION',
      milestone_id: 'M001',
      slice_id: null,
      task_id: null,
      full_content: '# Validation\n\nPASS',
    });
    insertArtifact({
      path: 'milestones/M001/slices/S01/S01-ASSESSMENT.md',
      artifact_type: 'ASSESSMENT',
      milestone_id: 'M001',
      slice_id: 'S01',
      task_id: null,
      full_content: '# Assessment\n\nPASS',
    });
    insertMilestone({ id: 'M001', title: 'Tracked Milestone' });
    insertSlice({ id: 'S00', milestoneId: 'M001', title: 'Dependency Slice' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Dependent Slice', depends: ['S00'] });
    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'Tracked Task' });
    insertAssessment({
      path: '.gsd/milestones/M001/slices/S01/S01-ASSESSMENT.md',
      milestoneId: 'M001',
      sliceId: 'S01',
      taskId: null,
      status: 'pass',
      scope: 'run-uat',
      fullContent: '# UAT\n\nPASS',
    });
    insertReplanHistory({
      milestoneId: 'M001',
      sliceId: 'S01',
      taskId: 'T01',
      summary: 'Replan preserved',
      previousArtifactPath: 'old.md',
      replacementArtifactPath: 'new.md',
    });
    insertGateRow({ milestoneId: 'M001', sliceId: 'S01', gateId: 'Q3', scope: 'slice' });
    saveGateResult({
      milestoneId: 'M001',
      sliceId: 'S01',
      gateId: 'Q3',
      verdict: 'pass',
      rationale: 'Gate passed',
      findings: 'No findings',
    });
    recordMilestoneCommitAttribution({
      commitSha: 'abc123',
      milestoneId: 'M001',
      sliceId: 'S01',
      taskId: 'T01',
      source: 'recorded',
      confidence: 0.95,
      files: ['src/example.ts'],
      createdAt: '2026-06-05T00:00:00.000Z',
    });

    await writeManifestAndFlush(base);
    closeDatabase();

    const newDbPath = path.join(base, 'new.db');
    openDatabase(newDbPath);
    const restored = bootstrapFromManifest(base);
    assert.strictEqual(restored, true);

    const snap = snapshotState();
    assert.strictEqual(snap.requirements?.find((r) => r.id === 'R100')?.full_content, 'Full requirement content');
    const artifact = snap.artifacts?.find((r) => r.path === '.gsd/milestones/M001/M001-VALIDATION.md');
    assert.strictEqual(artifact?.full_content, '# Validation\n\nPASS');
    assert.ok(artifact?.content_hash, 'artifact content_hash should round-trip through manifest restore');
    assert.strictEqual(
      fs.readFileSync(path.join(base, '.gsd', 'milestones', 'M001', 'M001-VALIDATION.md'), 'utf-8'),
      '# Validation\n\nPASS',
    );
    assert.strictEqual(
      fs.readFileSync(path.join(base, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'S01-ASSESSMENT.md'), 'utf-8'),
      '# Assessment\n\nPASS',
    );
    assert.strictEqual(snap.assessments?.find((r) => r.scope === 'run-uat')?.status, 'pass');
    assert.strictEqual(snap.replan_history?.find((r) => r.summary === 'Replan preserved')?.replacement_artifact_path, 'new.md');
    assert.strictEqual(snap.quality_gates?.find((r) => r.gate_id === 'Q3')?.rationale, 'Gate passed');
    assert.strictEqual(snap.milestone_commit_attributions?.find((r) => r.commit_sha === 'abc123')?.files_json, '["src/example.ts"]');

    const dep = _getAdapter()!.prepare(
      'SELECT depends_on_slice_id FROM slice_dependencies WHERE milestone_id = ? AND slice_id = ?',
    ).get('M001', 'S01') as Record<string, unknown> | undefined;
    assert.strictEqual(dep?.['depends_on_slice_id'], 'S00');
  } finally {
    closeDatabase();
    cleanupDir(base);
  }
});

// ─── bootstrapFromManifest ────────────────────────────────────────────────

test('workflow-manifest: bootstrapFromManifest returns false when no manifest file', () => {
  const base = tempDir();
  openDatabase(tempDbPath(base));
  try {
    const result = bootstrapFromManifest(base);
    assert.strictEqual(result, false);
  } finally {
    closeDatabase();
    cleanupDir(base);
  }
});

test('workflow-manifest: bootstrapFromManifest restores DB from manifest (round-trip)', async () => {
  const base = tempDir();
  openDatabase(tempDbPath(base));
  try {
    // Insert data and write manifest
    insertMilestone({ id: 'M001', title: 'Restored Milestone' });
    insertSlice({
      id: 'S01',
      milestoneId: 'M001',
      title: 'Restored Slice',
      planning: { targetRepositories: ['project'] },
    });
    insertTask({
      id: 'T01',
      sliceId: 'S01',
      milestoneId: 'M001',
      title: 'Restored Task',
      status: 'complete',
      planning: { fullPlanMd: '# Full Task Plan\n\nKeep this body.', targetRepositories: ['project'] },
    });
    await writeManifestAndFlush(base);
    closeDatabase();

    // Open a fresh DB and bootstrap from manifest
    const newDbPath = path.join(base, 'new.db');
    openDatabase(newDbPath);
    const result = bootstrapFromManifest(base);
    assert.strictEqual(result, true, 'bootstrapFromManifest should return true');

    // Verify restored state
    const snap = snapshotState();
    const m = snap.milestones.find((r) => r.id === 'M001');
    assert.ok(m !== undefined, 'M001 should be restored');
    assert.strictEqual(m!.title, 'Restored Milestone');

    const s = snap.slices.find((r) => r.id === 'S01');
    assert.ok(s !== undefined, 'S01 should be restored');
    assert.deepEqual(s!.target_repositories, ['project']);

    const t = snap.tasks.find((r) => r.id === 'T01');
    assert.ok(t !== undefined, 'T01 should be restored');
    assert.strictEqual(t!.status, 'complete');
    assert.strictEqual(t!.full_plan_md, '# Full Task Plan\n\nKeep this body.');
    assert.deepEqual(t!.target_repositories, ['project']);
  } finally {
    closeDatabase();
    cleanupDir(base);
  }
});

test('workflow-manifest: bootstrapFromManifest preserves target_repositories', async () => {
  const base = tempDir();
  openDatabase(tempDbPath(base));
  try {
    insertMilestone({ id: 'M001', title: 'Restored Milestone' });
    insertSlice({ id: 'S01', milestoneId: 'M001', planning: { targetRepositories: ['frontend'] } });
    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', planning: { targetRepositories: ['backend'] } });
    await writeManifestAndFlush(base);
    closeDatabase();

    const newDbPath = path.join(base, 'new.db');
    openDatabase(newDbPath);
    const restored = bootstrapFromManifest(base);
    assert.strictEqual(restored, true);

    const snap = snapshotState();
    assert.deepStrictEqual(snap.slices.find((r) => r.id === 'S01')?.target_repositories, ['frontend']);
    assert.deepStrictEqual(snap.tasks.find((r) => r.id === 'T01')?.target_repositories, ['backend']);
  } finally {
    closeDatabase();
    cleanupDir(base);
  }
});

test('workflow-manifest: bootstrapFromManifest does not truncate projections when artifact content is empty', async () => {
  const base = tempDir();
  openDatabase(tempDbPath(base));
  try {
    insertMilestone({ id: 'M001', title: 'Projection Milestone' });
    insertArtifact({
      path: '.gsd/milestones/M001/M001-PLAN.md',
      artifact_type: 'PLAN',
      milestone_id: 'M001',
      slice_id: null,
      task_id: null,
      full_content: '# Manifest Plan',
    });
    insertArtifact({
      path: '.gsd/milestones/M001/M001-VALIDATION.md',
      artifact_type: 'VALIDATION',
      milestone_id: 'M001',
      slice_id: null,
      task_id: null,
      full_content: '# Manifest Validation',
    });
    await writeManifestAndFlush(base);

    const planPath = path.join(base, '.gsd', 'milestones', 'M001', 'M001-PLAN.md');
    const validationPath = path.join(base, '.gsd', 'milestones', 'M001', 'M001-VALIDATION.md');
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, '# Existing Plan\n\nKeep this.');
    fs.writeFileSync(validationPath, '# Existing Validation\n\nKeep this.');

    const manifestPath = path.join(base, '.gsd', 'state-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    const artifacts = manifest['artifacts'] as Array<Record<string, unknown>>;
    const emptyArtifact = artifacts.find((r) => r['path'] === '.gsd/milestones/M001/M001-PLAN.md');
    const absentArtifact = artifacts.find((r) => r['path'] === '.gsd/milestones/M001/M001-VALIDATION.md');
    assert.ok(emptyArtifact !== undefined);
    assert.ok(absentArtifact !== undefined);
    emptyArtifact['full_content'] = '';
    delete absentArtifact['full_content'];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    closeDatabase();

    const newDbPath = path.join(base, 'new.db');
    openDatabase(newDbPath);
    const restored = bootstrapFromManifest(base);
    assert.strictEqual(restored, true);

    assert.strictEqual(fs.readFileSync(planPath, 'utf-8'), '# Existing Plan\n\nKeep this.');
    assert.strictEqual(fs.readFileSync(validationPath, 'utf-8'), '# Existing Validation\n\nKeep this.');
  } finally {
    closeDatabase();
    cleanupDir(base);
  }
});

test('workflow-manifest: bootstrapFromManifest preserves optional rows from old manifests', async () => {
  const base = tempDir();
  openDatabase(tempDbPath(base));
  try {
    insertMilestone({ id: 'M001', title: 'Old Manifest Milestone' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Old Manifest Slice' });
    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'Old Manifest Task' });
    await writeManifestAndFlush(base);

    const manifestPath = path.join(base, '.gsd', 'state-manifest.json');
    const oldManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    delete oldManifest['replan_history'];
    delete oldManifest['assessments'];
    delete oldManifest['quality_gates'];
    delete oldManifest['milestone_commit_attributions'];
    fs.writeFileSync(manifestPath, JSON.stringify(oldManifest, null, 2));
    closeDatabase();

    const newDbPath = path.join(base, 'new.db');
    openDatabase(newDbPath);
    insertMilestone({ id: 'M001', title: 'Existing Milestone' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Existing Slice' });
    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'Existing Task' });
    insertAssessment({
      path: '.gsd/milestones/M001/M001-VALIDATION.md',
      milestoneId: 'M001',
      status: 'pass',
      scope: 'validate-milestone',
      fullContent: '# Existing Validation',
    });
    insertReplanHistory({
      milestoneId: 'M001',
      sliceId: 'S01',
      taskId: 'T01',
      summary: 'Existing replan row',
      previousArtifactPath: 'before.md',
      replacementArtifactPath: 'after.md',
    });
    insertGateRow({ milestoneId: 'M001', sliceId: 'S01', gateId: 'Q3', scope: 'slice' });
    saveGateResult({
      milestoneId: 'M001',
      sliceId: 'S01',
      gateId: 'Q3',
      verdict: 'pass',
      rationale: 'Existing gate',
      findings: 'No findings',
    });
    recordMilestoneCommitAttribution({
      commitSha: 'def456',
      milestoneId: 'M001',
      source: 'recorded',
      confidence: 0.8,
      files: ['src/kept.ts'],
      createdAt: '2026-06-05T00:00:00.000Z',
    });

    const restored = bootstrapFromManifest(base);
    assert.strictEqual(restored, true);

    const snap = snapshotState();
    assert.strictEqual(snap.assessments?.find((r) => r.path.endsWith('VALIDATION.md'))?.full_content, '# Existing Validation');
    assert.strictEqual(snap.replan_history?.find((r) => r.summary === 'Existing replan row')?.replacement_artifact_path, 'after.md');
    assert.strictEqual(snap.quality_gates?.find((r) => r.gate_id === 'Q3')?.rationale, 'Existing gate');
    assert.strictEqual(snap.milestone_commit_attributions?.find((r) => r.commit_sha === 'def456')?.files_json, '["src/kept.ts"]');
  } finally {
    closeDatabase();
    cleanupDir(base);
  }
});

test('workflow-manifest: bootstrapFromManifest restores memory-backed decisions', async () => {
  const base = tempDir();
  openDatabase(tempDbPath(base));
  try {
    insertMemoryBackedDecision('D901');
    await writeManifestAndFlush(base);
    closeDatabase();

    const newDbPath = path.join(base, 'new.db');
    openDatabase(newDbPath);
    const restored = bootstrapFromManifest(base);
    assert.strictEqual(restored, true);

    const decision = getAllDecisionsFromMemories().find((r) => r.id === 'D901');
    assert.ok(decision !== undefined, 'D901 should be restored into the memory-backed decision surface');
    assert.strictEqual(decision!.decision, 'Decision D901');
  } finally {
    closeDatabase();
    cleanupDir(base);
  }
});

test('workflow-manifest: bootstrapFromManifest replaces stale memory-backed decisions', async () => {
  const base = tempDir();
  openDatabase(tempDbPath(base));
  try {
    insertMemoryBackedDecision('D902');
    await writeManifestAndFlush(base);
    closeDatabase();

    const newDbPath = path.join(base, 'new.db');
    openDatabase(newDbPath);
    insertMemoryBackedDecision('D-STALE');
    insertMemoryRow({
      id: 'MEM-NOTE',
      category: 'note',
      content: 'Keep this non-decision memory',
      confidence: 0.9,
      sourceUnitType: null,
      sourceUnitId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      scope: 'project',
      tags: ['keep'],
      structuredFields: { kind: 'ordinary-note' },
    });

    const restored = bootstrapFromManifest(base);
    assert.strictEqual(restored, true);

    const decisions = getAllDecisionsFromMemories();
    assert.ok(decisions.some((r) => r.id === 'D902'), 'manifest decision should be restored into memories');
    assert.equal(decisions.some((r) => r.id === 'D-STALE'), false, 'stale memory-backed decision should be removed');

    const note = _getAdapter()!.prepare('SELECT id FROM memories WHERE id = ?').get('MEM-NOTE') as Record<string, unknown> | undefined;
    assert.strictEqual(note?.['id'], 'MEM-NOTE');
  } finally {
    closeDatabase();
    cleanupDir(base);
  }
});

test('workflow-manifest: insertTask can clear target_repositories with explicit empty array', () => {
  const base = tempDir();
  openDatabase(tempDbPath(base));
  try {
    insertMilestone({ id: 'M001', title: 'Milestone' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Slice' });
    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', planning: { targetRepositories: ['frontend'] } });
    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', planning: { targetRepositories: [] } });

    const snap = snapshotState();
    assert.deepStrictEqual(snap.tasks.find((r) => r.id === 'T01')?.target_repositories, []);
  } finally {
    closeDatabase();
    cleanupDir(base);
  }
});

// ─── snapshotState: numeric column coercion (#2962) ─────────────────────

test('workflow-manifest: snapshotState coerces string placeholders in numeric columns to null (#2962)', () => {
  const base = tempDir();
  openDatabase(tempDbPath(base));
  try {
    // Set up prerequisite rows
    insertMilestone({ id: 'M001' });
    insertSlice({ id: 'S01', milestoneId: 'M001' });
    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'Task', status: 'complete' });

    // Insert verification_evidence with string placeholders in numeric columns
    // This simulates what happens after schema migrations or manual inserts
    const db = _getAdapter()!;
    db.prepare(
      `INSERT INTO verification_evidence (task_id, slice_id, milestone_id, command, exit_code, verdict, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('T01', 'S01', 'M001', 'npm test', '-', 'pass', '-', new Date().toISOString());

    // snapshotState should coerce "-" to null for numeric columns
    const snap = snapshotState();
    const ev = snap.verification_evidence[0];
    assert.strictEqual(ev.exit_code, null, 'exit_code "-" should be coerced to null');
    assert.strictEqual(ev.duration_ms, null, 'duration_ms "-" should be coerced to null');

    // Round-trip through JSON should not throw
    const json = JSON.stringify(snap, null, 2);
    const reparsed = JSON.parse(json);
    assert.strictEqual(reparsed.verification_evidence[0].exit_code, null);
    assert.strictEqual(reparsed.verification_evidence[0].duration_ms, null);
  } finally {
    closeDatabase();
    cleanupDir(base);
  }
});

test('workflow-manifest: snapshotState coerces empty string and N/A in numeric columns (#2962)', () => {
  const base = tempDir();
  openDatabase(tempDbPath(base));
  try {
    insertMilestone({ id: 'M001' });
    insertSlice({ id: 'S01', milestoneId: 'M001' });
    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'Task', status: 'complete' });

    const db = _getAdapter()!;
    db.prepare(
      `INSERT INTO verification_evidence (task_id, slice_id, milestone_id, command, exit_code, verdict, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('T01', 'S01', 'M001', 'npm test', 'N/A', 'pass', '', new Date().toISOString());

    const snap = snapshotState();
    const ev = snap.verification_evidence[0];
    assert.strictEqual(ev.exit_code, null, 'exit_code "N/A" should be coerced to null');
    assert.strictEqual(ev.duration_ms, null, 'duration_ms "" should be coerced to null');
  } finally {
    closeDatabase();
    cleanupDir(base);
  }
});

test('workflow-manifest: snapshotState coerces string placeholders in sequence columns (#2962)', () => {
  const base = tempDir();
  openDatabase(tempDbPath(base));
  try {
    insertMilestone({ id: 'M001' });

    // Insert a slice with a string sequence via raw SQL
    const db = _getAdapter()!;
    db.prepare(
      `INSERT INTO slices (milestone_id, id, title, status, risk, depends, demo, created_at, sequence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('M001', 'S01', 'Test Slice', 'planned', 'low', '[]', '', new Date().toISOString(), '-');

    db.prepare(
      `INSERT INTO tasks (milestone_id, slice_id, id, title, status, sequence)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('M001', 'S01', 'T01', 'Test Task', 'planned', 'N/A');

    const snap = snapshotState();
    assert.strictEqual(snap.slices[0].sequence, 0, 'slice sequence "-" should be coerced to 0');
    assert.strictEqual(snap.tasks[0].sequence, 0, 'task sequence "N/A" should be coerced to 0');

    // JSON round-trip must not throw
    const json = JSON.stringify(snap, null, 2);
    assert.doesNotThrow(() => JSON.parse(json));
  } finally {
    closeDatabase();
    cleanupDir(base);
  }
});

// ─── readManifest: version check ─────────────────────────────────────────

test('workflow-manifest: readManifest throws on unsupported version', () => {
  const base = tempDir();
  try {
    fs.mkdirSync(path.join(base, '.gsd'), { recursive: true });
    fs.writeFileSync(
      path.join(base, '.gsd', 'state-manifest.json'),
      JSON.stringify({ version: 99, exported_at: '', milestones: [], slices: [], tasks: [], decisions: [], verification_evidence: [] }),
    );
    assert.throws(
      () => readManifest(base),
      /Unsupported manifest version/,
      'should throw on version mismatch',
    );
  } finally {
    cleanupDir(base);
  }
});
