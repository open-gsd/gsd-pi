import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeUnitRuntimeRecord, readUnitRuntimeRecord } from '../unit-runtime.ts';
import { resolveAutoSupervisorConfig } from '../preferences.ts';

test('resolveAutoSupervisorConfig provides safe timeout defaults', () => {
  // Isolate from any developer ~/.gsd/PREFERENCES.md that overrides these
  // defaults — the test pins what resolveAutoSupervisorConfig() returns when
  // no preferences file exists, so it must not pick up the runner's home dir.
  const previousGsdHome = process.env.GSD_HOME;
  const previousCwd = process.cwd();
  const isolated = mkdtempSync(join(tmpdir(), 'gsd-supervisor-defaults-'));
  process.env.GSD_HOME = isolated;
  process.chdir(isolated);
  try {
    const supervisor = resolveAutoSupervisorConfig();
    assert.equal(supervisor.soft_timeout_minutes, 20);
    assert.equal(supervisor.idle_timeout_minutes, 10);
    assert.equal(supervisor.hard_timeout_minutes, 30);
    // A single hung tool gets its own short budget, well below the idle window,
    // so a genuinely stuck tool is recovered in minutes instead of waiting out
    // the full idle timeout.
    assert.equal(supervisor.stalled_tool_timeout_minutes, 5);
  } finally {
    if (previousGsdHome === undefined) {
      delete process.env.GSD_HOME;
    } else {
      process.env.GSD_HOME = previousGsdHome;
    }
    process.chdir(previousCwd);
  }
});

test('writeUnitRuntimeRecord persists progress and recovery metadata defaults', () => {
  const base = mkdtempSync(join(tmpdir(), 'gsd-auto-supervisor-'));
  const startedAt = 1234567890;

  writeUnitRuntimeRecord(base, 'plan-milestone', 'M010', startedAt, {
    phase: 'dispatched',
    lastProgressAt: startedAt,
    progressCount: 1,
    lastProgressKind: 'dispatch',
  });

  const runtime = readUnitRuntimeRecord(base, 'plan-milestone', 'M010');
  assert.ok(runtime);
  assert.equal(runtime.phase, 'dispatched');
  assert.equal(runtime.lastProgressAt, startedAt);
  assert.equal(runtime.progressCount, 1);
  assert.equal(runtime.lastProgressKind, 'dispatch');
  assert.equal(runtime.recoveryAttempts, 0);
});

test('writeUnitRuntimeRecord keeps explicit recovery attempt fields', () => {
  const base = mkdtempSync(join(tmpdir(), 'gsd-auto-supervisor-'));
  const startedAt = 2234567890;

  writeUnitRuntimeRecord(base, 'research-milestone', 'M011', startedAt, {
    phase: 'timeout',
    recoveryAttempts: 2,
    lastRecoveryReason: 'idle',
    lastProgressAt: startedAt + 50,
    progressCount: 3,
    lastProgressKind: 'recovery-retry',
  });

  const runtime = JSON.parse(readFileSync(join(base, '.gsd/runtime/units/research-milestone-M011.json'), 'utf8'));
  assert.equal(runtime.recoveryAttempts, 2);
  assert.equal(runtime.lastRecoveryReason, 'idle');
  assert.equal(runtime.lastProgressKind, 'recovery-retry');
});
