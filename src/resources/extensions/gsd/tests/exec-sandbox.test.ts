// Project/App: gsd-pi
// File Purpose: Regression tests for the context-mode gsd_exec sandbox.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getShellConfig } from '@gsd/pi-coding-agent';
import { closeDatabase, openDatabase } from '../gsd-db.ts';
import { EXEC_DEFAULTS, runExecSandbox, type ExecSandboxOptions } from '../exec-sandbox.ts';
import { buildExecOptions, executeGsdExec } from '../tools/exec-tool.ts';
import { isContextModeEnabled } from '../preferences-types.ts';
import { validatePreferences } from '../preferences-validation.ts';

function freshBase(): string {
  return mkdtempSync(join(tmpdir(), 'gsd-exec-test-'));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function baseOpts(base: string, overrides: Partial<ExecSandboxOptions> = {}): ExecSandboxOptions {
  return {
    baseDir: base,
    clamp_timeout_ms: EXEC_DEFAULTS.clampTimeoutMs,
    default_timeout_ms: 10_000,
    stdout_cap_bytes: 1_024,
    stderr_cap_bytes: 1_024,
    digest_chars: 120,
    env_allowlist: EXEC_DEFAULTS.envAllowlist,
    ...overrides,
  };
}

test('runExecSandbox: captures stdout, persists artifacts, returns digest', async () => {
  const base = freshBase();
  try {
    const result = await runExecSandbox(
      { runtime: 'bash', script: 'echo hello world' },
      baseOpts(base),
    );
    assert.equal(result.exit_code, 0);
    assert.equal(result.timed_out, false);
    assert.ok(result.digest.includes('hello world'), `digest should contain stdout: ${result.digest}`);
    assert.ok(result.stdout_path.startsWith(join(base, '.gsd', 'exec')), 'stdout path under .gsd/exec');
    assert.equal(readFileSync(result.stdout_path, 'utf-8').trim(), 'hello world');
    const meta = JSON.parse(readFileSync(result.meta_path, 'utf-8')) as Record<string, unknown>;
    assert.equal(meta.runtime, 'bash');
    assert.equal(meta.exit_code, 0);
  } finally {
    cleanup(base);
  }
});

test('runExecSandbox: bash runtime uses resolved shell config', async () => {
  const base = freshBase();
  try {
    const { shell } = getShellConfig();
    const result = await runExecSandbox(
      { runtime: 'bash', script: 'printf "%s" "$0"' },
      baseOpts(base),
    );
    assert.equal(result.exit_code, 0);
    assert.equal(readFileSync(result.stdout_path, 'utf-8'), shell);
  } finally {
    cleanup(base);
  }
});

test('runExecSandbox: persists optional request metadata', async () => {
  const base = freshBase();
  try {
    const result = await runExecSandbox(
      {
        runtime: 'bash',
        script: 'echo metadata-ok',
        metadata: { kind: 'uat_exec', intent: 'uat-artifact-check' },
      },
      baseOpts(base),
    );
    const meta = JSON.parse(readFileSync(result.meta_path, 'utf-8')) as Record<string, unknown>;
    assert.deepEqual(meta.metadata, { kind: 'uat_exec', intent: 'uat-artifact-check' });
  } finally {
    cleanup(base);
  }
});

test('runExecSandbox: enforces stdout cap and marks truncation', async () => {
  const base = freshBase();
  try {
    const result = await runExecSandbox(
      // Emit far more than the cap so truncation triggers.
      { runtime: 'bash', script: 'head -c 8000 /dev/urandom | base64' },
      baseOpts(base, { stdout_cap_bytes: 256 }),
    );
    assert.equal(result.stdout_truncated, true, 'should mark stdout truncated');
    assert.ok(result.stdout_bytes <= 256, `stdout_bytes within cap (got ${result.stdout_bytes})`);
    const stdout = readFileSync(result.stdout_path, 'utf-8');
    assert.ok(stdout.endsWith('[truncated: stdout cap reached]\n'), 'truncation marker appended');
  } finally {
    cleanup(base);
  }
});

test('runExecSandbox: enforces timeout and surfaces timed_out', async () => {
  const base = freshBase();
  try {
    const started = Date.now();
    const result = await runExecSandbox(
      { runtime: 'bash', script: 'sleep 10' },
      baseOpts(base, { default_timeout_ms: 150, clamp_timeout_ms: 150 }),
    );
    const elapsed = Date.now() - started;
    assert.equal(result.timed_out, true);
    assert.ok(elapsed < 5_000, `should return well before 10s (took ${elapsed}ms)`);
  } finally {
    cleanup(base);
  }
});

test('runExecSandbox: forwards only allowlisted env vars', async () => {
  const base = freshBase();
  try {
    const result = await runExecSandbox(
      { runtime: 'bash', script: 'echo PATH=$PATH BLOCKED=$GSD_TEST_BLOCKED_VALUE' },
      baseOpts(base, {
        env_allowlist: [],
        env: { PATH: '/usr/bin:/bin', HOME: '/tmp', GSD_TEST_BLOCKED_VALUE: 'blocked-value' },
      }),
    );
    const stdout = readFileSync(result.stdout_path, 'utf-8');
    assert.ok(stdout.includes('PATH=/usr/bin:/bin'), 'PATH forwarded');
    assert.ok(!stdout.includes('blocked-value'), 'non-allowlisted var blocked');
  } finally {
    cleanup(base);
  }
});

test('runExecSandbox: node runtime executes JS', async () => {
  const base = freshBase();
  try {
    const result = await runExecSandbox(
      { runtime: 'node', script: 'console.log("node-ok:" + (1+2))' },
      baseOpts(base),
    );
    assert.equal(result.exit_code, 0);
    assert.ok(result.digest.includes('node-ok:3'));
  } finally {
    cleanup(base);
  }
});

test('runExecSandbox: node runtime forwards NODE_PATH for GSD-installed dependencies', async () => {
  const base = freshBase();
  try {
    const dependencyRoot = join(base, 'parent-node_modules');
    const packageDir = join(dependencyRoot, 'fake-gsd-dep');
    const worktree = join(base, 'project', '.gsd', 'worktrees', 'M003');
    mkdirSync(packageDir, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({ name: 'fake-gsd-dep', version: '1.0.0', main: 'index.js' }),
    );
    writeFileSync(join(packageDir, 'index.js'), "module.exports = 'resolved-via-node-path';\n");

    const result = await runExecSandbox(
      { runtime: 'node', script: "console.log(require('fake-gsd-dep'))" },
      baseOpts(worktree, {
        env: {
          PATH: '/usr/bin:/bin',
          HOME: '/tmp',
          NODE_PATH: dependencyRoot,
        },
      }),
    );

    assert.equal(result.exit_code, 0, readFileSync(result.stderr_path, 'utf-8'));
    assert.ok(result.digest.includes('resolved-via-node-path'));
  } finally {
    cleanup(base);
  }
});

test('runExecSandbox: rewrites NUL redirects for bash on Windows', async () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const base = freshBase();
  try {
    const result = await runExecSandbox(
      { runtime: 'bash', script: 'echo should-not-create-file > NUL' },
      baseOpts(base),
    );
    assert.equal(result.exit_code, 0);
    assert.equal(existsSync(join(base, 'NUL')), false, 'must not materialize a literal NUL file');
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    cleanup(base);
  }
});

// ── exec-tool executor ────────────────────────────────────────────────────

test('executeGsdExec: runs by default when context_mode is unset', async () => {
  const base = freshBase();
  try {
    const result = await executeGsdExec(
      { runtime: 'bash', script: 'echo default-on-run' },
      { baseDir: base, preferences: {} },
    );
    assert.ok(!result.isError, 'should succeed with no preferences');
    assert.equal(result.details.operation, 'gsd_exec');
    assert.equal(result.details.exit_code, 0);
    assert.ok(result.content[0].text.includes('default-on-run'));
  } finally {
    cleanup(base);
  }
});

test('executeGsdExec: runs when preferences is null (fresh project)', async () => {
  const base = freshBase();
  try {
    const result = await executeGsdExec(
      { runtime: 'bash', script: 'echo null-prefs-run' },
      { baseDir: base, preferences: null },
    );
    assert.ok(!result.isError, 'null preferences should not disable');
    assert.ok(result.content[0].text.includes('null-prefs-run'));
  } finally {
    cleanup(base);
  }
});

test('executeGsdExec: blocked only when context_mode.enabled=false', async () => {
  const base = freshBase();
  try {
    const result = await executeGsdExec(
      { runtime: 'bash', script: 'echo should-not-run' },
      { baseDir: base, preferences: { context_mode: { enabled: false } } },
    );
    assert.equal(result.isError, true);
    assert.equal((result.details as { error?: string }).error, 'context_mode_disabled');
  } finally {
    cleanup(base);
  }
});

test('executeGsdExec: runs when enabled explicitly set to true', async () => {
  const base = freshBase();
  try {
    const result = await executeGsdExec(
      { runtime: 'bash', script: 'echo explicit-on' },
      { baseDir: base, preferences: { context_mode: { enabled: true } } },
    );
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes('explicit-on'));
  } finally {
    cleanup(base);
  }
});

test('executeGsdExec: forwards custom exec_env_allowlist from preferences', async () => {
  const base = freshBase();
  try {
    const result = await executeGsdExec(
      {
        runtime: 'bash',
        script: 'printf "allowed=%s blocked=%s\\n" "$GSD_ALLOWED" "$GSD_BLOCKED"',
      },
      {
        baseDir: base,
        preferences: {
          context_mode: {
            enabled: true,
            exec_env_allowlist: ['GSD_ALLOWED'],
          },
        },
        env: {
          PATH: '/usr/bin:/bin',
          HOME: '/tmp',
          GSD_ALLOWED: 'yes',
          GSD_BLOCKED: 'no',
        },
      },
    );
    assert.ok(!result.isError);
    assert.match(result.content[0].text, /allowed=yes blocked=/);
    assert.doesNotMatch(result.content[0].text, /blocked=no/);
  } finally {
    cleanup(base);
  }
});

test('executeGsdExec: enforces per-call timeout override end-to-end', async () => {
  const base = freshBase();
  try {
    const result = await executeGsdExec(
      { runtime: 'bash', script: 'sleep 2', timeout_ms: 1 },
      { baseDir: base, preferences: { context_mode: { enabled: true, exec_timeout_ms: 10_000 } } },
    );
    assert.equal(result.details.timed_out, true);
    assert.equal(result.isError, true);
  } finally {
    cleanup(base);
  }
});

test('executeGsdExec: defaults to bash and accepts command alias', async () => {
  const base = freshBase();
  try {
    const result = await executeGsdExec(
      { command: 'echo command-alias-defaults-to-bash' },
      { baseDir: base, preferences: { context_mode: { enabled: true } } },
    );
    assert.equal(result.isError, false);
    assert.equal(result.details.runtime, 'bash');
    assert.ok(result.content[0].text.includes('command-alias-defaults-to-bash'));
  } finally {
    cleanup(base);
  }
});

test('executeGsdExec: accepts common runtime aliases', async () => {
  const base = freshBase();
  try {
    const result = await executeGsdExec(
      { runtime: 'js', code: 'console.log("runtime-alias-node")' },
      { baseDir: base, preferences: { context_mode: { enabled: true } } },
    );
    assert.equal(result.isError, false);
    assert.equal(result.details.runtime, 'node');
    assert.ok(result.content[0].text.includes('runtime-alias-node'));
  } finally {
    cleanup(base);
  }
});

test('executeGsdExec: rejects empty script', async () => {
  const base = freshBase();
  try {
    const result = await executeGsdExec(
      { runtime: 'bash', script: '   ' },
      { baseDir: base, preferences: { context_mode: { enabled: true } } },
    );
    assert.equal(result.isError, true);
    assert.equal((result.details as { error?: string }).error, 'invalid_params');
  } finally {
    cleanup(base);
  }
});

test('executeGsdExec: rejects original-root scripts from milestone worktrees', async () => {
  const base = freshBase();
  try {
    const originalRoot = join(base, 'project');
    const worktree = join(originalRoot, '.gsd', 'worktrees', 'M004');
    mkdirSync(worktree, { recursive: true });

    const result = await executeGsdExec(
      { runtime: 'bash', script: `cd ${originalRoot} && node todo.js --help` },
      { baseDir: worktree, preferences: { context_mode: { enabled: true } } },
    );

    assert.equal(result.isError, true);
    assert.equal((result.details as { error?: string }).error, 'invalid_params');
    assert.match(
      (result.details as { detail?: string }).detail ?? '',
      /original project root/,
    );
  } finally {
    cleanup(base);
  }
});

test('executeGsdExec: rejects macOS /var alias of original root from milestone worktrees', async () => {
  const originalRoot = '/var/folders/example/project';
  const realpathedWorktree = '/private/var/folders/example/project/.gsd/worktrees/M004';

  const result = await executeGsdExec(
    { runtime: 'bash', script: `cd ${originalRoot} && node todo.js --help` },
    { baseDir: realpathedWorktree, preferences: { context_mode: { enabled: true } } },
  );

  assert.equal(result.isError, true);
  assert.equal((result.details as { error?: string }).error, 'invalid_params');
  assert.match(
    (result.details as { detail?: string }).detail ?? '',
    /original project root/,
  );
});

test('executeGsdExec: rejects original-root traversal after shell boolean operators', async () => {
  const base = freshBase();
  try {
    const originalRoot = join(base, 'project');
    const worktree = join(originalRoot, '.gsd', 'worktrees', 'M004');
    mkdirSync(worktree, { recursive: true });

    const scripts = [
      'echo hi && cd ../../.. && pwd',
      'true || cd ../../..',
    ];

    for (const script of scripts) {
      const result = await executeGsdExec(
        { runtime: 'bash', script },
        { baseDir: worktree, preferences: { context_mode: { enabled: true } } },
      );
      assert.equal(result.isError, true);
      assert.equal((result.details as { error?: string }).error, 'invalid_params');
      assert.match((result.details as { detail?: string }).detail ?? '', /original project root/);
    }
  } finally {
    cleanup(base);
  }
});

test('executeGsdExec: allows active worktree paths from milestone worktrees', async () => {
  const base = freshBase();
  try {
    const originalRoot = join(base, 'project');
    const worktree = join(originalRoot, '.gsd', 'worktrees', 'M004');
    mkdirSync(worktree, { recursive: true });

    const result = await executeGsdExec(
      { runtime: 'bash', script: `cd ${worktree} && pwd` },
      { baseDir: worktree, preferences: { context_mode: { enabled: true } } },
    );

    assert.equal(result.isError, false);
    assert.equal(result.details.exit_code, 0);
  } finally {
    cleanup(base);
  }
});

test('executeGsdExec: rejects relative traversal to original root from milestone worktree', async () => {
  const base = freshBase();
  try {
    const originalRoot = join(base, 'project');
    const worktree = join(originalRoot, '.gsd', 'worktrees', 'M004');
    mkdirSync(worktree, { recursive: true });

    const scripts = [
      'cd ../../.. && pwd',
      "node -e \"process.chdir('../../..'); console.log(process.cwd())\"",
      "node -e \"const p = require('node:path'); process.chdir(p.join(process.cwd(), '../../..')); console.log(process.cwd())\"",
    ];

    for (const script of scripts) {
      const result = await executeGsdExec(
        { runtime: 'bash', script },
        { baseDir: worktree, preferences: { context_mode: { enabled: true } } },
      );
      assert.equal(result.isError, true, `expected script to be rejected: ${script}`);
      assert.equal((result.details as { error?: string }).error, 'invalid_params');
      assert.match((result.details as { detail?: string }).detail ?? '', /original project root/);
    }
  } finally {
    cleanup(base);
  }
});

test('validatePreferences: rejects invalid context_mode preference values', () => {
  const result = validatePreferences({
    context_mode: {
      enabled: 'false',
      exec_timeout_ms: 999,
      exec_stdout_cap_bytes: 1,
      exec_digest_chars: -1,
      exec_env_allowlist: ['GOOD_NAME', 'bad-name'],
    },
  } as any);
  assert.ok(result.errors.length > 0);
  assert.ok(result.errors.includes('context_mode.enabled must be a boolean'));
  assert.ok(result.errors.includes('context_mode.exec_timeout_ms must be a number between 1000 and 3600000'));
  assert.ok(result.errors.includes('context_mode.exec_stdout_cap_bytes must be a number between 4096 and 16777216'));
  assert.ok(result.errors.includes('context_mode.exec_digest_chars must be a number between 0 and 4000'));
  assert.ok(result.errors.includes('context_mode.exec_env_allowlist must be an array of valid env var names'));
});

test('validatePreferences: accepts context_mode.exec_timeout_ms up to the one-hour ceiling (issue #2981)', () => {
  const accepted = validatePreferences({
    context_mode: { enabled: true, exec_timeout_ms: 3_600_000 },
  } as any);
  assert.deepEqual(accepted.errors, [], 'exactly one hour must validate');

  const rejected = validatePreferences({
    context_mode: { enabled: true, exec_timeout_ms: 3_600_001 },
  } as any);
  assert.ok(
    rejected.errors.includes('context_mode.exec_timeout_ms must be a number between 1000 and 3600000'),
    'above one hour must be rejected',
  );
});

test('isContextModeEnabled: defaults to true; only explicit false disables', () => {
  assert.equal(isContextModeEnabled(undefined), true, 'undefined prefs → on');
  assert.equal(isContextModeEnabled(null), true, 'null prefs → on');
  assert.equal(isContextModeEnabled({}), true, 'empty prefs → on');
  assert.equal(isContextModeEnabled({ context_mode: {} }), true, 'empty block → on');
  assert.equal(isContextModeEnabled({ context_mode: { enabled: true } }), true);
  assert.equal(isContextModeEnabled({ context_mode: { enabled: false } }), false);
});

test('buildExecOptions: defaults to verification timeout and honors exec override', () => {
  const defaulted = buildExecOptions('/tmp/base', null);
  assert.equal(defaulted.default_timeout_ms, 120_000);

  const inherited = buildExecOptions('/tmp/base', {
    verification_timeout_ms: 345_678,
    context_mode: { enabled: true },
  });
  assert.equal(inherited.default_timeout_ms, 345_678);

  const overridden = buildExecOptions('/tmp/base', {
    verification_timeout_ms: 345_678,
    context_mode: { enabled: true, exec_timeout_ms: 234_567 },
  });
  assert.equal(overridden.default_timeout_ms, 234_567);
});

test('buildExecOptions: clamps out-of-range values to safe defaults', () => {
  const opts = buildExecOptions('/tmp/base', {
    context_mode: {
      enabled: true,
      exec_timeout_ms: 999_999_999,
      exec_stdout_cap_bytes: 1,
      exec_digest_chars: -20,
    },
  });
  assert.equal(opts.default_timeout_ms, EXEC_DEFAULTS.clampTimeoutMs, 'timeout clamped to upper bound');
  assert.equal(opts.stdout_cap_bytes, 4_096, 'stdout cap clamped to floor');
  assert.equal(opts.digest_chars, 0, 'digest chars clamped to floor');
});

// ── Failed-execution stderr diagnostics (issue #2927) ────────────────────────

test('runExecSandbox: failed run with both streams keeps the stdout digest and adds a labeled bounded stderr excerpt', async (t) => {
  const base = freshBase();
  t.after(() => cleanup(base));
  const result = await runExecSandbox(
    { runtime: 'bash', script: 'echo partial-progress; echo "boom: real cause" >&2; exit 3' },
    baseOpts(base),
  );
  assert.equal(result.exit_code, 3);
  assert.ok(result.digest.includes('partial-progress'), `stdout must not be discarded: ${result.digest}`);
  assert.ok(result.stderr_excerpt, 'failed run with captured stderr should carry an excerpt');
  assert.ok(result.stderr_excerpt!.includes('boom: real cause'), `excerpt carries the failure diagnostics: ${result.stderr_excerpt}`);
  assert.notEqual(result.stderr_excerpt, result.digest, 'streams stay separate');
  // Full streams remain persisted under their original paths.
  assert.ok(readFileSync(result.stderr_path, 'utf-8').includes('boom: real cause'));
  assert.ok(readFileSync(result.stdout_path, 'utf-8').includes('partial-progress'));
});

test('runExecSandbox: success with stderr stays success and carries no excerpt', async (t) => {
  const base = freshBase();
  t.after(() => cleanup(base));
  const result = await runExecSandbox(
    { runtime: 'bash', script: 'echo fine; echo noisy-but-nonfatal >&2' },
    baseOpts(base),
  );
  assert.equal(result.exit_code, 0);
  assert.equal(result.stderr_excerpt, undefined, 'nonempty stderr is not failure by itself');
  assert.ok(result.digest.includes('fine'));
});

test('runExecSandbox: failed run with empty stdout keeps its marker digest and no duplicate excerpt', async (t) => {
  const base = freshBase();
  t.after(() => cleanup(base));
  const result = await runExecSandbox(
    { runtime: 'bash', script: 'echo "only stderr" >&2; exit 1' },
    baseOpts(base),
  );
  assert.equal(result.exit_code, 1);
  assert.ok(result.digest.startsWith('[no stdout — tail of stderr]'), `existing marker preserved: ${result.digest}`);
  assert.ok(result.digest.includes('only stderr'));
  assert.equal(result.stderr_excerpt, undefined, 'stderr already exposed via the labeled marker');
});

test('runExecSandbox: failed run with empty stderr has no excerpt', async (t) => {
  const base = freshBase();
  t.after(() => cleanup(base));
  const result = await runExecSandbox(
    { runtime: 'bash', script: 'echo out; exit 1' },
    baseOpts(base),
  );
  assert.equal(result.exit_code, 1);
  assert.equal(result.stderr_excerpt, undefined);
  assert.ok(result.digest.includes('out'));
});

test('runExecSandbox: stderr excerpt is bounded by the digest budget', async (t) => {
  const base = freshBase();
  t.after(() => cleanup(base));
  const longErr = Array.from({ length: 40 }, (_, i) => `err line ${i}`).join('\n');
  const result = await runExecSandbox(
    { runtime: 'bash', script: `echo out; cat >&2 <<'EOT'\n${longErr}\nEOT\nexit 1` },
    baseOpts(base, { digest_chars: 30 }),
  );
  assert.equal(result.exit_code, 1);
  assert.ok(result.stderr_excerpt, 'excerpt present');
  assert.ok(result.stderr_excerpt!.length <= 30, `excerpt bounded to digest_chars (got ${result.stderr_excerpt!.length})`);
  assert.ok(result.stderr_excerpt!.trimEnd().endsWith('err line 39'), 'excerpt is the tail');
});

test('runExecSandbox: timeout with both streams surfaces the excerpt', async (t) => {
  const base = freshBase();
  t.after(() => cleanup(base));
  const result = await runExecSandbox(
    { runtime: 'bash', script: 'echo before-timeout; echo killed-mid-flight >&2; sleep 30' },
    baseOpts(base, { default_timeout_ms: 300, clamp_timeout_ms: 300 }),
  );
  assert.equal(result.timed_out, true);
  assert.ok(result.digest.includes('before-timeout'), `stdout preserved on timeout: ${result.digest}`);
  assert.ok(result.stderr_excerpt!.includes('killed-mid-flight'), `timeout diagnostics surfaced: ${result.stderr_excerpt}`);
});

test('runExecSandbox: stderr-only timeout surfaces the excerpt the marker digest lacks', async (t) => {
  const base = freshBase();
  t.after(() => cleanup(base));
  const result = await runExecSandbox(
    { runtime: 'bash', script: 'echo "connection refused" >&2; sleep 30' },
    baseOpts(base, { default_timeout_ms: 300, clamp_timeout_ms: 300 }),
  );
  assert.equal(result.timed_out, true);
  assert.equal(result.digest, '[no stdout — timed out]', 'marker preserved');
  assert.ok(result.stderr_excerpt!.includes('connection refused'), `timeout diagnostics surfaced: ${result.stderr_excerpt}`);
});

test('executeGsdExec: failed run exposes the stderr section in content and details and records despite lost output', async (t) => {
  const base = freshBase();
  // A workflow database must exist for the run to be recordable at all; the
  // deleted stdout file makes the recorded hash unverifiable while the run
  // itself fails with stderr diagnostics.
  mkdirSync(join(base, '.gsd'), { recursive: true });
  openDatabase(join(base, '.gsd', 'gsd.db'));
  t.after(() => {
    closeDatabase();
    cleanup(base);
  });
  const result = await executeGsdExec(
    { runtime: 'bash', script: 'echo partial; echo "real cause" >&2; exit 2' },
    {
      baseDir: base,
      preferences: null,
      run: async (request, options) => {
        const ran = await runExecSandbox(request, options);
        rmSync(ran.stdout_path);
        return ran;
      },
    },
  );
  assert.equal(result.isError, true);
  const text = result.content[0]!.text;
  assert.ok(text.includes('--- digest ---'), 'digest section present');
  assert.ok(text.includes('--- stderr (tail) ---'), 'labeled stderr section present');
  assert.ok(text.includes('real cause'), 'stderr diagnostics visible');
  assert.ok(text.includes('partial'), 'stdout preserved');
  assert.ok(typeof result.details.stderr_excerpt === 'string' && result.details.stderr_excerpt.includes('real cause'), `details.stderr_excerpt present: ${String(result.details.stderr_excerpt)}`);
  assert.ok(result.details.id, 'the run is recorded with an id');
  assert.equal(result.details.run_not_recorded, undefined, 'the observation is recorded despite lost output');
});

test('executeGsdExec: successful run with stderr exposes no stderr section', async (t) => {
  const base = freshBase();
  t.after(() => cleanup(base));
  const result = await executeGsdExec(
    { runtime: 'bash', script: 'echo ok; echo stderr-noise >&2' },
    { baseDir: base, preferences: {} },
  );
  assert.equal(result.isError, false);
  const text = result.content[0]!.text;
  assert.ok(!text.includes('--- stderr (tail) ---'), 'success keeps a stdout-only preview');
  assert.equal(result.details.stderr_excerpt, undefined);
  assert.ok(text.includes('--- digest ---'));
});

test('runExecSandbox: stderr-only cancellation surfaces the excerpt alongside the abort marker', async (t) => {
  const base = freshBase();
  t.after(() => cleanup(base));
  const controller = new AbortController();
  const resultP = runExecSandbox(
    { runtime: 'bash', script: 'echo "cancelled mid-write" >&2; sleep 30' },
    baseOpts(base, { signal: controller.signal }),
  );
  setTimeout(() => controller.abort(), 250);
  const result = await resultP;
  assert.equal(result.aborted, true);
  assert.equal(result.digest, '[no stdout — aborted]', 'abort marker preserved');
  assert.ok(result.stderr_excerpt!.includes('cancelled mid-write'), `cancellation diagnostics surfaced: ${result.stderr_excerpt}`);
});

test('runExecSandbox: zero digest budget disables the excerpt along with the preview', async (t) => {
  const base = freshBase();
  t.after(() => cleanup(base));
  const result = await runExecSandbox(
    { runtime: 'bash', script: 'echo out; echo err >&2; exit 1' },
    baseOpts(base, { digest_chars: 0 }),
  );
  assert.equal(result.exit_code, 1);
  assert.equal(result.stderr_excerpt, undefined, 'excerpt disabled with the digest budget');
});
