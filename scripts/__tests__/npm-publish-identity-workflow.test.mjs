import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import YAML from 'yaml';

const workflow = YAML.parse(readFileSync('.github/workflows/npm-publish.yml', 'utf8'));
for (const job of ['prod-release', 'prerelease-publish']) {
  test(`${job} rejects a registry artifact with the same version and tag but different bytes`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'release-workflow-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'scripts'));
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@opengsd/gsd-pi', version: '1.2.3' }));
    for (const script of ['prepack-resolve-workspace.cjs', 'postpack-restore-workspace.cjs']) writeFileSync(join(dir, 'scripts', script), '');
    if (existsSync('scripts/publish-npm-package.mjs')) copyFileSync('scripts/publish-npm-package.mjs', join(dir, 'scripts/publish-npm-package.mjs'));
    writeFileSync(join(dir, 'bin/npm'), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === 'publish') { console.error('You cannot publish over the previously published versions'); process.exit(1); }
if (args[0] === 'view') {
  console.log(args.includes('--json') ? JSON.stringify({ name: '@opengsd/gsd-pi', version: '1.2.3', 'dist-tags': { latest: '1.2.3', dev: '1.2.3' }, dist: { integrity: 'sha512-stale' } }) : '1.2.3');
} else if (args[0] === 'pack') {
  fs.writeFileSync(path.join(args[args.indexOf('--pack-destination') + 1], 'package.tgz'), 'new artifact');
  console.log(JSON.stringify([{ filename: 'package.tgz', name: '@opengsd/gsd-pi', version: '1.2.3' }]));
} else if (args[0] !== 'install') process.exit(2);
`, { mode: 0o755 });
    const step = workflow.jobs[job].steps.find(s => s.name?.startsWith(job === 'prod-release' ? 'Publish release to npm' : 'Publish @'));
    const result = spawnSync('bash', ['-e', '-c', step.run], {
      cwd: dir, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, RELEASE_VERSION: '1.2.3', CHANNEL: 'dev' },
    });
    assert.notEqual(result.status, 0, `stale publication was accepted:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr + result.stdout, /identity mismatch/i);
  });
}

for (const kind of ['engine', 'workspace']) {
  test(`${kind} wrapper propagates identity failures`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'publish-wrapper-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'scripts/lib'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    const script = `publish-${kind === 'engine' ? 'engine' : 'workspace'}-packages.sh`;
    copyFileSync(`scripts/${script}`, join(dir, 'scripts', script));
    writeFileSync(join(dir, 'scripts/lib/npm-release-packages.cjs'), "console.log('@opengsd/a:packages/a\\n@opengsd/b:packages/b')");
    writeFileSync(join(dir, 'scripts/publish-npm-package.mjs'), [
      "import { appendFileSync } from 'node:fs';",
      "appendFileSync('calls.jsonl', JSON.stringify(process.argv.slice(2)) + '\\n');",
      "console.error('Artifact identity mismatch'); process.exit(1);",
    ].join('\n'));
    const result = spawnSync('bash', [join(dir, 'scripts', script)], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, TAG_FLAG: '--tag latest' },
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Artifact identity mismatch/);
    const calls = readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.length, kind === 'engine' ? 5 : 1);
    assert.ok(calls.every(call => call[1] === '1.2.3' && call[2] === 'latest'));
  });
}
