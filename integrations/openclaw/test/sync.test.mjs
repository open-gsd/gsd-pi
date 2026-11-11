import assert from 'node:assert/strict';
import test from 'node:test';
import { CONTROLLER, ProjectSync, state } from '../dist/sync.js';

const progress = (overrides = {}) => ({
  phase: 'execution', activeMilestone: { id: 'M001', title: 'Build' },
  activeSlice: { id: 'S01', title: 'Slice' }, activeTask: { id: 'T01', title: 'Task' },
  blockers: [], nextAction: 'Execute task', tasks: { done: 0, total: 2 }, ...overrides,
});

function fixture() {
  const cards = [];
  const notices = [];
  const calls = [];
  let conflict = false;
  let missingBoard = false;
  const host = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'plugins.list') return { plugins: [{ id: 'workboard', installed: true, enabled: !missingBoard }] };
      if (method === 'projects.register') return { id: 'native-project' };
      if (missingBoard) throw new Error('unknown method: workboard.cards.list');
      if (method === 'workboard.cards.list') return { cards: structuredClone(cards) };
      if (method === 'workboard.cards.create') {
        const existing = cards.find((c) => c.metadata.automation.idempotencyKey === params.idempotencyKey);
        if (existing) return { card: structuredClone(existing) };
        const card = { ...params, id: `card-${cards.length}`, updatedAt: Date.now(), metadata: { automation: { tenant: params.tenant, idempotencyKey: params.idempotencyKey } } };
        cards.push(card);
        return { card: structuredClone(card) };
      }
      assert.equal(method, 'workboard.cards.update');
      const card = cards.find((c) => c.id === params.id);
      if (conflict || params.expectedUpdatedAt !== card.updatedAt) throw new Error('revision_conflict');
      Object.assign(card, params.patch, { updatedAt: card.updatedAt + 1 });
      return { card: structuredClone(card) };
    },
    notify: (key, text) => notices.push({ key, text }),
  };
  return { host, cards, notices, calls, setConflict: (v) => { conflict = v; }, setMissingBoard: (v) => { missingBoard = v; } };
}

test('progress, blockers and completion converge in Workboard across controller restart', async () => {
  const f = fixture();
  let sync = new ProjectSync(f.host, {}, assert.fail);
  await sync.reconcile('/repo', '/state/repo', progress());
  assert.equal(f.cards[0].status, 'running');
  assert.equal(f.cards[0].metadata.automation.tenant, CONTROLLER);
  const revision = f.cards[0].updatedAt;
  await sync.stop();
  sync = new ProjectSync(f.host, {}, assert.fail);
  assert.deepEqual(await sync.restore(), ['/repo']);
  await sync.reconcile('/repo', '/state/repo', progress());
  assert.equal(f.cards.length, 1);
  assert.equal(f.cards[0].updatedAt, revision);
  assert.equal(f.notices.length, 1, 'restart does not repeat an unchanged notification');
  await sync.reconcile('/repo', '/state/repo', progress({ blockers: ['Need user input'] }));
  assert.equal(f.cards[0].status, 'blocked');
  await sync.reconcile('/repo', '/state/repo', progress({ phase: 'complete', activeMilestone: null }));
  assert.equal(f.cards[0].status, 'done');
  assert.equal(state(f.cards[0]).phase, 'complete');
  assert.ok(f.notices.at(-1).text.includes('complete'));
});

test('without optional Workboard only memory observations exist; enabling it backfills one card', async () => {
  const f = fixture();
  let sync = new ProjectSync(f.host, {}, assert.fail);
  f.setMissingBoard(true);
  await sync.reconcile('/repo', '/state/repo', progress());
  assert.equal(sync.snapshots().length, 1);
  assert.equal(f.cards.length, 0);
  assert.ok(!f.calls.some(({ method }) => method.startsWith('workboard.')));
  await sync.stop();
  f.setMissingBoard(false);
  sync = new ProjectSync(f.host, {}, assert.fail);
  await sync.reconcile('/repo', '/state/repo', progress());
  assert.equal(f.cards.length, 1);
  assert.equal(f.notices.length, 2);
  await sync.stop();
  assert.deepEqual(sync.snapshots(), []);
});

test('optimistic concurrency refusal never reports completion or advances heartbeat facts', async () => {
  const f = fixture();
  const sync = new ProjectSync(f.host, {}, assert.fail);
  await sync.reconcile('/repo', '/state/repo', progress());
  f.setConflict(true);
  await assert.rejects(sync.reconcile('/repo', '/state/repo', progress({ phase: 'complete' })), /revision_conflict/);
  assert.equal(f.cards[0].status, 'running');
  assert.equal(sync.snapshots()[0].status, 'running');
  assert.equal(f.notices.length, 1);
});

test('archiving during registration wins the version check and remains archived after restart', async () => {
  const f = fixture();
  let sync = new ProjectSync(f.host, {}, assert.fail);
  await sync.reconcile('/repo', '/state/repo', progress());
  const request = f.host.request;
  f.host.request = async (method, params) => {
    const result = await request(method, params);
    if (method === 'projects.register') {
      f.cards[0].metadata.archivedAt = Date.now();
      f.cards[0].updatedAt++;
    }
    return result;
  };
  await assert.rejects(sync.reconcile('/repo-worktree', '/state/repo', progress({ phase: 'complete' })), /revision_conflict/);
  await sync.stop();
  sync = new ProjectSync(f.host, {}, assert.fail);
  await sync.reconcile('/repo', '/state/repo', progress());
  assert.equal(f.cards.length, 1);
  assert.equal(f.cards[0].status, 'running');
  assert.equal(f.notices.length, 1);
  assert.deepEqual(sync.snapshots(), []);
});

test('new work after completion reuses the same project card without inventing execution records', async () => {
  const f = fixture();
  const sync = new ProjectSync(f.host, {}, assert.fail);
  await sync.reconcile('/repo', '/state/repo', progress({ phase: 'complete' }));
  await sync.reconcile('/repo', '/state/repo', progress({ activeMilestone: { id: 'M002', title: 'Next' } }));
  assert.equal(f.cards.length, 1);
  assert.equal(f.cards[0].status, 'running');
  assert.equal(state(f.cards[0]).milestone, 'M002');
  assert.ok(f.calls.every(({ method }) => !method.includes('task') && !method.includes('flow')));
});

test('permission errors remain errors; user notes survive managed state updates', async () => {
  const f = fixture();
  const sync = new ProjectSync(f.host, {}, assert.fail);
  await sync.reconcile('/repo', '/state/repo', progress());
  f.cards[0].notes = 'User preface\n' + f.cards[0].notes + '\nUser suffix';
  f.cards[0].updatedAt++;
  await sync.reconcile('/repo', '/state/repo', progress({ phase: 'complete' }));
  assert.ok(f.cards[0].notes.startsWith('User preface\n'));
  assert.ok(f.cards[0].notes.endsWith('\nUser suffix'));
  f.host.request = async () => { throw new Error('FORBIDDEN'); };
  await assert.rejects(sync.reconcile('/another', '/state/another', progress()), /FORBIDDEN/);
  assert.equal(f.cards.length, 1);
});

test('unreadable state retains last database facts across restarts and recovers on a later event', async () => {
  const f = fixture();
  let sync = new ProjectSync(f.host, {}, assert.fail);
  await sync.reconcile('/repo', '/state/repo', progress({ source: 'database' }));
  await sync.stop();
  sync = new ProjectSync(f.host, {}, assert.fail);
  await sync.restore();
  assert.equal(sync.snapshots()[0].stateSource, 'database');
  await sync.markUnavailable('/repo', '/state/repo');
  await sync.markUnavailable('/repo', '/state/repo');
  assert.equal(f.cards[0].status, 'blocked');
  assert.equal(state(f.cards[0]).milestone, 'M001');
  assert.equal(state(f.cards[0]).stateSource, 'database');
  assert.equal(f.notices.length, 2);
  await sync.reconcile('/repo', '/state/repo', progress({ source: 'database' }));
  assert.equal(f.cards[0].status, 'running');
  assert.equal(state(f.cards[0]).unavailable, undefined);
});

test('legacy cards restore database provenance without reading obsolete TaskFlow storage', async () => {
  const f = fixture();
  const sync = new ProjectSync(f.host, {}, assert.fail);
  await sync.reconcile('/repo', '/state/repo', progress({ source: 'database' }));
  const snapshot = state(f.cards[0]);
  f.cards[0].notes = `Automatically synchronized GSD workflow (execution liveness is not inferred).\nTaskFlow: old-flow-id\nProject: /repo\n${JSON.stringify(snapshot, null, 2)}`;
  assert.equal(state(f.cards[0]).stateSource, 'database');
  await sync.stop();
  const restored = new ProjectSync(f.host, {}, assert.fail);
  assert.deepEqual(await restored.restore(), ['/repo']);
  await restored.markUnavailable('/repo', '/state/repo');
  assert.equal(state(f.cards[0]).stateSource, 'database');
  assert.equal(state(f.cards[0]).unavailable, true);
});


test('host catalog errors are not mistaken for optional absence and may recover', async () => {
  const f = fixture();
  const request = f.host.request;
  let refused = true;
  f.host.request = async (method, params) => {
    if (method === 'plugins.list' && refused) throw new Error('FORBIDDEN');
    return request(method, params);
  };
  const sync = new ProjectSync(f.host, {}, assert.fail);
  await assert.rejects(sync.restore(), /FORBIDDEN/);
  assert.equal(f.notices.length, 0);
  refused = false;
  await sync.restore();
  await sync.reconcile('/repo', '/state/repo', progress());
  await sync.reconcile('/repo', '/state/repo', progress());
  assert.equal(f.calls.filter(({ method }) => method === 'plugins.list').length, 1);
  assert.equal(f.cards.length, 1);
});
