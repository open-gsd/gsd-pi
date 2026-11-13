// Regression for the native-attended gate: the classifier must emit a
// native-attended-changed output that is true for maintenance/native/fixture
// changes, and false for unrelated or docs-only changes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const classifier = resolve(here, '..', 'ci-classify-changes.sh');

// Build a throwaway repo with one base commit and one head commit that changes `files`.
function classify(files) {
  const root = mkdtempSync(join(tmpdir(), 'classify-native-'));
  try {
    const run = (args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString();
    run(['init', '-q']);
    run(['config', 'user.email', 'ci@example.invalid']);
    run(['config', 'user.name', 'ci']);
    writeFileSync(join(root, 'README.md'), 'base\n');
    run(['add', '-A']); run(['commit', '-qm', 'base']);
    const base = run(['rev-parse', 'HEAD']).trim();
    for (const f of files) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      writeFileSync(join(root, f), 'change\n');
    }
    run(['add', '-A']); run(['commit', '-qm', 'head']);
    const head = run(['rev-parse', 'HEAD']).trim();
    const out = join(root, 'gh-output');
    writeFileSync(out, '');
    execFileSync('bash', [classifier], {
      cwd: root, stdio: 'pipe',
      env: { ...process.env, EVENT_NAME: 'pull_request', PR_BASE_SHA: base, HEAD_SHA: head, GITHUB_OUTPUT: out },
    });
    const kv = Object.fromEntries(readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map(l => l.split('=')));
    return kv;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('classifier emits native-attended-changed=true for maintenance engine changes', () => {
  const kv = classify(['src/resources/extensions/gsd/coordination-maintenance.ts']);
  assert.equal(kv['native-attended-changed'], 'true');
});

test('classifier emits native-attended-changed=true for the fixture builder', () => {
  const kv = classify(['scripts/build-native-fixture-package.mjs']);
  assert.equal(kv['native-attended-changed'], 'true');
});

test('classifier emits native-attended-changed=true for the native-facts collector', () => {
  const kv = classify(['src/resources/extensions/gsd/coordination-same-machine-facts.ts']);
  assert.equal(kv['native-attended-changed'], 'true');
});

test('classifier emits native-attended-changed=false for an unrelated source change', () => {
  const kv = classify(['src/resources/extensions/gsd/some-unrelated-module.ts']);
  assert.equal(kv['native-attended-changed'], 'false');
});

test('classifier emits native-attended-changed=false for docs-only changes', () => {
  const kv = classify(['docs/README.md']);
  assert.equal(kv['native-attended-changed'], 'false');
});
