import assert from 'node:assert/strict';
import test from 'node:test';
import { CONTROLLER, ProjectSync } from '../dist/sync.js';

const progress = (overrides = {}) => ({
  phase: 'execution', activeMilestone: { id: 'M001', title: 'Build' },
  activeSlice: { id: 'S01', title: 'Slice' }, activeTask: { id: 'T01', title: 'Task' },
  blockers: [], nextAction: 'Execute task', tasks: { done: 0, total: 2 }, ...overrides,
});

function fixture() {
  const records = new Map();
  const cards = [];
  const notices = [];
  const calls = [];
  let conflict = false;
  let missingBoard = false;
  const write = (status, input) => {
    const flow = records.get(input.flowId);
    if (conflict || flow.revision !== input.expectedRevision) return { applied: false, code: 'revision_conflict' };
    const next = { ...flow, ...input, status, revision: flow.revision + 1, updatedAt: flow.updatedAt + 1,
      ...(status === 'succeeded' ? { endedAt: Date.now() } : {}) };
    records.set(next.flowId, next);
    return { applied: true, flow: next };
  };
  const host = {
    flows: {
      list: () => [...records.values()], get: (id) => records.get(id),
      createManaged(input) {
        const flow = { ...input, flowId: `flow-${records.size}`, ownerKey: 'agent:main:main', status: 'queued', revision: 1, updatedAt: Date.now() };
        records.set(flow.flowId, flow);
        return flow;
      },
      setWaiting: (input) => write('waiting', input), finish: (input) => write('succeeded', input),
    },
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'projects.register') return { id: 'native-project' };
      if (missingBoard) throw new Error('unknown method: workboard.cards.list');
      if (method === 'workboard.cards.list') return { cards };
      if (method === 'workboard.cards.create') {
        const existing = cards.find((c) => c.metadata.automation.idempotencyKey === params.idempotencyKey);
        if (existing) return { card: existing };
        const card = { ...params, id: `card-${cards.length}`, updatedAt: Date.now(), metadata: { automation: { tenant: params.tenant, idempotencyKey: params.idempotencyKey } } };
        cards.push(card);
        return { card };
      }
      assert.equal(method, 'workboard.cards.update');
      const card = cards.find((c) => c.id === params.id);
      assert.equal(params.expectedUpdatedAt, card.updatedAt);
      Object.assign(card, params.patch, { updatedAt: card.updatedAt + 1 });
      return { card };
    },
    notify: (key, text) => notices.push({ key, text }),
  };
  return { host, cards, records, notices, calls, setConflict: (v) => { conflict = v; }, setMissingBoard: (v) => { missingBoard = v; } };
}

test('progress, blockers and completion converge in native records across controller restart', async () => {
  const f = fixture();
  let sync = new ProjectSync(f.host, {}, assert.fail);
  await sync.reconcile('/repo', '/state/repo', progress());
  assert.equal(f.records.size, 1);
  assert.equal(f.cards[0].status, 'running');
  assert.equal(f.records.values().next().value.controllerId, CONTROLLER);
  const revision = f.records.values().next().value.revision;
  await sync.stop();
  sync = new ProjectSync(f.host, {}, assert.fail);
  await sync.reconcile('/repo', '/state/repo', progress());
  assert.equal(f.records.size, 1);
  assert.equal(f.cards.length, 1);
  assert.equal(f.records.values().next().value.revision, revision);
  assert.equal(f.notices.length, 1, 'restart does not repeat an unchanged notification');
  await sync.reconcile('/repo', '/state/repo', progress({ blockers: ['Need user input'] }));
  assert.equal(f.cards[0].status, 'blocked');
  await sync.reconcile('/repo', '/state/repo', progress({ phase: 'complete', activeMilestone: null }));
  assert.equal(f.cards[0].status, 'done');
  assert.equal(f.records.values().next().value.status, 'succeeded');
  assert.ok(f.notices.at(-1).text.includes('complete'));
});

test('Workboard is optional and enabling it later backfills the existing flow', async () => {
  const f = fixture();
  const sync = new ProjectSync(f.host, {}, assert.fail);
  f.setMissingBoard(true);
  await sync.reconcile('/repo', '/state/repo', progress());
  assert.equal(f.records.size, 1);
  assert.equal(f.cards.length, 0);
  f.setMissingBoard(false);
  await sync.reconcile('/repo', '/state/repo', progress());
  assert.equal(f.records.size, 1);
  assert.equal(f.cards.length, 1);
});

test('revision refusal never reports completion or advances the card', async () => {
  const f = fixture();
  const sync = new ProjectSync(f.host, {}, assert.fail);
  await sync.reconcile('/repo', '/state/repo', progress());
  f.setConflict(true);
  await assert.rejects(sync.reconcile('/repo', '/state/repo', progress({ phase: 'complete' })), /revision_conflict/);
  assert.equal(f.cards[0].status, 'running');
  assert.equal(f.notices.length, 1);
});

test('cancellation during host I/O wins and is not resurrected after restart', async () => {
  const f = fixture();
  let sync = new ProjectSync(f.host, {}, assert.fail);
  await sync.reconcile('/repo', '/state/repo', progress());
  const request = f.host.request;
  f.host.request = async (method, params) => {
    const result = await request(method, params);
    const flow = f.records.values().next().value;
    flow.cancelRequestedAt = Date.now();
    flow.status = 'cancelled';
    flow.endedAt = Date.now();
    return result;
  };
  await sync.reconcile('/repo-worktree', '/state/repo', progress({ phase: 'complete' }));
  await sync.stop();
  sync = new ProjectSync(f.host, {}, assert.fail);
  await sync.reconcile('/repo', '/state/repo', progress({ phase: 'execution' }));
  assert.equal(f.records.size, 1);
  assert.equal(f.cards[0].status, 'running');
  assert.equal(f.notices.length, 1);
});

test('new work after completion creates a fresh flow and reuses the project card', async () => {
  const f = fixture();
  const sync = new ProjectSync(f.host, {}, assert.fail);
  await sync.reconcile('/repo', '/state/repo', progress({ phase: 'complete' }));
  await sync.reconcile('/repo', '/state/repo', progress({ activeMilestone: { id: 'M002', title: 'Next' } }));
  assert.equal(f.records.size, 2);
  assert.equal(f.cards.length, 1);
  assert.equal(f.cards[0].status, 'running');
});

test('permission errors remain errors; archived cards and user notes are retained', async () => {
  const f = fixture();
  const sync = new ProjectSync(f.host, {}, assert.fail);
  await sync.reconcile('/repo', '/state/repo', progress());
  f.cards[0].metadata.archivedAt = Date.now();
  f.cards[0].notes = 'Keep this archive';
  await sync.reconcile('/repo', '/state/repo', progress({ phase: 'complete' }));
  assert.equal(f.cards[0].notes, 'Keep this archive');
  f.host.request = async () => { throw new Error('FORBIDDEN'); };
  await assert.rejects(sync.reconcile('/another', '/state/another', progress()), /FORBIDDEN/);
  assert.equal(f.records.size, 1);
});

test('unreadable state retains the last facts, signals a blocker once, and recovers on a later event', async () => {
  const f = fixture();
  const sync = new ProjectSync(f.host, {}, assert.fail);
  await sync.reconcile('/repo', '/state/repo', progress());
  await sync.markUnavailable('/repo', '/state/repo');
  await sync.markUnavailable('/repo', '/state/repo');
  assert.equal(f.cards[0].status, 'blocked');
  assert.equal(f.records.values().next().value.stateJson.milestone, 'M001');
  assert.equal(f.notices.length, 2);
  await sync.reconcile('/repo', '/state/repo', progress());
  assert.equal(f.cards[0].status, 'running');
  assert.equal(f.records.values().next().value.stateJson.unavailable, undefined);
});
