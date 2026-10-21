/**
 * #2906 — the web onboarding MiniMax credential probes must validate against
 * a model the Anthropic-compatible endpoint actually serves. The endpoint
 * supports only MiniMax-M3.1-Flash and MiniMax-M3 (platform.minimax.io
 * text-anthropic-api); probing with the retired MiniMax-M2.7 rejects valid
 * keys. This test pins the probe URL + body offline through an injected
 * fetch; no live inference.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { OnboardingService } = await import('../web/onboarding-service.ts')

interface CapturedRequest {
  url: string
  init: RequestInit
}

function makeService() {
  const captured: CapturedRequest[] = []
  const authPath = join(mkdtempSync(join(tmpdir(), 'gsd-onboarding-probe-')), 'auth.json')
  const service = new OnboardingService({
    env: {},
    authPath,
    fetch: (async (url: unknown, init: RequestInit = {}) => {
      captured.push({ url: String(url), init })
      return new Response(JSON.stringify({ error: 'invalid key' }), { status: 401 })
    }) as typeof fetch,
  })
  return {
    service,
    captured,
    cleanup: () => rmSync(join(authPath, '..'), { recursive: true, force: true }),
  }
}

test('web onboarding minimax probe posts MiniMax-M3.1-Flash to the anthropic endpoint', async () => {
  const { service, captured, cleanup } = makeService()
  try {
    await service.validateAndSaveApiKey('minimax', 'mm-key')

    assert.equal(captured.length, 1)
    assert.equal(captured[0].url, 'https://api.minimax.io/anthropic/v1/messages')
    const body = JSON.parse(String(captured[0].init.body))
    assert.equal(body.model, 'MiniMax-M3.1-Flash')
    assert.equal(body.max_tokens, 1)
  } finally {
    cleanup()
  }
})

test('web onboarding minimax-cn probe posts MiniMax-M3.1-Flash to the CN endpoint', async () => {
  const { service, captured, cleanup } = makeService()
  try {
    await service.validateAndSaveApiKey('minimax-cn', 'mm-key')

    assert.equal(captured.length, 1)
    assert.equal(captured[0].url, 'https://api.minimaxi.com/anthropic/v1/messages')
    const body = JSON.parse(String(captured[0].init.body))
    assert.equal(body.model, 'MiniMax-M3.1-Flash')
  } finally {
    cleanup()
  }
})

test('failed probes are not persisted', async () => {
  const { service, cleanup } = makeService()
  try {
    const state = await service.validateAndSaveApiKey('minimax', 'mm-key')
    assert.equal(state.lastValidation?.status, 'failed')
    assert.equal(state.lastValidation?.persisted, false)
  } finally {
    cleanup()
  }
})
