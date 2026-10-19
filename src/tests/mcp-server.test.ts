import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { registerDbTools } from '../resources/extensions/gsd/bootstrap/db-tools.ts'
import { registerMemoryTools } from '../resources/extensions/gsd/bootstrap/memory-tools.ts'
import { _getAdapter } from '../resources/extensions/gsd/gsd-db.ts'
import { createWorkflowAuthorityFixture } from '../resources/extensions/gsd/tests/workflow-authority-fixture.ts'

// Keep a relative .js specifier so resolve-ts can redirect to ../mcp-server.ts.
const mcpServerSpecifier = '../mcp-server.js'

test('mcp-server module imports without errors', async () => {
  const mod = await import(mcpServerSpecifier)
  assert.ok(mod, 'module should be importable')
  assert.strictEqual(typeof mod.startMcpServer, 'function', 'startMcpServer should be a function')
})

test('startMcpServer accepts the correct argument shape', async () => {
  const { startMcpServer } = await import(mcpServerSpecifier)

  assert.strictEqual(typeof startMcpServer, 'function')
  assert.strictEqual(startMcpServer.length, 1, 'startMcpServer should accept one argument')
})

test('native MCP identities are fresh per invocation unless explicit metadata is supplied', async () => {
  const { createToolCallIdentityResolver } = await import(mcpServerSpecifier)
  const firstInstance = createToolCallIdentityResolver()
  const restartedInstance = createToolCallIdentityResolver()
  const request = (key?: string) => key === undefined
    ? { params: {} }
    : { params: { _meta: { 'io.opengsd/idempotency-key': key } } }

  const firstInvocation = firstInstance(request(), { requestId: 1 })
  const reusedRequestIdInvocation = firstInstance(request(), { requestId: 1 })
  const explicitReservedLookingKey = firstInstance(request('mcp-request:1'), { requestId: 1 })

  assert.notEqual(
    reusedRequestIdInvocation,
    firstInvocation,
    'sequential reuse of one request id receives a fresh invocation identity',
  )
  assert.notEqual(
    firstInstance(request(), {}),
    firstInvocation,
    'metadata and a request id remain optional for ordinary calls',
  )
  assert.equal(
    restartedInstance(request('mcp-request:1'), { requestId: 99 }),
    explicitReservedLookingKey,
    'explicit private keys remain stable across server instances',
  )
  assert.doesNotMatch(explicitReservedLookingKey, /mcp-request:1$/, 'raw private metadata is not persisted')
  assert.throws(
    () => firstInstance(request('   '), { requestId: 1 }),
    /idempotency-key.*nonblank/i,
  )
})

test('compiled MCP runtime dependencies resolve with explicit .js subpaths', async () => {
  const stdioMod = await import('@modelcontextprotocol/sdk/server/stdio.js')
  const typesMod = await import('@modelcontextprotocol/sdk/types.js')

  assert.strictEqual(typeof stdioMod.StdioServerTransport, 'function')
  assert.ok(typesMod.ListToolsRequestSchema, 'ListToolsRequestSchema should be exported')
  assert.ok(typesMod.CallToolRequestSchema, 'CallToolRequestSchema should be exported')
})

test('parallel tools/call requests of one workflow tool each write their own row', async () => {
  const { startMcpServer } = await import(mcpServerSpecifier)
  const fixture = await createWorkflowAuthorityFixture()
  const client = new Client({ name: 'mcp-server-test', version: '0.0.0' })
  try {
    // The Pi tools as `gsd --mode mcp` exposes them: the session supplies ctx.
    const piTools: any[] = []
    const pi = { registerTool: (tool: any) => piTools.push(tool) } as any
    registerDbTools(pi)
    registerMemoryTools(pi)
    const tools = piTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      execute: (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: unknown) =>
        tool.execute(toolCallId, params, signal, onUpdate, { cwd: fixture.root }),
    }))

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await startMcpServer({ tools, transport: serverTransport })
    await client.connect(clientTransport)

    const rowCount = (table: string) =>
      Number(_getAdapter()!.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count)
    const cases = [
      {
        name: 'gsd_requirement_save',
        table: 'requirements',
        args: (index: number) => ({
          class: 'core-capability',
          description: `Parallel requirement ${index}`,
          why: 'Each call in a batch is its own operation',
          source: 'M001',
        }),
      },
      {
        name: 'capture_thought',
        table: 'memories',
        args: (index: number) => ({ category: 'environment', content: `Parallel memory ${index}` }),
      },
    ]

    for (const { name, table, args } of cases) {
      const before = rowCount(table)
      const results = await Promise.all(
        [0, 1, 2, 3, 4].map((index) => client.callTool({ name, arguments: args(index) })),
      )
      for (const result of results) {
        const text = (result.content as Array<{ text?: string }>)[0]?.text ?? ''
        assert.ok(!result.isError, `${name} must succeed: ${text}`)
        assert.doesNotMatch(text, /idempotency conflict|^Error/, `${name} must not collide with a parallel call`)
      }
      assert.equal(rowCount(table) - before, results.length, `${name} writes one row per call`)
    }
  } finally {
    await client.close()
    fixture.cleanup()
  }
})

test('startMcpServer tools/call preserves retry identity and reports changed-payload conflict', async () => {
  const { startMcpServer } = await import(mcpServerSpecifier)
  const fixture = await createWorkflowAuthorityFixture()
  const client = new Client({ name: 'mcp-server-retry-test', version: '0.0.0' })
  let restartedClient: Client | undefined
  try {
    const piTools: any[] = []
    const pi = { registerTool: (tool: any) => piTools.push(tool) } as any
    registerDbTools(pi)
    const requirementSave = piTools.find((tool) => tool.name === 'gsd_requirement_save')
    assert.ok(requirementSave, 'gsd_requirement_save should be registered')
    const tools = [{
      name: requirementSave.name,
      description: requirementSave.description,
      parameters: requirementSave.parameters,
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal?: AbortSignal,
        onUpdate?: unknown,
      ) => requirementSave.execute(toolCallId, params, signal, onUpdate, { cwd: fixture.root }),
    }]

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await startMcpServer({ tools, transport: serverTransport })
    await client.connect(clientTransport)

    const identity = { 'io.opengsd/idempotency-key': 'transport-replay-1' }
    const args = {
      class: 'core-capability',
      description: 'Transport retries preserve Domain Operation identity',
      why: 'A response can be lost after the mutation commits',
      source: 'M001',
    }
    const first = await client.callTool({ name: 'gsd_requirement_save', arguments: args, _meta: identity })
    const replay = await client.callTool({ name: 'gsd_requirement_save', arguments: args, _meta: identity })
    assert.equal(first.isError, undefined)
    assert.deepEqual(replay, first)

    const operation = _getAdapter()!.prepare(`
      SELECT idempotency_key FROM workflow_operations
      WHERE idempotency_key = :key
    `).get({
      ':key': `pi:gsd_requirement_save:mcp-explicit:v1:sha256:${
        createHash('sha256').update('transport-replay-1', 'utf8').digest('hex')
      }`,
    })
    assert.match(
      String(operation?.idempotency_key),
      /^pi:gsd_requirement_save:mcp-explicit:v1:sha256:[a-f0-9]{64}$/,
    )
    assert.doesNotMatch(String(operation?.idempotency_key), /transport-replay-1/)

    const distinct = await client.callTool({
      name: 'gsd_requirement_save',
      arguments: { ...args, description: 'A distinct call keeps a distinct identity' },
      _meta: { 'io.opengsd/idempotency-key': 'transport-distinct-2' },
    })
    assert.equal(distinct.isError, undefined)
    assert.equal(
      Number(_getAdapter()!.prepare(`
        SELECT COUNT(*) AS count FROM workflow_operations
        WHERE idempotency_key LIKE 'pi:gsd_requirement_save:mcp-explicit:v1:sha256:%'
      `).get()?.count),
      2,
    )

    await client.close()
    const [restartedClientTransport, restartedServerTransport] = InMemoryTransport.createLinkedPair()
    await startMcpServer({ tools, transport: restartedServerTransport })
    restartedClient = new Client({ name: 'mcp-server-restarted-test', version: '0.0.0' })
    await restartedClient.connect(restartedClientTransport)

    const restartReplay = await restartedClient.callTool({
      name: 'gsd_requirement_save',
      arguments: args,
      _meta: identity,
    })
    assert.deepEqual(restartReplay, first, 'explicit identity replays after server restart')

    const conflict = await restartedClient.callTool({
      name: 'gsd_requirement_save',
      arguments: { ...args, description: 'Changed payload must not collapse into the retry' },
      _meta: identity,
    })
    const conflictText = (conflict.content as Array<{ text?: string }>)[0]?.text ?? ''
    assert.match(conflictText, /idempotency conflict/i)

    const malformed = await restartedClient.callTool({
      name: 'gsd_requirement_save',
      arguments: args,
      _meta: { 'io.opengsd/idempotency-key': '   ' },
    })
    assert.equal(malformed.isError, true)
    assert.match(
      (malformed.content as Array<{ text?: string }>)[0]?.text ?? '',
      /idempotency-key.*nonblank/i,
    )
  } finally {
    await restartedClient?.close().catch(() => {})
    await client.close().catch(() => {})
    fixture.cleanup()
  }
})
