#!/usr/bin/env node
// Pack once, publish those exact bytes, and require the registry artifact to
// match before accepting either a fresh publish or an idempotent retry.
// Callers must build and resolve workspace: dependencies before invoking this.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const registry = 'https://registry.npmjs.org/';
const sha512 = (file) => `sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}`;
function runNpm(args, cwd) {
  return execFileSync('npm', [...args, '--registry', registry], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300_000, maxBuffer: 16 * 1024 * 1024,
  });
}
function isNotFound(error) {
  // Only npm's structured E404 is absence. Auth, network and malformed responses
  // must never fall through to a publication attempt.
  try { return JSON.parse(String(error.stdout)).error?.code === 'E404'; }
  catch { return false; }
}
function packedFile(output, directory, name, version) {
  const entries = JSON.parse(output);
  if (!Array.isArray(entries) || entries.length !== 1) throw new Error('Expected exactly one npm tarball');
  const entry = entries[0];
  if (entry.name !== name || entry.version !== version || typeof entry.filename !== 'string' || basename(entry.filename) !== entry.filename) {
    throw new Error('Packed package identity does not match the intended release');
  }
  return join(directory, entry.filename);
}

export async function publishPackage({ directory, version, tag = 'latest', npm = runNpm,
  wait = (ms) => new Promise(r => setTimeout(r, ms)), log = console.log }) {
  directory = resolve(directory);
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  if (!version || manifest.version !== version || !manifest.name || manifest.private) {
    throw new Error('Package manifest does not match the intended release version or is private');
  }
  if (!/^[a-z][a-z0-9-]*$/.test(tag)) throw new Error(`Invalid release dist-tag: ${tag}`);
  const spec = `${manifest.name}@${version}`;
  const temp = mkdtempSync(join(tmpdir(), 'gsd-npm-publish-'));
  const view = () => JSON.parse(npm(['view', spec, '--json', '--prefer-online'], directory));
  try {
    // Keep tarballs outside the package directory so packing cannot include them.
    const tarball = packedFile(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', temp], directory), temp, manifest.name, version);
    const expected = sha512(tarball);
    const verify = (metadata) => {
      // gitHead and provenance identify different things and are not evidence of
      // byte identity. A single exact SHA-512 integrity plus downloaded bytes is.
      if (!metadata || Array.isArray(metadata) || metadata.name !== manifest.name || metadata.version !== version || metadata.dist?.integrity !== expected) {
        throw new Error(`Artifact identity mismatch for ${spec}: expected ${expected}, registry has ${JSON.stringify(metadata?.dist?.integrity)}. Refusing to reuse this version; cut a new release version.`);
      }
      if (metadata['dist-tags']?.[tag] !== version) {
        throw new Error(`Dist-tag @${tag} for ${spec} points to ${JSON.stringify(metadata['dist-tags']?.[tag])}; refusing to report publication success.`);
      }
      const remote = packedFile(npm(['pack', spec, '--ignore-scripts', '--json', '--prefer-online', '--pack-destination', temp], directory), temp, manifest.name, version);
      if (sha512(remote) !== expected) throw new Error(`Downloaded artifact identity mismatch for ${spec}`);
      log(`Verified ${spec} @${tag}: ${expected} (registry tarball bytes match).`);
    };

    let existing;
    try { existing = view(); }
    catch (error) { if (!isNotFound(error)) throw error; }
    if (existing !== undefined) {
      verify(existing);
      return 'existing';
    }

    let outcome = 'published';
    try { log(npm(['publish', tarball, '--ignore-scripts', '--access', 'public', '--tag', tag], directory)); }
    catch (error) {
      const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
      if (!/cannot publish over the previously published|You cannot publish over/.test(output)) throw error;
      outcome = 'existing';
      log(`${spec} was published concurrently; checking artifact identity.`);
    }

    // Retry registry read/propagation failures only. A visible identity mismatch
    // is terminal: waiting cannot turn an immutable npm version into our bytes.
    for (let attempt = 1; attempt <= 6; attempt++) {
      let metadata;
      try { metadata = view(); }
      catch (error) {
        if (attempt === 6) throw error;
        await wait(Math.min(5_000 * 2 ** (attempt - 1), 30_000));
        continue;
      }
      verify(metadata);
      return outcome;
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [directory, version, tag = 'latest'] = process.argv.slice(2);
  try {
    if (!directory || !version || process.argv.length > 5) throw new Error('Usage: node scripts/publish-npm-package.mjs <directory> <version> [tag]');
    await publishPackage({ directory, version, tag });
  } catch (error) {
    console.error(`::error::${error.message}`);
    if (error.stderr) console.error(String(error.stderr));
    process.exitCode = 1;
  }
}
