import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const t = new StdioClientTransport({ command: 'node', args: ['/home/openclaw/.openclaw/projects/gsd-pi/packages/mcp-server/dist/cli.js'] });
const c = new Client({ name: 'pask-resume-762b', version: '1.0.0' });
await c.connect(t);
const res = await c.callTool({
  name: 'gsd_task_recovery_resume',
  arguments: {
    projectDir: '/home/openclaw/.openclaw/projects/groupmetoolkit',
    recoveryActionId: '762bad13-f275-4d18-b000-bd62fac99d5e',
    repairSummary: 'T03 verify command was unpassable as planned (grep -ri token-leak-check src greps src/ but the check lives at scripts/check-token-leak.mjs). Replanned T03 via gsd_plan_task with a corrected verify command (node scripts/check-token-leak.mjs && node node_modules/.bin/toolfactory check) and updated description/files/expectedOutput. The check itself passes on current source (nova-cove probe: 7 token read sites all through ctx.config, no query-param leaks, single X-Access-Token header, scrub/redact wired, no 32-hex literals, missing_auth envelope clean). Docs were already corrected to match what the script proves; all gates green.',
    evidence: {
      replanIdempotencyKey: 'pask-t03-verify-fix-20261024c',
      plannedTaskText: 'Planned task T03 (S05/M001)',
      verifyCommandDb: 'node scripts/check-token-leak.mjs && node node_modules/.bin/toolfactory check',
      probeResult: 'ok scanned 6 TypeScript source files under src/; 7 token read site(s) all through ctx.config; no ?access_token= or ?token= query parameter anywhere in src/; src/groupme/client.ts sends the token in exactly one X-Access-Token header; scrubToken/redactUpstreamErrors/redactCause wired; no 32-hex credential-shaped literal in src/; built CLI without a token: exit 1, structured missing_auth envelope, no credential noise',
      failedGateCommand: 'grep -ri token-leak-check src',
      failedGateReason: 'check lives at scripts/check-token-leak.mjs, not under src/',
      gitHead: '197cfed'
    }
  },
  _meta: { 'io.opengsd/idempotency-key': 'pask-recover-762b-t03-20261024' }
});
console.log(JSON.stringify(res, null, 1).slice(0, 2000));
await c.close();
