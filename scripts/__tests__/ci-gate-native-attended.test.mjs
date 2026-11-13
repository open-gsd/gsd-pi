// Regression for the native-attended gate. The gate must be fail-closed:
// a native result of 'skipped' passes ONLY when the classifier said the change
// is not native-relevant; a relevant change must produce 'success'.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const ciYml = readFileSync(resolve(here, '..', '..', '.github', 'workflows', 'ci.yml'), 'utf8');

// Extract the ci-gate step that asserts results, run it with given needs results.
function runGate({ native, nativeRelevant }) {
  // Slice from the ci-gate assert step's 'run: |' to the first line that is NOT
  // indented deeper than the 'run:' key (i.e. the next step or job key).
  const start = ciYml.indexOf('Assert no upstream job failed or was cancelled');
  assert.ok(start >= 0, 'ci-gate assert step not found in ci.yml');
  const after = ciYml.slice(start);
  const lines = after.split('\n');
  const runIdx = lines.findIndex(l => /^\s+run: \|\s*$/.test(l));
  assert.ok(runIdx > 0, 'run: | not found in ci-gate assert step');
  const runIndent = lines[runIdx].match(/^(\s*)/)[1].length;
  const body = [];
  for (let i = runIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') { body.push(''); continue; }
    const ind = l.match(/^(\s*)/)[1].length;
    if (ind <= runIndent) break;
    body.push(l);
  }
  const base = Math.min(...body.filter(l => l.trim()).map(l => l.match(/^(\s*)/)[1].length));
  const script = body.map(l => l.slice(base)).join('\n');
  assert.match(script, /set -euo pipefail/, 'extracted script looks wrong');
  const env = {
    FAST_GATES: 'success', BUILD: 'success', WINDOWS: 'skipped', NODE22: 'success',
    WORKFLOW_LINT: 'success', NATIVE_ATTENDED: native, NATIVE_RELEVANT: nativeRelevant,
    PATH: process.env.PATH,
  };
  try {
    execFileSync('bash', ['-c', script], { env, stdio: 'pipe' });
    return 0;
  } catch (err) {
    return err.status ?? 1;
  }
}

test('relevant native change with a SKIPPED native job blocks ci-gate', () => {
  assert.notEqual(runGate({ native: 'skipped', nativeRelevant: 'true' }), 0);
});
test('relevant native change with a FAILED native job blocks ci-gate', () => {
  assert.notEqual(runGate({ native: 'failure', nativeRelevant: 'true' }), 0);
});
test('relevant native change with a CANCELLED native job blocks ci-gate', () => {
  assert.notEqual(runGate({ native: 'cancelled', nativeRelevant: 'true' }), 0);
});
test('relevant native change with a SUCCESS native job passes ci-gate', () => {
  assert.equal(runGate({ native: 'success', nativeRelevant: 'true' }), 0);
});
test('non-relevant change with a SKIPPED native job passes ci-gate', () => {
  assert.equal(runGate({ native: 'skipped', nativeRelevant: 'false' }), 0);
});
test('unknown classifier value fails closed even when native is skipped', () => {
  assert.notEqual(runGate({ native: 'skipped', nativeRelevant: '' }), 0);
});
