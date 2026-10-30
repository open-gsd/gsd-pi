import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

// Execute the built production entrypoint, with a network trap inherited by children.
for (const [name, args, policy] of [
  ['headless parent', ['headless','--json','--model','paid/fixture-model','auto'], '["spark/fixture-model"]'],
  ['native immediate-prompt child', ['--mode','json','--model','paid/fixture-model','-p','offline fixture'], '["spark/fixture-model"]'],
  ['unknown same-provider override', ['--mode','json','--model','spark/wrong','-p','offline fixture'], '["spark/fixture-model"]'],
  ['headless resume override', ['headless','--json','--model','paid/fixture-model','--resume','fixture-session','auto'], '["spark/fixture-model"]'],
  ['malformed launch contract', ['headless','--json','auto'], '[]'],
] as const) {
  test(`built ${name} refuses before any network or model dispatch`, () => {
    const root = mkdtempSync(join(tmpdir(),'gsd-policy-native-'))
    try {
      const project=join(root,'project');const home=join(root,'profile');mkdirSync(project);mkdirSync(home)
      const network=join(root,'network-attempts');const blocker=join(root,'block-network.mjs')
      writeFileSync(blocker,`import {appendFileSync} from 'node:fs';import net from 'node:net';const deny=()=>{appendFileSync(${JSON.stringify(network)},'attempt\\n');throw Error('offline network forbidden')};globalThis.fetch=deny;net.Socket.prototype.connect=deny;`)
      const child=spawnSync(process.execPath,[resolve('dist/bootstrap.js'),...args],{cwd:project,encoding:'utf8',timeout:30000,
        env:{...process.env,GSD_HOME:home,GSD_MODEL_ALLOWLIST:policy,GSD_SKIP_UPDATE_CHECK:'1',NODE_OPTIONS:`${process.env.NODE_OPTIONS??''} --import=${blocker}`}})
      assert(!child.error,child.error?.message);assert.notEqual(child.status,0);assert.equal(child.signal,null)
      assert.match(child.stderr,/policy forbids|GSD_MODEL_ALLOWLIST/)
      assert.equal(existsSync(network),false,existsSync(network)?readFileSync(network,'utf8'):'')
      assert.equal(existsSync(join(project,'.gsd/auto.lock')),false)
    } finally {rmSync(root,{recursive:true,force:true})}
  })
}
