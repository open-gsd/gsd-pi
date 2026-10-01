// Regression test for #1999 — phase_change extension event.
//
// gsd-phase-state emits one phase_change extension event per transition
// (activate / set / clear / deactivate) through the hook-emitter bridge,
// beside the uok audit log. Best-effort: no registered host API = no-op.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { clearHookEmitter, setHookEmitter } from '../hook-emitter.ts'
import {
  activateGSD,
  clearCurrentPhase,
  configureGSDPhaseAudit,
  deactivateGSD,
  setCurrentPhase,
} from '../../shared/gsd-phase-state.ts'

interface CapturedEvent {
  type: string
  previousPhase: string | null
  currentPhase: string | null
  source: string
  traceId?: string
}

function makeFakePi(captured: CapturedEvent[]): unknown {
  return {
    emitExtensionEvent: async (event: CapturedEvent) => {
      captured.push(event)
    },
  }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

describe('phase_change extension event (#1999)', () => {
  it('fires one event per transition with correct previous/current phases', async (t) => {
    const basePath = mkdtempSync(join(tmpdir(), 'gsd-phase-change-'))
    t.after(() => {
      deactivateGSD()
      configureGSDPhaseAudit(null)
      clearHookEmitter()
      rmSync(basePath, { recursive: true, force: true })
    })
    const captured: CapturedEvent[] = []
    setHookEmitter(makeFakePi(captured) as Parameters<typeof setHookEmitter>[0])
    deactivateGSD() // reset module state
    captured.length = 0
    await flush()

    activateGSD({ basePath, traceId: 'trace-1' })
    await flush()
    assert.ok(setCurrentPhase('plan-slice', { basePath, traceId: 'trace-1' }))
    await flush()
    assert.ok(setCurrentPhase('execute-task', { basePath, traceId: 'trace-1' }))
    await flush()
    clearCurrentPhase()
    await flush()
    deactivateGSD()
    await flush()

    assert.equal(captured.length, 5)
    assert.deepEqual(
      captured.map((e) => [e.previousPhase, e.currentPhase]),
      [
        [null, null], // activate
        [null, 'plan-slice'], // set
        ['plan-slice', 'execute-task'], // set
        ['execute-task', null], // clear
        [null, null], // deactivate (phase was cleared)
      ],
    )
    assert.ok(captured.every((e) => e.type === 'phase_change'))
    assert.ok(captured.every((e) => e.source === 'auto'))
    assert.equal(captured[1]?.traceId, 'trace-1')
  })

  it('emits without an audit context (traceId omitted)', async (t) => {
    t.after(() => {
      deactivateGSD()
      configureGSDPhaseAudit(null)
      clearHookEmitter()
    })
    const captured: CapturedEvent[] = []
    setHookEmitter(makeFakePi(captured) as Parameters<typeof setHookEmitter>[0])
    configureGSDPhaseAudit(null)
    deactivateGSD()
    captured.length = 0
    await flush()

    activateGSD()
    await flush()
    assert.ok(setCurrentPhase('execute-task'))
    await flush()

    assert.equal(captured.length, 2)
    assert.equal(captured[0]?.traceId, undefined)
    assert.equal(captured[1]?.traceId, undefined)
    assert.deepEqual(captured[1], {
      type: 'phase_change',
      previousPhase: null,
      currentPhase: 'execute-task',
      source: 'auto',
    })
  })

  it('does not fire when the host API is absent (best-effort)', (t) => {
    t.after(() => {
      deactivateGSD()
      configureGSDPhaseAudit(null)
      clearHookEmitter()
    })
    clearHookEmitter()
    deactivateGSD()
    activateGSD({ basePath: join(tmpdir(), 'gsd-phase-change-nohost'), traceId: 'trace-2' })
    assert.ok(setCurrentPhase('plan-slice'))
    clearCurrentPhase()
    deactivateGSD()
  })

  it('does not fire a set while GSD is inactive', async (t) => {
    t.after(() => {
      deactivateGSD()
      configureGSDPhaseAudit(null)
      clearHookEmitter()
    })
    const captured: CapturedEvent[] = []
    setHookEmitter(makeFakePi(captured) as Parameters<typeof setHookEmitter>[0])
    deactivateGSD()
    captured.length = 0
    await flush()

    assert.equal(setCurrentPhase('plan-slice'), false)
    await flush()
    assert.equal(captured.length, 0)
  })

  it('a slow subscriber does not suppress subsequent transitions', async (t) => {
    t.after(() => {
      deactivateGSD()
      configureGSDPhaseAudit(null)
      clearHookEmitter()
    })
    const seen: string[] = []
    let firstStarted = 0
    const slowPi = {
      emitExtensionEvent: async (event: { type: string; currentPhase: string | null }) => {
        if (event.currentPhase === 'plan-slice') {
          firstStarted += 1
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        seen.push(event.currentPhase ?? 'null')
      },
    }
    setHookEmitter(slowPi as Parameters<typeof setHookEmitter>[0])
    deactivateGSD()
    await flush()

    activateGSD()
    assert.ok(setCurrentPhase('plan-slice'))
    assert.ok(setCurrentPhase('execute-task'))
    await new Promise((resolve) => setTimeout(resolve, 60))

    assert.equal(firstStarted, 1)
    assert.ok(seen.includes('plan-slice'))
    assert.ok(seen.includes('execute-task'))
  })
})
