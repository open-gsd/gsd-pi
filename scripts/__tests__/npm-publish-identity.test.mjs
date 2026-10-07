import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { publishPackage } from '../publish-npm-package.mjs';

const bytes = Buffer.from('the release artifact');
const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'npm-identity-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@opengsd/test', version: '1.2.3' }));
  const calls = [];
  let views = 0;
  const metadata = { name: '@opengsd/test', version: '1.2.3', dist: { integrity }, 'dist-tags': { latest: '1.2.3' } };
  Object.assign(metadata, options.metadata);
  const npm = (args) => {
    calls.push(args);
    if (args[0] === 'pack') {
      const destination = args[args.indexOf('--pack-destination') + 1];
      writeFileSync(join(destination, 'test-1.2.3.tgz'), args[1] === '@opengsd/test@1.2.3' ? (options.remoteBytes ?? bytes) : bytes);
      return JSON.stringify([{ name: metadata.name, version: '1.2.3', filename: 'test-1.2.3.tgz' }]);
    }
    if (args[0] === 'view') {
      views++;
      if (options.viewError) throw options.viewError;
      if (options.fresh && views === 1) throw Object.assign(new Error('not found'), { stdout: JSON.stringify({ error: { code: 'E404' } }) });
      if (options.afterPublishError && views > 1) throw options.afterPublishError;
      return JSON.stringify(metadata);
    }
    if (args[0] === 'publish') {
      if (options.publishError) throw options.publishError;
      return '+ @opengsd/test@1.2.3';
    }
    throw new Error(`Unexpected npm command: ${args}`);
  };
  return { calls, run: () => publishPackage({ directory: dir, version: '1.2.3', tag: 'latest', npm, wait: async () => {}, log: () => {} }) };
}

test('same version and latest tag cannot conceal a different artifact', async (t) => {
  const f = fixture(t, { metadata: { dist: { integrity: 'sha512-old-artifact' } } });
  await assert.rejects(f.run(), /identity mismatch/i);
  assert.equal(f.calls.filter(a => a[0] === 'publish').length, 0);
});

test('identical artifact retry succeeds without provenance or gitHead', async (t) => {
  const f = fixture(t);
  assert.equal(await f.run(), 'existing');
  assert.equal(f.calls.filter(a => a[0] === 'publish').length, 0);
});

for (const dist of [undefined, {}, { shasum: 'legacy-only' }, { integrity: ['sha512-ambiguous'] }]) {
  test(`missing or ambiguous strong integrity fails closed: ${JSON.stringify(dist)}`, async (t) => {
    await assert.rejects(fixture(t, { metadata: { dist, gitHead: 'expected-commit', _attestations: { source: 'expected-commit' } } }).run(), /identity mismatch/i);
  });
}

test('matching integrity metadata cannot conceal different downloaded bytes', async (t) => {
  await assert.rejects(fixture(t, { remoteBytes: Buffer.from('old bytes') }).run(), /downloaded.*identity mismatch/i);
});

test('matching artifact still requires the requested dist-tag', async (t) => {
  await assert.rejects(fixture(t, { metadata: { 'dist-tags': { latest: '1.2.2' } } }).run(), /dist-tag/i);
});

for (const code of ['E401', 'E403', 'E429', 'E500', 'ENOTFOUND']) {
  test(`registry ${code} is not absence and cannot initiate publication`, async (t) => {
    const f = fixture(t, { viewError: Object.assign(new Error(code), { stdout: JSON.stringify({ error: { code } }) }) });
    await assert.rejects(f.run(), new RegExp(code));
    assert.equal(f.calls.filter(a => a[0] === 'publish').length, 0);
  });
}

test('fresh publication sends the packed tarball and verifies the resulting artifact', async (t) => {
  const f = fixture(t, { fresh: true });
  assert.equal(await f.run(), 'published');
  const published = f.calls.find(a => a[0] === 'publish');
  assert.ok(published[1].endsWith('.tgz'));
  assert.ok(published.includes('--ignore-scripts'));
  assert.equal(f.calls.filter(a => a[0] === 'pack').length, 2);
});

for (const mismatch of [false, true]) {
  test(`concurrent publication verifies identity (mismatch=${mismatch})`, async (t) => {
    const f = fixture(t, { fresh: true, publishError: Object.assign(new Error('publish failed'), { stderr: 'npm error You cannot publish over the previously published versions' }), ...(mismatch ? { metadata: { dist: { integrity: 'sha512-old-artifact' } } } : {}) });
    if (mismatch) await assert.rejects(f.run(), /identity mismatch/i);
    else assert.equal(await f.run(), 'existing');
  });
}

test('successful publish response cannot conceal registry verification failure', async (t) => {
  const f = fixture(t, { fresh: true, afterPublishError: new Error('registry unavailable') });
  await assert.rejects(f.run(), /registry unavailable/);
});

test('successful publish response cannot conceal an old artifact', async (t) => {
  await assert.rejects(fixture(t, { fresh: true, metadata: { dist: { integrity: 'sha512-old-artifact' } } }).run(), /identity mismatch/i);
});

test('unrelated publish failure is never reported as success', async (t) => {
  await assert.rejects(fixture(t, { fresh: true, publishError: new Error('E403 credentials rejected') }).run(), /credentials rejected/);
});

test('source metadata never overrides byte identity', async (t) => {
  const f = fixture(t, { metadata: { gitHead: 'different-head', _attestations: [{ source: 'different-source' }, { source: 'ambiguous-source' }] } });
  assert.equal(await f.run(), 'existing');
});

test('mismatched manifest version fails before contacting npm', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'npm-version-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@opengsd/test', version: '1.2.2' }));
  await assert.rejects(publishPackage({ directory: dir, version: '1.2.3', npm: () => assert.fail('npm must not run') }), /manifest/);
});

test('real npm pack bytes remain identical across the fresh-publish and retry paths', async (t) => {
  const { execFileSync } = await import('node:child_process');
  const { readFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'npm-real-pack-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@opengsd/identity-fixture', version: '1.2.3', files: ['payload.txt'], scripts: { prepack: 'exit 99', postpack: 'exit 99', prepublishOnly: 'exit 99' } }));
  writeFileSync(join(dir, 'payload.txt'), 'built release');
  let published;
  let publishes = 0;
  const npm = (args, cwd) => {
    if (args[0] === 'view') {
      if (!published) throw Object.assign(new Error('absent'), { stdout: '{"error":{"code":"E404"}}' });
      return JSON.stringify({ name: '@opengsd/identity-fixture', version: '1.2.3', 'dist-tags': { latest: '1.2.3' }, dist: { integrity: `sha512-${createHash('sha512').update(published).digest('base64')}` } });
    }
    if (args[0] === 'publish') {
      assert.ok(args.includes('--ignore-scripts'));
      published = readFileSync(args[1]);
      publishes++;
      return 'accepted by fixture registry';
    }
    if (args[1] === '@opengsd/identity-fixture@1.2.3') {
      const destination = args[args.indexOf('--pack-destination') + 1];
      writeFileSync(join(destination, 'fixture.tgz'), published);
      return JSON.stringify([{ name: '@opengsd/identity-fixture', version: '1.2.3', filename: 'fixture.tgz' }]);
    }
    return execFileSync('npm', [...args, '--offline', '--cache', join(dir, 'cache')], { cwd, encoding: 'utf8' });
  };
  const options = { directory: dir, version: '1.2.3', npm, log: () => {} };
  assert.equal(await publishPackage(options), 'published');
  assert.equal(await publishPackage(options), 'existing');
  assert.equal(publishes, 1);
});
