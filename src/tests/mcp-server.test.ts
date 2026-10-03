import test from 'node:test'
import assert from 'node:assert/strict'

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
