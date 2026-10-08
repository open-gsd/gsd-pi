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
  let elapsed = 0;
  const waits = [];
  const logs = [];
  const metadata = { name: '@opengsd/test', version: '1.2.3', dist: { integrity }, 'dist-tags': { latest: '1.2.3' } };
  Object.assign(metadata, options.metadata);
  const npm = (args, cwd, timeout) => {
    calls.push(args);
    options.onCall?.(args, { elapsed, views, metadata, timeout, advance: ms => { elapsed += ms; } });
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
  return { calls, waits, logs, run: () => publishPackage({ directory: dir, version: '1.2.3', tag: 'latest', npm, now: () => elapsed, verificationTimeoutMs: options.timeoutMs ?? 1_200_000, wait: async ms => { waits.push(ms); elapsed += ms; }, log: line => logs.push(line) }) };
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

const registryError = code => Object.assign(new Error(code), { stdout: JSON.stringify({ error: { code } }) });

for (const kind of ['metadata', 'tarball', 'tag']) {
  test(`${kind} propagation beyond ten minutes eventually verifies without republishing`, async t => {
    const f = fixture(t, { fresh: true, onCall(args, { elapsed, views, metadata }) {
      if (kind === 'metadata' && args[0] === 'view' && views > 0 && elapsed < 660_000) throw registryError('E404');
      if (kind === 'tarball' && args[0] === 'pack' && args[1].startsWith('@') && elapsed < 660_000) throw registryError('E404');
      if (kind === 'tag') metadata['dist-tags'].latest = elapsed < 660_000 ? '1.2.2' : '1.2.3';
    } });
    assert.equal(await f.run(), 'published');
    assert.equal(f.calls.filter(a => a[0] === 'publish').length, 1);
    assert.ok(f.waits.reduce((a,b) => a+b, 0) >= 660_000);
    assert.ok(f.logs.some(line => /retry.*remaining/i.test(line)));
  });
}

for (const kind of ['metadata', 'tarball', 'tag']) {
  test(`${kind} propagation deadline is finite and never reports success`, async t => {
    const f = fixture(t, { fresh: true, timeoutMs: 12_000, onCall(args, { views, metadata }) {
      if (kind === 'metadata' && args[0] === 'view' && views > 0) throw registryError('E404');
      if (kind === 'tarball' && args[0] === 'pack' && args[1].startsWith('@')) throw registryError('E503');
      if (kind === 'tag') metadata['dist-tags'] = {};
    } });
    await assert.rejects(f.run(), /verification.*timed out/i);
    assert.deepEqual(f.waits, [5000, 7000]);
    assert.equal(f.calls.filter(a => a[0] === 'publish').length, 1);
  });
}

for (const code of ['E429', 'E500', 'E503', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN']) {
  test(`post-publication transient ${code} is retried`, async t => {
    let failed = false;
    const g = fixture(t, { fresh: true, onCall(args, { views }) {
      if (args[0] === 'view' && views === 1 && !failed) { failed = true; throw registryError(code); }
    } });
    assert.equal(await g.run(), 'published');
    assert.deepEqual(g.waits, [5000]);
  });
}

for (const code of ['E401', 'E403', 'EINTEGRITY']) {
  test(`post-publication ${code} is terminal`, async t => {
    const f = fixture(t, { fresh: true, afterPublishError: registryError(code) });
    await assert.rejects(f.run(), new RegExp(code));
    assert.deepEqual(f.waits, []);
  });
}

test('byte mismatch is terminal even while the requested tag is stale', async t => {
  const f = fixture(t, { fresh: true, remoteBytes: Buffer.from('wrong bytes'), metadata: { 'dist-tags': {} } });
  await assert.rejects(f.run(), /downloaded.*identity mismatch/i);
  assert.deepEqual(f.waits, []);
});

test('existing identical artifact waits for tag visibility without publication', async t => {
  const f = fixture(t, { onCall(args, { elapsed, metadata }) {
    metadata['dist-tags'].latest = elapsed < 15_000 ? '1.2.2' : '1.2.3';
  } });
  assert.equal(await f.run(), 'existing');
  assert.deepEqual(f.waits, [5000, 10000]);
  assert.equal(f.calls.filter(a => a[0] === 'publish').length, 0);
});

for (const timeoutMs of [0, -1, NaN, Infinity]) {
  test(`invalid verification deadline ${timeoutMs} fails before npm`, async t => {
    const f = fixture(t, { timeoutMs });
    await assert.rejects(f.run(), /timeout/i);
    assert.equal(f.calls.length, 0);
  });
}

test('slow verification calls share the deadline and receive the remaining budget', async t => {
  const budgets = [];
  const f = fixture(t, { fresh: true, timeoutMs: 12_000, onCall(args, { views, timeout, advance }) {
    if (args[0] === 'view' && views > 0) { budgets.push(timeout); advance(8000); }
    if (args[0] === 'pack' && args[1].startsWith('@')) { budgets.push(timeout); advance(4000); throw registryError('ETIMEDOUT'); }
  } });
  await assert.rejects(f.run(), /verification.*timed out/i);
  assert.deepEqual(budgets, [12000, 4000]);
  assert.deepEqual(f.waits, []);
});

test('post-publication missing integrity is terminal, not propagation', async t => {
  const f = fixture(t, { fresh: true, metadata: { dist: {} } });
  await assert.rejects(f.run(), /identity mismatch/i);
  assert.deepEqual(f.waits, []);
});
