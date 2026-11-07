import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const repositoryRoot = process.cwd()
const compiled = import.meta.url.includes('/dist-test/')
const root = compiled ? resolve(repositoryRoot, 'dist-test') : repositoryRoot
const hook = resolve(repositoryRoot, compiled ? 'scripts/dist-test-resolve.mjs' : 'src/resources/extensions/gsd/tests/resolve-ts.mjs')
const allowed = 'spark/fixture-model'
function run(code: string, policy: string | null = JSON.stringify([allowed])) {
  const env = { ...process.env }
  delete env.GSD_MODEL_ALLOWLIST
  if (policy !== null) env.GSD_MODEL_ALLOWLIST = policy
  const child = spawnSync(process.execPath, ['--import', hook, '--experimental-strip-types', '--input-type=module', '-e', code], {
    cwd: root, env, encoding: 'utf8', timeout: 30000,
  })
  assert.equal(child.status, 0, child.stderr || child.error?.message)
}
const imports = `
import assert from 'node:assert/strict';
import { getModelRequestPolicy, parseModelAllowlist, isModelRequestAllowed, inheritModelRequestPolicy, assertModelSelectionAllowed, registerProviderApiProvider, getApiProviderForModel, stream, streamSimple, complete, completeSimple } from '@gsd/pi-ai';
const makeModel=(provider='spark',id='fixture-model')=>({provider,id,name:id,api:'fixture-policy',baseUrl:'https://offline.invalid',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:1048576,maxTokens:1048576});
const context={messages:[]};
let requests=0;
const provider={api:'fixture-policy',stream:()=>{requests++;throw Error('fixture-provider-entered')},streamSimple:()=>{requests++;throw Error('fixture-provider-entered')}};
registerProviderApiProvider('spark',provider);
registerProviderApiProvider('paid',provider);
`

test('policy parsing is fail-closed for malformed/empty/wildcard/nonqualified values', () => {
  run(imports + `
  for(const raw of ['', 'null', '{}', '[]', '["spark"]', '["spark/"]', '["spark/*"]', '[" spark/model"]', '[42]']) assert.throws(()=>parseModelAllowlist(raw), /GSD_MODEL_ALLOWLIST/);
  assert.equal(parseModelAllowlist(undefined),undefined);
  assert.deepEqual(parseModelAllowlist('["spark/a/b","spark/a/b"]'),['spark/a/b']);
  `)
})

test('stream/complete and retained provider handlers deny before invoking paid or wrong-ID provider', () => {
  run(imports + `
  for(const model of [makeModel('paid'),makeModel('spark','wrong'),makeModel('new-ready-provider')]) {
   assert.throws(()=>stream(model,context),/policy forbids/);
   assert.throws(()=>streamSimple(model,context),/policy forbids/);
   await assert.rejects(complete(model,context),/policy forbids/);
   await assert.rejects(completeSimple(model,context),/policy forbids/);
   const raw=getApiProviderForModel(model);
   if(raw){assert.throws(()=>raw.stream(model,context),/policy forbids/);assert.throws(()=>raw.streamSimple(model,context),/policy forbids/)}
  }
  assert.equal(requests,0);
  assert.throws(()=>streamSimple(makeModel(),context,{maxTokens:1048576}),/fixture-provider-entered/);
  assert.equal(requests,1);
  `)
})

test('process-lifetime policy cannot be weakened by env mutation, copied arrays or child overlays', () => {
  run(imports + `
  const original=getModelRequestPolicy();assert(Object.isFrozen(original));assert.throws(()=>original.push('paid/fixture-model'));
  process.env.GSD_MODEL_ALLOWLIST='["paid/fixture-model"]';
  assert.equal(isModelRequestAllowed(makeModel('paid')),false);
  assert.deepEqual(JSON.parse(inheritModelRequestPolicy({GSD_MODEL_ALLOWLIST:'[]',OTHER:'retained'}).GSD_MODEL_ALLOWLIST),['${allowed}']);
  assert.equal(inheritModelRequestPolicy({OTHER:'retained'}).OTHER,'retained');
  `)
})

test('native registry denies model auth BEFORE any credential lookup and filters exact IDs', () => {
  run(imports + `
  const {ModelRegistry}=await import('./packages/pi-coding-agent/src/core/model-registry.ts');
  const {AuthStorage}=await import('./packages/pi-coding-agent/src/core/auth-storage.ts');
  const auth=AuthStorage.inMemory();let lookups=0;
  auth.getApiKeyWithOAuthState=async()=>{lookups++;return {apiKey:'offline-only'}};
  const registry=ModelRegistry.inMemory(auth);
  registry.registerProvider('spark',{authMode:'none',api:'fixture-policy',baseUrl:'https://offline.invalid',models:[makeModel(),makeModel('spark','wrong')]});
  registry.registerProvider('paid',{authMode:'none',api:'fixture-policy',baseUrl:'https://offline.invalid',models:[makeModel('paid')]});
  assert.deepEqual(registry.getAvailable().map(m=>m.provider+'/'+m.id),['${allowed}']);
  for(const model of [makeModel('paid'),makeModel('spark','wrong')]) {
   assert.equal(registry.hasConfiguredAuth(model),false);
   const result=await registry.getApiKeyAndHeaders(model);assert.equal(result.ok,false);assert.match(result.error,/policy forbids/);
  }
  assert.equal(registry.isProviderRequestReady('paid'),false);assert.equal(lookups,0);
  const result=await registry.getApiKeyAndHeaders(makeModel());assert.equal(result.ok,true);assert.equal(lookups,1);
  registry.setDisabledModelProviders(['spark']);assert.equal(registry.hasConfiguredAuth(makeModel()),false);
  assert.equal((await registry.getApiKeyAndHeaders(makeModel())).ok,false);assert.equal(lookups,1);
  `)
})

test('actual child plan denies frontmatter/tool overrides BEFORE forking session history', () => {
  run(imports + `
  const {createSubagentLaunchPlan,buildSubagentProcessEnv,buildShellEnvAssignments}=await import('./src/resources/extensions/subagent/launch.ts');
  const agent={name:'fixture',description:'fixture',systemPrompt:'',source:'project',filePath:'fixture.md',tools:[],model:'paid/fixture-model'};
  let forkReads=0;
  const parent={getSessionFile:()=>{forkReads++;throw Error('must not fork')},getLeafId:()=>null,getSessionDir:()=>''};
  for(const change of [{},{modelOverride:'paid/fixture-model'},{modelOverride:'spark/wrong'}]) assert.throws(()=>createSubagentLaunchPlan({agent,task:'offline fixture',tmpPromptPath:null,defaultCwd:process.cwd(),contextMode:'fork',parentSessionManager:parent,...change}),/policy forbids override/);
  assert.equal(forkReads,0);
  process.env.GSD_MODEL_ALLOWLIST='[]';
  const plan=createSubagentLaunchPlan({agent,modelOverride:'${allowed}',task:'offline fixture',tmpPromptPath:null,defaultCwd:process.cwd()});
  assert.equal(plan.args[plan.args.indexOf('--model')+1],'${allowed}');
  assert.deepEqual(JSON.parse(plan.env.GSD_MODEL_ALLOWLIST),['${allowed}']);
  assert.deepEqual(JSON.parse(buildSubagentProcessEnv({GSD_MODEL_ALLOWLIST:'[]'}).GSD_MODEL_ALLOWLIST),['${allowed}']);
  assert(buildShellEnvAssignments({}).some(x=>x.startsWith('GSD_MODEL_ALLOWLIST=')));
  assert.equal(requests,0);
  `)
})

test('CLI child override rejects unavailable/disallowed selection instead of prompting default', () => {
  run(imports + `
  const {applyModelOverride}=await import('./src/cli-model-override.ts');let selected=0;
  const session={setModel:()=>{selected++}};const registry={getAvailable:()=>[makeModel()]};
  for(const flag of ['paid/fixture-model','spark/wrong','missing']) assert.throws(()=>applyModelOverride(session,registry,flag),/refusing fallback/);
  assert.equal(selected,0);applyModelOverride(session,registry,'${allowed}');assert.equal(selected,1);assert.equal(requests,0);
  `)
})

test('resume binding revalidates restored paid model before any attempted stream', () => {
  run(imports + `
  const {verifyQualifiedModelBinding}=await import('./packages/rpc-client/src/model-binding.ts');
  let current=makeModel('paid');let prompts=0;
  const client={setModel:async(provider,id)=>{const model=makeModel(provider,id);if(!isModelRequestAllowed(model))throw Error('policy forbids');current=model},getState:async()=>({model:current})};
  await assert.rejects(verifyQualifiedModelBinding(client,'paid/fixture-model'),/policy forbids/);
  assert.throws(()=>streamSimple(current,context),/policy forbids/);assert.equal(requests,0);
  await verifyQualifiedModelBinding(client,'${allowed}');assert.equal(current.provider,'spark');
  assert.equal(prompts,0);
  `)
})

test('no opt-in policy preserves existing provider selection and context/tool options', () => {
  run(imports + `
  assert.equal(getModelRequestPolicy(),undefined);assert.equal(isModelRequestAllowed(makeModel('paid')),true);
  assertModelSelectionAllowed('any/other');assert.deepEqual(inheritModelRequestPolicy({OTHER:'retained'}),{OTHER:'retained'});
  assert.throws(()=>streamSimple(makeModel('paid'),context),/fixture-provider-entered/);assert.equal(requests,1);
  `, null)
})


test('all native phase buckets share the same pre-provider denial boundary', () => {
  run(imports + `
  const {GSD_MODEL_PHASE_KEYS}=await import('./src/resources/extensions/gsd/preferences-types.ts');
  assert.equal(GSD_MODEL_PHASE_KEYS.length,9);
  for(const phase of GSD_MODEL_PHASE_KEYS) {
   assert.throws(()=>streamSimple(makeModel('paid',phase),context),/policy forbids/);
   assert.throws(()=>streamSimple(makeModel('spark',phase),context),/policy forbids/);
  }
  assert.equal(requests,0);
  `)
})

test('allowed dispatch preserves full context, tools and explicit output budget', () => {
  run(imports + `
  const full={messages:[{role:'user',content:[{type:'text',text:'x'.repeat(1035000)}],timestamp:0}],tools:[{name:'fixture_tool',description:'fixture',parameters:{type:'object',properties:{}}}]};
  const options={maxTokens:1048576,reasoning:'high'};let captured;
  registerProviderApiProvider('spark',{api:'fixture-policy',stream:(model,ctx,opts)=>{captured={model,ctx,opts};throw Error('entered')},streamSimple:(model,ctx,opts)=>{captured={model,ctx,opts};throw Error('entered')}});
  const model=makeModel();assert.throws(()=>streamSimple(model,full,options),/entered/);
  assert.equal(captured.model,model);assert.equal(captured.ctx,full);assert.equal(captured.opts,options);
  assert.equal(captured.model.contextWindow,1048576);assert.equal(captured.ctx.tools.length,1);
  `)
})

test('malformed process policy aborts import before any prompt/provider can run', () => {
  const env={...process.env,GSD_MODEL_ALLOWLIST:'[]'}
  const child=spawnSync(process.execPath,['--input-type=module','-e',"await import('@gsd/pi-ai'); console.log('PROMPT_REACHED')"],{cwd:root,env,encoding:'utf8',timeout:30000})
  assert.notEqual(child.status,0);assert.match(child.stderr,/GSD_MODEL_ALLOWLIST/);assert(!child.stdout.includes('PROMPT_REACHED'))
})
