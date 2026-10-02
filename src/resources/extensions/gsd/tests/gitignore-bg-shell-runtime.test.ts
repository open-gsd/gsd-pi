/**
 * Runtime regression — `.bg-shell/` baseline pattern (#4902, prior #2655).
 *
 * The deleted `gitignore-bg-shell.test.ts` asserted `.bg-shell/` appeared in
 * the BASELINE_PATTERNS array via source grep. This rewrite drives
 * `ensureGitignore()` against a tmp directory and asserts the written
 * `.gitignore` actually contains the `.bg-shell/` pattern — i.e. tests the
 * behaviour the constant exists to guarantee, not the spelling of the
 * constant.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ensureGitignore } from '../gitignore.ts';
import { captureVerificationSourceSnapshot } from '../verification-source-integrity.ts';

function makeTmpRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-gitignore-bg-'));
}

function cleanup(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* swallow */ }
}

describe('ensureGitignore writes .bg-shell/ baseline (#4902)', () => {
  test('appends .bg-shell/ to a fresh project .gitignore', () => {
    const dir = makeTmpRepo();
    try {
      const wrote = ensureGitignore(dir);
      assert.equal(wrote, true, 'ensureGitignore should report it wrote');

      const ignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8');
      const lines = new Set(
        ignore.split('\n').map((l) => l.trim()).filter(Boolean),
      );
      assert.ok(
        lines.has('.bg-shell/'),
        `.gitignore should include .bg-shell/. Got:\n${ignore}`,
      );
      assert.ok(
        lines.has('.gsd-backups/'),
        `.gitignore should include .gsd-backups/. Got:\n${ignore}`,
      );
    } finally {
      cleanup(dir);
    }
  });

  test('preserves .bg-shell/ when it is already present (idempotent)', () => {
    const dir = makeTmpRepo();
    try {
      fs.writeFileSync(
        path.join(dir, '.gitignore'),
        '.bg-shell/\nnode_modules/\n',
      );
      ensureGitignore(dir); // run once to fill missing baseline
      const ignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8');
      const occurrences = ignore.split('\n').filter((l) => l.trim() === '.bg-shell/').length;
      assert.equal(occurrences, 1, 'should not duplicate an existing .bg-shell/ entry');
    } finally {
      cleanup(dir);
    }
  });

  test('adds Windows reserved device-name patterns', () => {
    const dir = makeTmpRepo();
    try {
      ensureGitignore(dir);
      const ignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8');
      const lines = new Set(ignore.split('\n').map((l) => l.trim()).filter(Boolean));
      for (const pattern of ['nul', 'nul.*', 'con', 'con.*', 'prn', 'prn.*', 'aux', 'aux.*', 'com[1-9]', 'com[1-9].*', 'lpt[1-9]', 'lpt[1-9].*']) {
        assert.ok(lines.has(pattern), `missing Windows reserved pattern: ${pattern}`);
      }
    } finally {
      cleanup(dir);
    }
  });
});

describe('ensureGitignore writes .claude/settings.local.json baseline (#2509)', () => {
  test('appends .claude/settings.local.json to a fresh project .gitignore', (t) => {
    const dir = makeTmpRepo();
    t.after(() => cleanup(dir));

    const wrote = ensureGitignore(dir);
    assert.equal(wrote, true, 'ensureGitignore should report it wrote');

    const ignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8');
    const lines = new Set(ignore.split('\n').map((l) => l.trim()).filter(Boolean));
    assert.ok(
      lines.has('.claude/settings.local.json'),
      `.gitignore should include .claude/settings.local.json (workflow-MCP auto-prep writes it at startup). Got:\n${ignore}`,
    );
    // Same MCP-runtime class, both must stay covered together.
    assert.ok(
      lines.has('.mcp.json'),
      `.gitignore should include .mcp.json. Got:\n${ignore}`,
    );
  });

  test('preserves .claude/settings.local.json when it is already present (idempotent)', (t) => {
    const dir = makeTmpRepo();
    t.after(() => cleanup(dir));

    fs.writeFileSync(
      path.join(dir, '.gitignore'),
      '.claude/settings.local.json\nnode_modules/\n',
    );
    ensureGitignore(dir); // run once to fill missing baseline
    const ignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8');
    const occurrences = ignore.split('\n').filter((l) => l.trim() === '.claude/settings.local.json').length;
    assert.equal(occurrences, 1, 'should not duplicate an existing .claude/settings.local.json entry');
  });
});

/**
 * Hash-level regression for #2509: the ignored runtime file must actually
 * leave the fail-closed verification-source scope, while durable .claude/
 * content stays inside it.
 */
describe('.claude/settings.local.json stays out of the verification-source scope (#2509)', () => {
  function makeTmpGitRepo(): string {
    const dir = makeTmpRepo();
    git(dir, 'init');
    git(dir, 'config', 'user.email', 'test@test.com');
    git(dir, 'config', 'user.name', 'Test');
    return dir;
  }

  function git(dir: string, ...args: string[]): void {
    execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  }

  function revision(dir: string): string {
    const source = captureVerificationSourceSnapshot([{ id: 'project', cwd: dir }]);
    assert.equal(source.ok, true, source.ok ? undefined : source.error);
    return source.snapshot.aggregateRevision;
  }

  test('writing .claude/settings.local.json does not shift the source revision', (t) => {
    const dir = makeTmpGitRepo();
    t.after(() => cleanup(dir));

    // Hermetic scope: dev machines usually carry **/.claude/settings.local.json in
    // the user-global ignore (~/.config/git/ignore), which --exclude-standard reads
    // and which masks the regression locally. Hide the global config AND the XDG
    // ignore default so this test sees the CI/acceptance-bed scope — the
    // environment where the mismatch fired.
    const prevEnv = { global: process.env.GIT_CONFIG_GLOBAL, xdg: process.env.XDG_CONFIG_HOME };
    process.env.GIT_CONFIG_GLOBAL = os.devNull;
    process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-empty-xdg-'));
    t.after(() => {
      try { fs.rmSync(process.env.XDG_CONFIG_HOME as string, { recursive: true, force: true }); } catch { /* swallow */ }
      if (prevEnv.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = prevEnv.global;
      if (prevEnv.xdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevEnv.xdg;
    });

    ensureGitignore(dir);
    fs.writeFileSync(path.join(dir, 'src.ts'), 'export const answer = "ready";\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'init');

    const before = revision(dir);

    // Runtime file written by auto-prep at headless startup — must be invisible to the hash.
    fs.mkdirSync(path.join(dir, '.claude'));
    fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), '{"enabledMcpjsonServers":["gsd-workflow"]}\n');
    assert.equal(revision(dir), before, 'ignored runtime file must not shift the verification-source revision');

    // Control: durable untracked content must still shift it (the assertion is not vacuous).
    fs.writeFileSync(path.join(dir, 'untracked-source.ts'), 'export const extra = 1;\n');
    assert.notEqual(revision(dir), before, 'non-ignored untracked file must shift the revision');
  });
});
