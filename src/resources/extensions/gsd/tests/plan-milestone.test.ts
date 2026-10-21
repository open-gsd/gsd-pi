// Project/App: gsd-pi
// File Purpose: Regression tests for DB-backed milestone planning.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  adoptOrTransitionLifecycle,
  closeDatabase,
  deleteSlice,
  executeDomainOperation,
  getMilestone,
  getMilestoneSlices,
  getSlice,
  insertMilestone,
  openDatabase,
  projectCanonicalStatusToLegacy,
  readDomainOperationFence,
} from '../gsd-db.ts';
import { handlePlanMilestone as handlePlanMilestoneWithInvocation } from '../tools/plan-milestone.ts';
import { internalPlanningInvocation } from '../planning-invocation.ts';
import { parseProjectionRoadmap as parseRoadmap } from '../schemas/parsers.ts';
import { canonicalPhaseDirName } from '../paths.ts';

function expectedRoadmapPath(base: string, title: string, milestoneId = 'M001'): string {
  return join(base, '.gsd', 'phases', canonicalPhaseDirName(milestoneId, title), '01-ROADMAP.md');
}

function handlePlanMilestone(
  params: Parameters<typeof handlePlanMilestoneWithInvocation>[0],
  basePath: string,
) {
  return handlePlanMilestoneWithInvocation(params, basePath, internalPlanningInvocation());
}

function makeTmpBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-plan-milestone-'));
  mkdirSync(join(base, '.gsd', 'phases', '01-test'), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

function startSlice(sliceId: string, idempotencyKey: string): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: 'test.slice.start',
    idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: 'test',
    sourceTransport: 'test',
    payload: { sliceId },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: 'slice',
      milestoneId: 'M001',
      sliceId,
      lifecycleStatus: 'in_progress',
    });
    projectCanonicalStatusToLegacy(context, {
      entity: 'slice',
      milestoneId: 'M001',
      sliceId,
      status: 'in_progress',
    });
    return {
      events: [{
        eventType: 'test.slice.started',
        entityType: 'slice',
        entityId: `M001/${sliceId}`,
        payload: { sliceId },
        destinations: ['test'],
      }],
      projections: [{
        projectionKey: `test/m001/${sliceId.toLowerCase()}/started`,
        projectionKind: 'test',
        rendererVersion: '1',
      }],
    };
  });
}

function validParams() {
  return {
    milestoneId: 'M001',
    title: 'DB-backed planning',
    vision: 'Make planning write through the database.',
    successCriteria: ['Planning persists', 'Roadmap renders from DB'],
    keyRisks: [
      { risk: 'Renderer mismatch', whyItMatters: 'Rendered roadmap may stop round-tripping.' },
    ],
    proofStrategy: [
      { riskOrUnknown: 'Render correctness', retireIn: 'S01', whatWillBeProven: 'ROADMAP output matches DB state.' },
    ],
    verificationContract: 'Contract verification text',
    verificationIntegration: 'Integration verification text',
    verificationOperational: 'Operational verification text',
    verificationUat: 'UAT verification text',
    definitionOfDone: ['Tests pass', 'Tool reruns cleanly'],
    requirementCoverage: 'Covers R015.',
    boundaryMapMarkdown: '| From | To | Produces | Consumes |\n|------|----|----------|----------|\n| S01 | terminal | roadmap | nothing |',
    slices: [
      {
        sliceId: 'S01',
        title: 'Tool wiring',
        risk: 'medium',
        depends: [],
        demo: 'The tool writes roadmap state.',
        goal: 'Wire the handler.',
        successCriteria: 'Handler persists state and renders markdown.',
        proofLevel: 'integration',
        integrationClosure: 'Downstream callers read rendered roadmap output.',
        observabilityImpact: 'Tests expose render and validation failures.',
      },
      {
        sliceId: 'S02',
        title: 'Prompt migration',
        risk: 'low',
        depends: ['S01'],
        demo: 'Prompts call the tool.',
        goal: 'Migrate prompts to DB-backed path.',
        successCriteria: 'Prompt contracts reference the new tool.',
        proofLevel: 'integration',
        integrationClosure: 'Prompt tests cover the new planning route.',
        observabilityImpact: 'Prompt and rogue-write failures become explicit.',
      },
    ],
  };
}

test('handlePlanMilestone writes milestone and slice planning state and renders roadmap', async () => {
  const base = makeTmpBase();
  const dbPath = join(base, '.gsd', 'gsd.db');
  openDatabase(dbPath);

  try {
    const result = await handlePlanMilestone(validParams(), base);
    assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);

    const milestone = getMilestone('M001');
    assert.ok(milestone, 'milestone should exist');
    assert.equal(milestone?.vision, 'Make planning write through the database.');
    assert.deepEqual(milestone?.success_criteria, ['Planning persists', 'Roadmap renders from DB']);
    assert.equal(milestone?.verification_contract, 'Contract verification text');

    const slices = getMilestoneSlices('M001');
    assert.equal(slices.length, 2);
    assert.equal(slices[0]?.id, 'S01');
    assert.equal(slices[0]?.goal, 'Wire the handler.');
    assert.equal(slices[1]?.depends[0], 'S01');

    const roadmapPath = expectedRoadmapPath(base, 'DB-backed planning');
    assert.ok(existsSync(roadmapPath), 'roadmap should be rendered to disk');
    const roadmap = readFileSync(roadmapPath, 'utf-8');
    assert.match(roadmap, /# M001: DB-backed planning/);
    assert.match(roadmap, /\*\*Vision:\*\* Make planning write through the database\./);
    assert.match(roadmap, /^## Slices$/m);
    assert.match(roadmap, /- \[ \] \*\*S01: Tool wiring\*\* `risk:medium` `depends:\[\]`/);
    assert.match(roadmap, /- \[ \] \*\*S02: Prompt migration\*\* `risk:low` `depends:\[S01\]`/);
  } finally {
    cleanup(base);
  }
});

test('handlePlanMilestone rejects invalid payloads', async () => {
  const base = makeTmpBase();
  const dbPath = join(base, '.gsd', 'gsd.db');
  openDatabase(dbPath);

  try {
    const params = validParams();
    const result = await handlePlanMilestone({ ...params, slices: [] }, base);
    assert.ok('error' in result);
    assert.match(result.error, /validation failed: slices must be a non-empty array/);
  } finally {
    cleanup(base);
  }
});

test('handlePlanMilestone rejects delimiter characters in milestone and slice titles', async () => {
  const base = makeTmpBase();
  const dbPath = join(base, '.gsd', 'gsd.db');
  openDatabase(dbPath);

  try {
    const milestoneResult = await handlePlanMilestone({ ...validParams(), title: 'Client/Server split' }, base);
    assert.ok('error' in milestoneResult);
    assert.match(milestoneResult.error, /validation failed: title is invalid: .*forward slash/);
    assert.equal(getMilestone('M001'), null, 'invalid milestone title must not persist');

    const sliceResult = await handlePlanMilestone({
      ...validParams(),
      slices: [
        validParams().slices[0],
        { ...validParams().slices[1], title: 'Client/Server migration' },
      ],
    }, base);
    assert.ok('error' in sliceResult);
    assert.match(sliceResult.error, /validation failed: slices\[1\]\.title is invalid: .*forward slash/);
    assert.equal(getMilestoneSlices('M001').length, 0, 'invalid slice title must not persist partial roadmap state');
  } finally {
    cleanup(base);
  }
});

test('handlePlanMilestone surfaces render failures and does not clear parse-visible state on failure', async () => {
  const base = makeTmpBase();
  const dbPath = join(base, '.gsd', 'gsd.db');
  openDatabase(dbPath);

  try {
    // Block the rendered roadmap path: M999 → phaseNum=999, slug='db-backed-planning'
    // → renderer targets phases/999-db-backed-planning/999-ROADMAP.md.
    // Creating that path as a directory causes EISDIR → render fails.
    const fallbackRoadmapPath = join(base, '.gsd', 'phases', '999-db-backed-planning', '999-ROADMAP.md');
    mkdirSync(fallbackRoadmapPath, { recursive: true });

    const result = await handlePlanMilestone({ ...validParams(), milestoneId: 'M999' }, base);
    assert.ok('error' in result);
    assert.match(result.error, /render failed:/);

    const existingRoadmapPath = join(base, '.gsd', 'phases', '01-test', '01-ROADMAP.md');
    writeFileSync(existingRoadmapPath, '# M001: Cached roadmap\n\n**Vision:** old value\n\n## Slices\n\n', 'utf-8');
    const cachedAfter = parseRoadmap(readFileSync(existingRoadmapPath, 'utf-8'));
    assert.equal(cachedAfter.vision, 'old value');
  } finally {
    cleanup(base);
  }
});

test('handlePlanMilestone clears parse-visible roadmap state after successful render', async () => {
  const base = makeTmpBase();
  const dbPath = join(base, '.gsd', 'gsd.db');
  openDatabase(dbPath);

  try {
    const cachedPath = join(base, '.gsd', 'phases', '01-test', '01-ROADMAP.md');
    writeFileSync(cachedPath, '# M001: Cached roadmap\n\n**Vision:** old value\n\n## Slices\n\n', 'utf-8');

    const cachedBefore = parseRoadmap(readFileSync(cachedPath, 'utf-8'));
    assert.equal(cachedBefore.vision, 'old value');

    const result = await handlePlanMilestone(validParams(), base);
    assert.ok(!('error' in result));

    const contentAfter = readFileSync(expectedRoadmapPath(base, 'DB-backed planning'), 'utf-8');
    assert.match(contentAfter, /Make planning write through the database\./);
    assert.match(contentAfter, /S01/);
    assert.match(contentAfter, /S02/);
  } finally {
    cleanup(base);
  }
});

test('handlePlanMilestone reruns idempotently and updates existing planning state', async () => {
  const base = makeTmpBase();
  const dbPath = join(base, '.gsd', 'gsd.db');
  openDatabase(dbPath);

  try {
    const first = await handlePlanMilestone(validParams(), base);
    assert.ok(!('error' in first));

    const second = await handlePlanMilestone({
      ...validParams(),
      vision: 'Updated vision',
      slices: [
        {
          ...validParams().slices[0],
          goal: 'Updated goal',
          observabilityImpact: 'Updated observability',
        },
        validParams().slices[1],
      ],
    }, base);
    assert.ok(!('error' in second));

    const milestone = getMilestone('M001');
    assert.equal(milestone?.vision, 'Updated vision');

    const slices = getMilestoneSlices('M001');
    assert.equal(slices.length, 2);
    assert.equal(slices[0]?.goal, 'Updated goal');
    assert.equal(slices[0]?.observability_impact, 'Updated observability');
  } finally {
    cleanup(base);
  }
});

test('handlePlanMilestone preserves in-progress slice status on re-plan (#2558)', async () => {
  const base = makeTmpBase();
  const dbPath = join(base, '.gsd', 'gsd.db');
  openDatabase(dbPath);

  try {
    // Initial plan — both slices start as "pending"
    const first = await handlePlanMilestone(validParams(), base);
    assert.ok(!('error' in first), `unexpected error: ${'error' in first ? first.error : ''}`);

    // Start S01 through the canonical lifecycle operation.
    startSlice('S01', 'test/plan-milestone/preserve-status/start-s01');

    const s01Before = getSlice('M001', 'S01');
    assert.equal(s01Before?.status, 'in_progress', 'S01 should be in progress before re-plan');

    // Re-plan the same milestone — S01 must stay in progress, S02 stays pending.
    const second = await handlePlanMilestone(validParams(), base);
    assert.ok(!('error' in second), `unexpected error: ${'error' in second ? second.error : ''}`);

    const s01After = getSlice('M001', 'S01');
    assert.equal(s01After?.status, 'in_progress', 'S01 status must be preserved after re-plan');

    const s02After = getSlice('M001', 'S02');
    assert.equal(s02After?.status, 'pending', 'S02 should remain pending');
  } finally {
    cleanup(base);
  }
});

test('handlePlanMilestone requires explicit reopen before planning a legacy deferred milestone', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    insertMilestone({ id: 'M001', title: 'Deferred milestone', status: 'deferred' });

    const result = await handlePlanMilestone(validParams(), base);

    assert.ok('error' in result);
    assert.match(result.error, /cancelled milestone M001.*reopen/i);
    assert.equal(getMilestone('M001')?.title, 'Deferred milestone');
    assert.equal(getMilestone('M001')?.status, 'deferred');
    assert.deepEqual(getMilestoneSlices('M001'), []);
  } finally {
    cleanup(base);
  }
});

test('plan-milestone re-plan preserves in-progress status and updates slice fields (#2558)', async () => {
  const base = makeTmpBase();
  const dbPath = join(base, '.gsd', 'gsd.db');
  openDatabase(dbPath);

  try {
    // Initial plan — both slices start as "pending"
    const first = await handlePlanMilestone(validParams(), base);
    assert.ok(!('error' in first), `unexpected error: ${'error' in first ? first.error : ''}`);

    // Start S01 through the canonical lifecycle operation.
    startSlice('S01', 'test/plan-milestone/update-fields/start-s01');
    assert.equal(getSlice('M001', 'S01')?.status, 'in_progress');

    // Re-plan with updated title for S01.
    // The handler must:
    //   1. NOT downgrade S01 from "in_progress" to "pending"
    //   2. Update S01's non-status fields (title, risk, depends, demo)
    //   3. Keep S02 as "pending"
    const updatedParams = {
      ...validParams(),
      slices: [
        { ...validParams().slices[0], title: 'Updated S01 title', risk: 'high' },
        validParams().slices[1],
      ],
    };
    const second = await handlePlanMilestone(updatedParams, base);
    assert.ok(!('error' in second), `unexpected error: ${'error' in second ? second.error : ''}`);

    const s01After = getSlice('M001', 'S01');
    assert.equal(s01After?.status, 'in_progress', 'in-progress slice status must survive re-plan');
    assert.equal(s01After?.title, 'Updated S01 title', 'title should update on re-plan');
    assert.equal(s01After?.risk, 'high', 'risk should update on re-plan');

    const s02After = getSlice('M001', 'S02');
    assert.equal(s02After?.status, 'pending', 'pending slice stays pending');
  } finally {
    cleanup(base);
  }
});

test('handlePlanMilestone promotes pre-existing queued milestone to active (#3022)', async () => {
  const base = makeTmpBase();
  const dbPath = join(base, '.gsd', 'gsd.db');
  openDatabase(dbPath);

  try {
    // Simulate ensureMilestoneDbRow: pre-create row with status "queued"
    // (this is what gsd_milestone_generate_id does)
    insertMilestone({ id: 'M001', status: 'queued' });

    const before = getMilestone('M001');
    assert.equal(before?.status, 'queued', 'pre-condition: milestone should start as queued');

    // Now plan the milestone — status should be promoted to "active"
    const result = await handlePlanMilestone(validParams(), base);
    assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);

    const after = getMilestone('M001');
    assert.equal(after?.status, 'active', 'milestone status should be promoted from queued to active');
    assert.equal(after?.title, 'DB-backed planning', 'milestone title should be set');
  } finally {
    cleanup(base);
  }
});

test('handlePlanMilestone updates depends_on when a queued milestone row already exists', async () => {
  const base = makeTmpBase();
  mkdirSync(join(base, '.gsd', 'milestones', 'M002'), { recursive: true });
  const dbPath = join(base, '.gsd', 'gsd.db');
  openDatabase(dbPath);

  try {
    insertMilestone({ id: 'M001', title: 'Dependency', status: 'complete' });
    insertMilestone({ id: 'M002', status: 'queued' });

    const result = await handlePlanMilestone({
      ...validParams(),
      milestoneId: 'M002',
      title: 'Dependent planning',
      dependsOn: ['M001'],
    }, base);
    assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);

    const after = getMilestone('M002');
    assert.deepEqual(after?.depends_on, ['M001'], 'depends_on should be updated from planning params');
    assert.equal(after?.status, 'active', 'queued milestone should still be promoted to active');
  } finally {
    cleanup(base);
  }
});

// Regression #566: bracket-wrapped slice ID in depends should be rejected
test('handlePlanMilestone rejects bracket-wrapped depends like ["[S01]"]', async () => {
  const base = makeTmpBase();
  const dbPath = join(base, '.gsd', 'gsd.db');
  openDatabase(dbPath);

  try {
    const params = validParams();
    // Simulate the LLM sending "[S01]" (the markdown fragment) instead of "S01"
    const corruptSlices = [
      params.slices[0],
      { ...params.slices[1], depends: ['[S01]'] },
    ];
    const result = await handlePlanMilestone({ ...params, slices: corruptSlices }, base);
    assert.ok('error' in result, 'should return an error for bracket-wrapped depends');
    assert.match(result.error, /slices\[1\]\.depends must be an array of valid slice IDs/,
      'error should mention invalid slice ID format');
    assert.equal(getMilestoneSlices('M001').length, 0, 'no slices should persist on validation failure');
  } finally {
    cleanup(base);
  }
});

// Regression #566: unknown slice ID in depends should be rejected
test('handlePlanMilestone rejects depends referencing a slice not in the same milestone', async () => {
  const base = makeTmpBase();
  const dbPath = join(base, '.gsd', 'gsd.db');
  openDatabase(dbPath);

  try {
    const params = validParams();
    const corruptSlices = [
      params.slices[0],
      { ...params.slices[1], depends: ['S99'] },
    ];
    const result = await handlePlanMilestone({ ...params, slices: corruptSlices }, base);
    assert.ok('error' in result, 'should return an error for unknown depends slice');
    assert.match(result.error, /references unknown slice "S99"/,
      'error should name the unknown slice');
    assert.equal(getMilestoneSlices('M001').length, 0, 'no slices should persist on validation failure');
  } finally {
    cleanup(base);
  }
});
