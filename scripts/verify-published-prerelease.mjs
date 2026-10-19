#!/usr/bin/env node
// Authenticate an existing npm artifact for release verification. This never
// publishes and cannot establish equality to an unavailable original tarball.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = 'open-gsd/gsd-pi';
const workflow = '.github/workflows/npm-publish.yml';
const repository = `https://github.com/${repo}`;
const identity = `${repository}/${workflow}@refs/heads/main`;
const predicateType = 'https://slsa.dev/provenance/v1';
const name = '@opengsd/gsd-pi';

export function originalPublication(run, logs, source) {
  assert.match(source, /^[a-f0-9]{40}$/);
  assert.equal(run.repository.full_name, repo);
  assert.equal(run.path, workflow);
  assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.head_branch, 'main');
  assert.equal(run.head_sha, source, 'Original source must still be current main');
  assert.equal(run.status, 'completed');
  assert.equal(run.run_attempt, 1, 'Recovery requires unambiguous original attempt 1');
  const checkout = [...logs.matchAll(/git log -1 --format=%H\r?\n[^\n]*?\b([a-f0-9]{40})\b/g)];
  assert.equal(checkout.length, 1, 'Expected one original checkout SHA');
  assert.equal(checkout[0][1], source, 'Actual checkout differs from workflow source');
  const stamps = [...logs.matchAll(/Stamped version: (\d+\.\d+\.\d+-dev\.([a-f0-9]{7,40}))\b/g)];
  assert.equal(stamps.length, 1, 'Expected one original stamped dev version');
  assert.ok(source.startsWith(stamps[0][2]), 'Version suffix differs from source');
  return stamps[0][1];
}

export function verifyEvidence({ metadata, bytes, verified, source, version, runId }) {
  assert.equal(metadata.name, name);
  assert.equal(metadata.version, version);
  const digest = createHash('sha512').update(bytes).digest();
  const integrity = `sha512-${digest.toString('base64')}`;
  assert.equal(metadata.dist?.integrity, integrity, 'Downloaded bytes differ from registry integrity');
  assert.equal(verified.length, 1, 'Expected exactly one verified provenance statement');
  const result = verified[0].verificationResult;
  const cert = result.signature.certificate;
  assert.equal(cert.issuer, 'https://token.actions.githubusercontent.com');
  assert.equal(cert.subjectAlternativeName, identity);
  assert.equal(cert.sourceRepositoryURI, repository);
  assert.equal(cert.sourceRepositoryDigest, source);
  assert.equal(cert.sourceRepositoryRef, 'refs/heads/main');
  assert.equal(cert.runnerEnvironment, 'github-hosted');
  const invocation = `${repository}/actions/runs/${runId}/attempts/1`;
  assert.equal(cert.runInvocationURI, invocation);
  const statement = result.statement;
  assert.equal(statement.predicateType, predicateType);
  assert.deepEqual(statement.subject, [{ name: `pkg:npm/%40opengsd/gsd-pi@${version}`, digest: { sha512: digest.toString('hex') } }]);
  assert.deepEqual(statement.predicate.buildDefinition.externalParameters.workflow, { ref: 'refs/heads/main', repository, path: workflow });
  assert.deepEqual(statement.predicate.buildDefinition.resolvedDependencies, [{ uri: `git+${repository}@refs/heads/main`, digest: { gitCommit: source } }]);
  assert.equal(statement.predicate.runDetails.metadata.invocationId, invocation);
  return integrity;
}

async function recover(runId, directory) {
  assert.match(runId, /^\d+$/, 'A numeric original workflow run is required');
  directory = resolve(directory);
  mkdirSync(directory, { recursive: true });
  const command = (exe, args) => execFileSync(exe, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
  const api = path => JSON.parse(command('gh', ['api', `repos/${repo}/${path}`]));
  const source = command('git', ['rev-parse', 'origin/main']).trim();
  const run = api(`actions/runs/${runId}`);
  const jobs = api(`actions/runs/${runId}/attempts/1/jobs?per_page=100`).jobs.filter(job => job.name === 'Publish @dev');
  assert.equal(jobs.length, 1, 'Expected one original dev publication job');
  const logs = command('gh', ['run', 'view', runId, '--repo', repo, '--attempt', '1', '--job', String(jobs[0].id), '--log']);
  const version = originalPublication(run, logs, source);
  const download = async url => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://registry.npmjs.org');
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Registry returned ${response.status} for ${url}; do not republish while validation is pending`);
    return Buffer.from(await response.arrayBuffer());
  };
  const metadata = JSON.parse(await download(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`));
  const bytes = await download(metadata.dist.tarball);
  const attestations = JSON.parse(await download(metadata.dist.attestations.url));
  const provenance = attestations.attestations.filter(att => att.predicateType === predicateType);
  assert.equal(provenance.length, 1, 'Missing or ambiguous npm provenance');
  const tarball = `${directory}/package.tgz`;
  const bundle = `${directory}/provenance-bundle.json`;
  writeFileSync(tarball, bytes);
  writeFileSync(bundle, JSON.stringify(provenance[0].bundle));
  const verified = JSON.parse(command('gh', ['attestation', 'verify', tarball, '--bundle', bundle,
    '--repo', repo, '--cert-identity', identity, '--source-digest', source, '--source-ref', 'refs/heads/main',
    '--deny-self-hosted-runners', '--digest-alg', 'sha512', '--format', 'json']));
  const integrity = verifyEvidence({ metadata, bytes, verified, source, version, runId });
  writeFileSync(`${directory}/verification.json`, JSON.stringify({ source, version, runId, integrity, originalTarballAvailable: false, metadata, verified }, null, 2));
  writeFileSync(`${directory}/package.tgz.sha512`, `${createHash('sha512').update(bytes).digest('hex')}  package.tgz\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `source_sha=${source}\nversion=${version}\n`);
  console.log(`Authenticated ${name}@${version} from ${source}, run ${runId}/attempts/1: ${integrity}`);
  console.log('Original runner tarball is unavailable. This authenticates signed registry bytes; it does not compare against the lost local tarball.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [runId, directory] = process.argv.slice(2);
  try { assert.ok(directory); await recover(runId, directory); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
