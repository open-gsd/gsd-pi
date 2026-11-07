import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nativeProjectsFromPayload } from '../dist/native-projects.js';

test('native project payload uses native IDs and roots, keeps ordinary projects, and deduplicates checkouts', () => {
  assert.deepEqual(nativeProjectsFromPayload({ projects: [
    { id: 'workspace:main', source: 'workspace', displayName: 'a', repoRoot: '/projects/a' },
    { id: 'a', displayName: 'First', repoRoot: '/projects/a' },
    { id: 'b', displayName: 'Second', repoRoot: '/worktrees/b' },
    { id: 'duplicate', displayName: 'Duplicate', repoRoot: '/projects/a' },
    { id: 'redacted', displayName: 'Reader-only' },
    { id: 'relative', displayName: 'Invalid', repoRoot: '../outside' },
    null,
  ] }), [
    { projectId: 'a', name: 'First', canonicalRoot: '/projects/a' },
    { projectId: 'b', name: 'Second', canonicalRoot: '/worktrees/b' },
  ]);
});

test('workspace-only projects keep their native identities', () => {
  assert.deepEqual(nativeProjectsFromPayload({ projects: [
    { id: 'workspace:main', source: 'workspace', displayName: 'Workspace', repoRoot: '/workspace' },
  ] }), [{ projectId: 'workspace:main', name: 'Workspace', canonicalRoot: '/workspace' }]);
});

test('missing or malformed native catalogs fail closed; empty/redacted catalogs stay empty', () => {
  for (const payload of [null, [], {}, { projects: 'wrong' }]) {
    assert.throws(() => nativeProjectsFromPayload(payload), /Invalid OpenClaw project catalog/);
  }
  assert.deepEqual(nativeProjectsFromPayload({ projects: [] }), []);
  assert.deepEqual(nativeProjectsFromPayload({ projects: [{ id: 'read-only', displayName: 'Hidden path' }] }), []);
});

test('plugin declares authenticated gateway dispatch, never an owner credential fallback', () => {
  const manifest = JSON.parse(readFileSync(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.contracts.gatewayMethodDispatch, ['authenticated-request']);
});
