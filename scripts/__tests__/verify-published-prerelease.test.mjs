import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { originalPublication, verifyEvidence } from '../verify-published-prerelease.mjs';
const source = 'a'.repeat(40);
const repo = 'https://github.com/open-gsd/gsd-pi';
const workflow = '.github/workflows/npm-publish.yml';
const version = '1.21.0-dev.aaaaaaaa';
const bytes = Buffer.from('authenticated existing artifact');
const digest = createHash('sha512').update(bytes).digest();
const invocation = `${repo}/actions/runs/123/attempts/1`;
function fixture() {
  return { source, version, runId: '123', bytes,
    metadata: {name:'@opengsd/gsd-pi',version,dist:{integrity:`sha512-${digest.toString('base64')}`}},
    verified: [{ verificationResult: {
      signature: { certificate: {
        issuer:'https://token.actions.githubusercontent.com',subjectAlternativeName:`${repo}/${workflow}@refs/heads/main`,
        sourceRepositoryURI:repo,sourceRepositoryDigest:source,sourceRepositoryRef:'refs/heads/main',runnerEnvironment:'github-hosted',runInvocationURI:invocation,
      } },
      statement: { predicateType:'https://slsa.dev/provenance/v1',subject:[{name:`pkg:npm/%40opengsd/gsd-pi@${version}`,digest:{sha512:digest.toString('hex')}}],predicate:{
        buildDefinition:{externalParameters:{workflow:{ref:'refs/heads/main',repository:repo,path:workflow}},resolvedDependencies:[{uri:`git+${repo}@refs/heads/main`,digest:{gitCommit:source}}]},
        runDetails:{metadata:{invocationId:invocation}},
      } },
    } }],
  };
}
test('authenticated bytes are eligible for verification-only continuation',()=>assert.match(verifyEvidence(fixture()),/^sha512-/));
for (const [label,mutate] of [
  ['wrong bytes',f=>f.bytes=Buffer.from('different')],
  ['missing integrity',f=>delete f.metadata.dist.integrity],
  ['wrong version',f=>f.metadata.version='1.21.0'],
  ['missing provenance',f=>f.verified=[]],
  ['ambiguous provenance',f=>f.verified.push(f.verified[0])],
  ['wrong issuer',f=>f.verified[0].verificationResult.signature.certificate.issuer='other'],
  ['wrong workflow',f=>f.verified[0].verificationResult.signature.certificate.subjectAlternativeName='other'],
  ['wrong signed source',f=>f.verified[0].verificationResult.signature.certificate.sourceRepositoryDigest='b'.repeat(40)],
  ['wrong signed run',f=>f.verified[0].verificationResult.signature.certificate.runInvocationURI=invocation.replace('123','124')],
  ['wrong subject digest',f=>f.verified[0].verificationResult.statement.subject[0].digest.sha512='00'],
  ['wrong predicate source',f=>f.verified[0].verificationResult.statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit='b'.repeat(40)],
  ['wrong predicate attempt',f=>f.verified[0].verificationResult.statement.predicate.runDetails.metadata.invocationId=invocation.replace('/1','/2')],
]) test(`rejects ${label}`,()=>{const f=fixture();mutate(f);assert.throws(()=>verifyEvidence(f));});
const run={repository:{full_name:'open-gsd/gsd-pi'},path:workflow,event:'workflow_dispatch',head_branch:'main',head_sha:source,status:'completed',run_attempt:1};
const logs=`[command]/usr/bin/git log -1 --format=%H\n2026-10-07T18:17:20Z ${source}\nStamped version: ${version}\n`;
test('requires original checkout and stamped version evidence',()=>assert.equal(originalPublication(run,logs,source),version));
for (const [label,r,l] of [
  ['moved main',{...run,head_sha:'b'.repeat(40)},logs],
  ['wrong workflow',{...run,path:'other.yml'},logs],
  ['wrong ref',{...run,head_branch:'other'},logs],
  ['ambiguous attempt',{...run,run_attempt:2},logs],
  ['different checkout',run,logs.replace(source,'b'.repeat(40))],
  ['missing stamp',run,logs.replace('Stamped version:','Other:')],
  ['wrong stamp',run,logs.replace('dev.aaaaaaaa','dev.bbbbbbbb')],
]) test(`rejects original ${label}`,()=>assert.throws(()=>originalPublication(r,l,source)));
const wf=YAML.parse(readFileSync('.github/workflows/npm-publish.yml','utf8'));
test('resume skips publication and preserves downstream source/tests/approval gates',()=>{
 assert.equal(wf.jobs['prerelease-publish'].if,'${{ !inputs.resume_prerelease_run }}');
 assert.equal(wf.jobs['prerelease-resume'].if,'${{ inputs.resume_prerelease_run }}');
 const resume=wf.jobs['prerelease-resume'].steps;
 assert.ok(resume.some(s=>s.uses?.startsWith('actions/upload-artifact@')));
 assert.equal(resume.filter(s=>s.run?.includes('npm publish')).length,0);
 const verify=wf.jobs['prerelease-verify'];
 assert.deepEqual(verify.needs,['prerelease-publish','prerelease-resume']);
 assert.match(verify.if,/always\(\).*result == 'success'/);
 assert.ok(verify.steps.some(s=>s.run?.includes('sha512sum --check')));
 assert.ok(verify.steps.some(s=>s.run?.includes('npm install -g ./recovered-prerelease/package.tgz')));
 for(const script of ['test:smoke','test:live-regression','test:auto-acceptance']) assert.ok(verify.steps.some(s=>s.run?.includes(script)));
 assert.ok(verify.steps.some(s=>s.run?.includes('git rev-parse HEAD')&&s.env?.RECOVERED_SOURCE));
 assert.ok(wf.jobs['prod-release-plan'].steps.some(s=>s.run?.includes('git rev-parse HEAD')&&s.env?.RECOVERED_SOURCE));
 assert.equal(wf.jobs['prod-release'].environment,'prod');
});
