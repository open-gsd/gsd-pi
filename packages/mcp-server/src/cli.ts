#!/usr/bin/env node
/**
 * @opengsd/mcp-server CLI — stdio transport entry point.
 *
 * Connects the MCP server to stdin/stdout for use by Claude Code,
 * Cursor, and other MCP-compatible clients.
 */

import { installGlobalErrorHandlers } from './cli-errors.js';
import { runMcpServerCli } from './cli-runner.js';
import { runMcpHttpServerCli } from './http-server.js';

installGlobalErrorHandlers();

const transport = process.env.GSD_MCP_TRANSPORT?.trim() || 'stdio';
const run = async () => {
  if (transport === 'stdio') return runMcpServerCli();
  if (transport === 'streamable-http') return runMcpHttpServerCli();
  throw new Error('GSD_MCP_TRANSPORT must be stdio or streamable-http');
};

run().catch((err) => {
  process.stderr.write(
    `[gsd-mcp-server] Fatal: ${err instanceof Error ? err.message : String(err)}\n`
  );
  process.exit(1);
});
