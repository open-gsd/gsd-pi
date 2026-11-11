import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The native authoring CLI must never open the developer's Gateway database,
// installed plugins, or credentials, even when its SDK version differs.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const state = mkdtempSync(join(tmpdir(), 'gsd-plugin-build-'));
try {
  const config = join(state, 'openclaw.json');
  writeFileSync(config, JSON.stringify({ plugins: { enabled: false } }));
  const cli = resolve(dirname(fileURLToPath(import.meta.resolve('openclaw'))), '../openclaw.mjs');
  const result = spawnSync(process.execPath, [cli, 'plugins', 'build', '--root', root, '--entry', './dist/index.js'], {
    cwd: root,
    stdio: 'inherit',
    env: {
      PATH: process.env.PATH,
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: state,
      USERPROFILE: state,
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: config,
      NO_COLOR: '1',
    },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(state, { recursive: true, force: true });
}
