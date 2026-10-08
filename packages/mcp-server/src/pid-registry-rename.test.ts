import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { registerMcpInstance } from './pid-registry.js';

interface RegistryRenameFixture {
  run: () => unknown;
  registry: string;
  snapshot: string;
  calls: () => number;
  root: string;
}

function fixture(
  platform: NodeJS.Platform,
  injected: (count: number) => NodeJS.ErrnoException | null,
  check: (context: RegistryRenameFixture) => void,
): void {
  const root = fs.mkdtempSync(join(tmpdir(), 'mcp-rename-regression-'));
  const project = join(root, 'project');
  fs.mkdirSync(project);
  const registry = join(root, 'mcp-instances.json');
  const snapshot = JSON.stringify({
    retained: { pid: 123, projectDir: 'retained', startedAt: '2020-01-01T00:00:00Z' },
  });
  fs.writeFileSync(registry, snapshot);
  const originalRename = fs.renameSync;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(originalPlatform);
  let calls = 0;
  try {
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform });
    fs.renameSync = (oldPath, newPath) => {
      calls++;
      const error = injected(calls);
      if (error) throw error;
      return originalRename(oldPath, newPath);
    };
    syncBuiltinESMExports();
    check({
      run: () => registerMcpInstance(project, registry),
      registry,
      snapshot,
      calls: () => calls,
      root,
    });
  } finally {
    fs.renameSync = originalRename;
    Object.defineProperty(process, 'platform', originalPlatform);
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function sharing(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`simulated ${code} rename contention`), { code });
}

for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
  test(`Windows ${code}: two transient failures commit a complete snapshot`, () => {
    fixture(
      'win32',
      (count) => (count <= 2 ? sharing(code) : null),
      ({ run, registry, calls }) => {
        assert.doesNotThrow(run);
        assert.equal(calls(), 3);
        const contents = JSON.parse(fs.readFileSync(registry, 'utf8'));
        assert.equal(Object.keys(contents).length, 2);
        assert.equal(contents.retained.projectDir, 'retained');
      },
    );
  });
}

test('Persistent Windows EPERM fails after ten attempts, preserves bytes and cleans owned temp', () => {
  const error = sharing('EPERM');
  fixture(
    'win32',
    () => error,
    ({ run, registry, snapshot, calls, root }) => {
      assert.throws(run, (value) => value === error);
      assert.equal(calls(), 10);
      assert.equal(fs.readFileSync(registry, 'utf8'), snapshot);
      assert.ok(!fs.readdirSync(root).some((name) => name.endsWith('.tmp')));
    },
  );
});

test('Windows permanent EIO is not retried or suppressed', () => {
  const error = sharing('EIO');
  fixture(
    'win32',
    () => error,
    ({ run, registry, snapshot, calls }) => {
      assert.throws(run, (value) => value === error);
      assert.equal(calls(), 1);
      assert.equal(fs.readFileSync(registry, 'utf8'), snapshot);
    },
  );
});

test('POSIX EPERM remains a permission failure without retries', () => {
  const error = sharing('EPERM');
  fixture(
    'darwin',
    () => error,
    ({ run, registry, snapshot, calls }) => {
      assert.throws(run, (value) => value === error);
      assert.equal(calls(), 1);
      assert.equal(fs.readFileSync(registry, 'utf8'), snapshot);
    },
  );
});
