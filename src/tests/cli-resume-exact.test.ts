import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCliArgs } from '../cli-web-branch.ts'

test('parses exact session path and native id as separate literal arguments', () => {
  const sessionFile = '/tmp/session with spaces [draft] ü.jsonl'
  const sessionId = 'native-session-id'
  const flags = parseCliArgs(['node', 'gsd', '--resume-exact', sessionFile, sessionId])

  assert.deepEqual(flags.resumeExact, { sessionFile, sessionId })
})

test('rejects incomplete exact-resume arguments', () => {
  assert.throws(
    () => parseCliArgs(['node', 'gsd', '--resume-exact', '/tmp/session.jsonl']),
    /requires a session file path and session id/,
  )
})

test('rejects conflicting session selectors instead of silently choosing one', () => {
  assert.throws(
    () => parseCliArgs(['node', 'gsd', '--resume-exact', '/tmp/session.jsonl', 'session-id', '--continue']),
    /cannot be combined/,
  )
})
