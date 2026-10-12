// tool-call-loop-guard — Tests for the tool-call loop detection guard.
//
// Verifies that identical consecutive tool calls are detected and blocked
// after exceeding the threshold, and that the guard resets properly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkToolCallLoop,
  configureToolCallLoopGuard,
  recordToolCallLoopMutation,
  resetToolCallLoopGuard,
  disableToolCallLoopGuard,
  getToolCallLoopCount,
  getToolCallCountForTool,
} from '../bootstrap/tool-call-loop-guard.ts';


// ═══════════════════════════════════════════════════════════════════════════
// Allows first N calls, blocks after threshold
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: blocks after threshold ──');

{
  resetToolCallLoopGuard();

  // First 4 identical calls should be allowed (threshold is 4)
  for (let i = 1; i <= 4; i++) {
    const result = checkToolCallLoop('web_search', { query: 'same query' });
    assert.ok(result.block === false, `Call ${i} should be allowed`);
    assert.deepStrictEqual(result.count, i, `Count should be ${i} after call ${i}`);
  }

  // 5th identical call should be blocked
  const blocked = checkToolCallLoop('web_search', { query: 'same query' });
  assert.ok(blocked.block === true, '5th identical call should be blocked');
  assert.ok(blocked.reason!.includes('web_search'), 'Reason should mention tool name');
  assert.ok(blocked.reason!.includes('5'), 'Reason should mention count');
}

// ═══════════════════════════════════════════════════════════════════════════
// Different tool calls reset the streak
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: different calls reset streak ──');

{
  resetToolCallLoopGuard();

  checkToolCallLoop('web_search', { query: 'query A' });
  checkToolCallLoop('web_search', { query: 'query A' });
  checkToolCallLoop('web_search', { query: 'query A' });
  assert.deepStrictEqual(getToolCallLoopCount(), 3, 'Count should be 3 after 3 identical calls');

  // A different call resets the streak
  const different = checkToolCallLoop('bash', { command: 'ls' });
  assert.ok(different.block === false, 'Different tool call should be allowed');
  assert.deepStrictEqual(getToolCallLoopCount(), 1, 'Count should reset to 1 after different call');

  // Same tool but different args also resets
  checkToolCallLoop('web_search', { query: 'query A' });
  checkToolCallLoop('web_search', { query: 'query B' }); // different args
  assert.deepStrictEqual(getToolCallLoopCount(), 1, 'Different args should reset count');
}

// ═══════════════════════════════════════════════════════════════════════════
// Reset clears the guard
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: reset clears state ──');

{
  resetToolCallLoopGuard();
  checkToolCallLoop('web_search', { query: 'q' });
  checkToolCallLoop('web_search', { query: 'q' });
  checkToolCallLoop('web_search', { query: 'q' });
  assert.deepStrictEqual(getToolCallLoopCount(), 3, 'Count should be 3 before reset');

  resetToolCallLoopGuard();
  assert.deepStrictEqual(getToolCallLoopCount(), 0, 'Count should be 0 after reset');

  // After reset, the same call starts fresh
  const result = checkToolCallLoop('web_search', { query: 'q' });
  assert.ok(result.block === false, 'Call after reset should be allowed');
  assert.deepStrictEqual(getToolCallLoopCount(), 1, 'Count should be 1 after first call post-reset');
}

// ═══════════════════════════════════════════════════════════════════════════
// Disable makes guard permissive
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: disable allows everything ──');

{
  disableToolCallLoopGuard();

  for (let i = 0; i < 10; i++) {
    const result = checkToolCallLoop('web_search', { query: 'same' });
    assert.ok(result.block === false, `Call ${i + 1} should be allowed when disabled`);
  }

  // Re-enable via reset
  resetToolCallLoopGuard();
  checkToolCallLoop('web_search', { query: 'q' });
  assert.deepStrictEqual(getToolCallLoopCount(), 1, 'Guard should be active again after reset');
}

// ═══════════════════════════════════════════════════════════════════════════
// Arg order doesn't affect hash
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: arg order is normalized ──');

{
  resetToolCallLoopGuard();

  checkToolCallLoop('web_search', { query: 'test', limit: 5 });
  const result = checkToolCallLoop('web_search', { limit: 5, query: 'test' }); // same args, different order
  assert.ok(result.block === false, 'Same args in different order should count as consecutive');
  assert.deepStrictEqual(getToolCallLoopCount(), 2, 'Should detect as same call regardless of key order');
}

// ═══════════════════════════════════════════════════════════════════════════
// Nested/array arguments produce distinct hashes
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: nested args are not stripped ──');

{
  resetToolCallLoopGuard();

  // Simulate ask_user_questions-style calls with different nested content
  for (let i = 1; i <= 5; i++) {
    const result = checkToolCallLoop('ask_user_questions', {
      questions: [{ id: `q${i}`, question: `Question ${i}?` }],
    });
    assert.ok(result.block === false, `Nested call ${i} with unique content should be allowed`);
    assert.deepStrictEqual(getToolCallLoopCount(), 1, `Each unique nested call should reset count to 1`);
  }

  // Truly identical nested calls should still be detected.
  // ask_user_questions has a strict threshold of 1, so the 2nd identical call is blocked.
  resetToolCallLoopGuard();
  const first = checkToolCallLoop('ask_user_questions', {
    questions: [{ id: 'same', question: 'Same?' }],
  });
  assert.ok(first.block === false, 'First ask_user_questions call should be allowed');
  const blocked = checkToolCallLoop('ask_user_questions', {
    questions: [{ id: 'same', question: 'Same?' }],
  });
  assert.ok(blocked.block === true, '2nd identical ask_user_questions call should be blocked (strict threshold)');

  // Non-strict tools still allow up to 4 identical calls
  resetToolCallLoopGuard();
  for (let i = 1; i <= 4; i++) {
    const r = checkToolCallLoop('web_search', {
      questions: [{ id: 'same', question: 'Same?' }],
    });
    assert.ok(r.block === false, `web_search call ${i} should be allowed (normal threshold)`);
  }
  const blockedNormal = checkToolCallLoop('web_search', {
    questions: [{ id: 'same', question: 'Same?' }],
  });
  assert.ok(blockedNormal.block === true, '5th identical web_search call should be blocked');
}

// ═══════════════════════════════════════════════════════════════════════════
// Nested object key order is normalized
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: nested key order is normalized ──');

{
  resetToolCallLoopGuard();

  checkToolCallLoop('tool', { outer: { b: 2, a: 1 } });
  const result = checkToolCallLoop('tool', { outer: { a: 1, b: 2 } });
  assert.deepStrictEqual(getToolCallLoopCount(), 2, 'Same nested args in different key order should match');
}

// ═══════════════════════════════════════════════════════════════════════════
// Per-tool-name cap (#783 Brief C) — catches improvisation loops with varied args
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: per-tool cap blocks varied-args improvisation (#783) ──');

{
  resetToolCallLoopGuard();

  // A one-shot workflow tool called with DIFFERENT args each time (the reported
  // improvisation pattern). The identical-signature streak alone would reset
  // every call; the per-tool cap must catch it.
  for (let i = 1; i <= 6; i++) {
    const result = checkToolCallLoop('gsd_complete_milestone', { milestone: `M${i}` });
    assert.ok(result.block === false, `one-shot call ${i} (varied args) should be allowed`);
    assert.deepStrictEqual(getToolCallCountForTool('gsd_complete_milestone'), i, `per-tool count should be ${i}`);
  }
  // 7th call (cap 6 + 1) must be blocked by the per-tool guard.
  const blocked = checkToolCallLoop('gsd_complete_milestone', { milestone: 'M7' });
  assert.ok(blocked.block === true, '7th one-shot call (varied args) should be blocked by per-tool cap');
  assert.ok(blocked.reason!.includes('repeated tool'), 'reason should identify the per-tool guard');
  assert.ok(blocked.reason!.includes('gsd_complete_milestone'), 'reason should name the tool');
  assert.ok(blocked.reason!.includes('7'), 'reason should mention the count');
}

// ═══════════════════════════════════════════════════════════════════════════
// Repeatable tools get the higher cap
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: repeatable tools get the higher cap (#783) ──');

{
  resetToolCallLoopGuard();

  // bash is repeatable: varied commands are legitimate up to the higher cap.
  for (let i = 1; i <= 15; i++) {
    const result = checkToolCallLoop('bash', { command: `echo ${i}` });
    assert.ok(result.block === false, `bash call ${i} (varied args) should be allowed`);
  }
  // 16th call (cap 15 + 1) is blocked by the per-tool guard — this is the
  // improvisation-through-bash case from the forensics (~51 calls).
  const blocked = checkToolCallLoop('bash', { command: 'echo 16' });
  assert.ok(blocked.block === true, '16th bash call (varied args) should be blocked by per-tool cap');
  assert.ok(blocked.reason!.includes('cap 15'), 'reason should mention the repeatable cap');
}

// ═══════════════════════════════════════════════════════════════════════════
// Mutation progress decays per-tool counts (#1092)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: mutation progress decays per-tool counts (#1092) ──');

{
  resetToolCallLoopGuard();

  // bash is called more than the repeatable cap, but each count is separated
  // by a successful file mutation. Guard 2 should treat that as progress and
  // avoid blocking the progressing unit.
  for (let i = 1; i <= 20; i++) {
    const result = checkToolCallLoop('bash', { command: `echo ${i}` });
    assert.ok(result.block === false, `bash call ${i} after mutation progress should be allowed`);
    assert.deepStrictEqual(getToolCallCountForTool('bash'), 1, `bash count should decay before call ${i}`);

    const mutationTool = i % 2 === 0 ? 'write' : 'edit';
    const mutation = checkToolCallLoop(mutationTool, {
      path: `file-${i}.ts`,
      content: `content ${i}`,
    });
    assert.ok(mutation.block === false, `${mutationTool} mutation ${i} should be allowed`);
    recordToolCallLoopMutation(mutationTool);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Durable workflow mutations count as progress (#1985)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: durable workflow mutations count as progress (#1985) ──');

{
  resetToolCallLoopGuard();

  for (let i = 1; i <= 20; i++) {
    const result = checkToolCallLoop('gsd_requirement_save', {
      description: `Requirement ${i}`,
    });
    assert.ok(result.block === false, `successful requirement save ${i} should be allowed`);
    assert.deepStrictEqual(
      getToolCallCountForTool('gsd_requirement_save'),
      1,
      `requirement-save count should decay before call ${i}`,
    );
    recordToolCallLoopMutation('gsd_requirement_save', {
      operation: 'save_requirement',
      id: `R${String(i).padStart(3, '0')}`,
    });
  }
}

{
  resetToolCallLoopGuard();

  for (let i = 1; i <= 6; i++) {
    const result = checkToolCallLoop('gsd_requirement_save', {
      description: `Failed requirement ${i}`,
    });
    assert.ok(result.block === false, `failed requirement save ${i} should be allowed up to the cap`);
    recordToolCallLoopMutation('gsd_requirement_save', { error: 'db_unavailable' });
  }
  const blocked = checkToolCallLoop('gsd_requirement_save', {
    description: 'Failed requirement 7',
  });
  assert.ok(blocked.block === true, '7th failed requirement save should be blocked by the per-tool cap');
  assert.ok(blocked.reason?.includes('repeated tool'), 'failed saves should be caught by Guard 2');
}

{
  resetToolCallLoopGuard();

  for (let i = 1; i <= 6; i++) {
    const result = checkToolCallLoop('gsd_task_settle', { taskId: `T${i}` });
    assert.ok(result.block === false, `task-settle dry run ${i} should be allowed up to the cap`);
    recordToolCallLoopMutation('gsd_task_settle', { dryRun: true, rows: [], lifecycleRows: [] });
  }
  const blocked = checkToolCallLoop('gsd_task_settle', { taskId: 'T7' });
  assert.ok(blocked.block === true, '7th task-settle dry run should be blocked by the per-tool cap');
  assert.ok(blocked.reason?.includes('repeated tool'), 'dry-run writes should be caught by Guard 2');
}

{
  resetToolCallLoopGuard();
  const input = { description: 'Same requirement' };

  for (let i = 1; i <= 4; i++) {
    const result = checkToolCallLoop('gsd_requirement_save', input);
    assert.ok(result.block === false, `identical requirement save ${i} should be allowed`);
    recordToolCallLoopMutation('gsd_requirement_save', {
      operation: 'save_requirement',
      id: `R${String(i).padStart(3, '0')}`,
    });
  }
  const blocked = checkToolCallLoop('gsd_requirement_save', input);
  assert.ok(blocked.block === true, '5th identical requirement save should still be blocked by Guard 1');
  assert.ok(blocked.reason?.includes('identical args'), 'identical saves should be caught by Guard 1');
}

// ═══════════════════════════════════════════════════════════════════════════
// Successful shell/exec progress decays per-tool counts (#1206)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: successful shell/exec progress decays per-tool counts (#1206) ──');

{
  // A local model debugging a UAT scenario runs many varied bg_shell /
  // gsd_uat_exec calls (restart server, npm install, curl an endpoint). Each
  // successful call is state progression, so Guard 2 must decay and never
  // block the productive turn — even past the repeatable cap.
  for (const execTool of ['bg_shell', 'gsd_uat_exec', 'bash', 'gsd_exec']) {
    resetToolCallLoopGuard();

    for (let i = 1; i <= 20; i++) {
      const result = checkToolCallLoop(execTool, { command: `step ${i}` });
      assert.ok(result.block === false, `${execTool} call ${i} after exec progress should be allowed`);
      assert.deepStrictEqual(getToolCallCountForTool(execTool), 1, `${execTool} count should decay before call ${i}`);

      // A successful (non-error) exec call records progress, like a file mutation.
      recordToolCallLoopMutation(execTool);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Failing exec loops still trip the per-tool cap (#783 vs #1206)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: failing exec loop (no progress recorded) still trips the cap (#783) ──');

{
  resetToolCallLoopGuard();

  // The improvisation loop from #783: the model retries a missing tool through
  // varied bash commands. Those fail (non-zero exit → isError), so the caller
  // never records progress and the per-tool cap must still trip.
  for (let i = 1; i <= 15; i++) {
    const result = checkToolCallLoop('bash', { command: `try-missing-tool ${i}` });
    assert.ok(result.block === false, `failing bash call ${i} should be allowed up to the cap`);
    // No recordToolCallLoopMutation — the command errored.
  }
  const blocked = checkToolCallLoop('bash', { command: 'try-missing-tool 16' });
  assert.ok(blocked.block === true, '16th failing bash call should be blocked by the per-tool cap');
  assert.ok(blocked.reason?.includes('repeated tool'), 'reason should identify the per-tool guard');
}

// ═══════════════════════════════════════════════════════════════════════════
// bg_shell/async_bash false-success must not decay the per-tool cap (#783)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: bg_shell failed run/start does not decay the cap (#783) ──');

{
  resetToolCallLoopGuard();

  for (let i = 1; i <= 15; i++) {
    const result = checkToolCallLoop('bg_shell', { action: 'run', command: `try-missing-tool ${i}` });
    assert.ok(result.block === false, `failing bg_shell run ${i} should be allowed up to the cap`);
    recordToolCallLoopMutation('bg_shell', { action: 'run', exitCode: 1, timedOut: false });
  }
  const blocked = checkToolCallLoop('bg_shell', { action: 'run', command: 'try-missing-tool 16' });
  assert.ok(blocked.block === true, '16th failing bg_shell run should be blocked by the per-tool cap');
}

{
  resetToolCallLoopGuard();

  for (let i = 1; i <= 15; i++) {
    checkToolCallLoop('bg_shell', { action: 'start', command: `bad-server ${i}` });
    recordToolCallLoopMutation('bg_shell', {
      action: 'start',
      process: { alive: false, exitCode: 1 },
    });
  }
  const blocked = checkToolCallLoop('bg_shell', { action: 'start', command: 'bad-server 16' });
  assert.ok(blocked.block === true, '16th dead bg_shell start should be blocked by the per-tool cap');
}

console.log('\n── Loop guard: async_bash job registration does not decay the cap (#783) ──');

{
  resetToolCallLoopGuard();

  for (let i = 1; i <= 6; i++) {
    const result = checkToolCallLoop('async_bash', { command: `try-missing-tool ${i}` });
    assert.ok(result.block === false, `async_bash call ${i} should be allowed up to the cap`);
    recordToolCallLoopMutation('async_bash');
  }
  const blocked = checkToolCallLoop('async_bash', { command: 'try-missing-tool 7' });
  assert.ok(blocked.block === true, '7th async_bash call should be blocked by the per-tool cap');
}

// ═══════════════════════════════════════════════════════════════════════════
// Distinct read-only navigation calls are context gathering, not repeated-tool loops.
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: distinct read-only navigation calls are not capped by per-tool count ──');

{
  const exemptTools = ['find', 'glob', 'grep', 'ls', 'read', 'search_and_read'];

  for (const toolName of exemptTools) {
    resetToolCallLoopGuard();

    for (let i = 1; i <= 20; i++) {
      const result = checkToolCallLoop(toolName, { path: `file-${i}.ts` });
      assert.ok(result.block === false, `distinct ${toolName} call ${i} should be allowed`);
    }

    resetToolCallLoopGuard();
    for (let i = 1; i <= 4; i++) {
      const result = checkToolCallLoop(toolName, { path: 'same-file.ts' });
      assert.ok(result.block === false, `identical ${toolName} call ${i} should be allowed`);
    }

    const blocked = checkToolCallLoop(toolName, { path: 'same-file.ts' });
    assert.ok(blocked.block === true, `5th identical ${toolName} call should still be blocked`);
    assert.ok(blocked.reason?.includes('identical args'), `${toolName} loops should be caught by Guard 1`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Distinct read-only workflow queries are legitimate lookups, not loops (#2753)
// ═══════════════════════════════════════════════════════════════════════════

test('distinct read-only workflow queries are not capped by per-tool count (#2753)', () => {
  // The reported pattern: a planning turn fetches many DIFFERENT decisions one
  // by one. Each call has distinct args, so Guard 1 never trips, and the query
  // tools never record mutations, so Guard 2's count never decays. These tools
  // are exempt from Guard 2 like the navigation tools above.
  const queryTools = [
    'gsd_decision_get',
    'gsd_decision_list',
    'gsd_requirement_get',
    'gsd_requirement_list',
    'gsd_project_snapshot',
    'gsd_milestone_status',
    'gsd_journal_query',
    'gsd_exec_search',
    'gsd_resume',
    'memory_query',
    'gsd_memory_query',
    'gsd_graph',
    'gsd_memory_graph',
  ];

  for (const toolName of queryTools) {
    resetToolCallLoopGuard();

    for (let i = 1; i <= 8; i++) {
      const result = checkToolCallLoop(toolName, { id: `D${i}` });
      assert.ok(result.block === false, `distinct ${toolName} call ${i} should be allowed`);
    }
  }

  // The exact reported reproduction: 8 distinct-ID gsd_decision_get calls.
  resetToolCallLoopGuard();
  for (let i = 1; i <= 8; i++) {
    const result = checkToolCallLoop('gsd_decision_get', { id: `D5${i}` });
    assert.ok(result.block === false, `gsd_decision_get lookup ${i} with a different ID should not be blocked`);
  }

  // MCP-surfaced variants canonicalize to the same exempt names.
  resetToolCallLoopGuard();
  for (let i = 1; i <= 8; i++) {
    const result = checkToolCallLoop('mcp__gsd__gsd_decision_get', { id: `D${i}` });
    assert.ok(result.block === false, `distinct MCP-prefixed gsd_decision_get call ${i} should be allowed`);
  }
  resetToolCallLoopGuard();
  for (let i = 1; i <= 8; i++) {
    const result = checkToolCallLoop('mcp__gsd__gsd_memory_query', { query: `q${i}` });
    assert.ok(result.block === false, `distinct MCP-prefixed gsd_memory_query call ${i} should be allowed`);
  }

  // Accepted nuance: reinforced memory queries bump hit counts (ranking
  // telemetry, no workflow state), so distinct-arg reinforced queries stay
  // exempt too; Guard 1 still catches an identical-args hammer.
  resetToolCallLoopGuard();
  for (let i = 1; i <= 8; i++) {
    const result = checkToolCallLoop('memory_query', { query: `q${i}`, reinforce_hits: true });
    assert.ok(result.block === false, `distinct reinforced memory_query call ${i} should be allowed`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Guard 1 still catches identical-args reread loops of exempt query tools (#2753)
// ═══════════════════════════════════════════════════════════════════════════

test('identical-args query loops are still caught by Guard 1 (#2753)', () => {
  resetToolCallLoopGuard();
  for (let i = 1; i <= 4; i++) {
    const result = checkToolCallLoop('gsd_decision_get', { id: 'D554' });
    assert.ok(result.block === false, `identical gsd_decision_get call ${i} should be allowed`);
  }
  // Blocked on the 5th identical call by Guard 1, before Guard 2 is relevant.
  const blocked = checkToolCallLoop('gsd_decision_get', { id: 'D554' });
  assert.ok(blocked.block === true, 'identical-args gsd_decision_get reread loop should be blocked');
  assert.ok(blocked.reason?.includes('identical args'), 'reread loops should be caught by Guard 1, not Guard 2');

  // Guard 1 also catches an identical-args loop under the MCP-prefixed name.
  resetToolCallLoopGuard();
  for (let i = 1; i <= 4; i++) {
    assert.ok(checkToolCallLoop('mcp__gsd__gsd_decision_get', { id: 'D554' }).block === false);
  }
  const mcpBlocked = checkToolCallLoop('mcp__gsd__gsd_decision_get', { id: 'D554' });
  assert.ok(mcpBlocked.block === true, 'identical-args MCP-prefixed reread loop should be blocked by Guard 1');
  assert.ok(mcpBlocked.reason?.includes('identical args'), 'MCP-prefixed reread loops should be caught by Guard 1');
});

// ═══════════════════════════════════════════════════════════════════════════
// The #2753 exemption must NOT widen to side-effecting workflow tools (#2753)
// ═══════════════════════════════════════════════════════════════════════════

test('query exemption does not widen to workflow write/side-effect tools (#2753)', () => {
  // Negative invariant: exempting the getters must not exempt the savers.
  // gsd_decision_save is a one-shot write tool (default cap 6, no decay —
  // saves only decay via gsd_requirement_save-style mutation records).
  resetToolCallLoopGuard();
  for (let i = 1; i <= 6; i++) {
    const result = checkToolCallLoop('gsd_decision_save', { title: `Decision ${i}` });
    assert.ok(result.block === false, `gsd_decision_save call ${i} should be allowed`);
  }
  const blocked = checkToolCallLoop('gsd_decision_save', { title: 'Decision 7' });
  assert.ok(blocked.block === true, '7th varied-arg gsd_decision_save must still trip Guard 2');
  assert.ok(blocked.reason?.includes('repeated tool'), 'write-tool overflow should be caught by Guard 2');

  // gsd_checkpoint_db flushes the SQLite WAL — side-effecting maintenance, so
  // it stays capped despite its read writePolicy, under both name surfaces.
  for (const checkpointName of ['gsd_checkpoint_db', 'mcp__gsd__gsd_checkpoint_db']) {
    resetToolCallLoopGuard();
    for (let i = 1; i <= 6; i++) {
      const result = checkToolCallLoop(checkpointName, { reason: `flush-${i}` });
      assert.ok(result.block === false, `${checkpointName} call ${i} should be allowed`);
    }
    const checkpointBlocked = checkToolCallLoop(checkpointName, { reason: 'flush-7' });
    assert.ok(checkpointBlocked.block === true, `7th ${checkpointName} call must still trip Guard 2`);
    assert.ok(checkpointBlocked.reason?.includes('repeated tool'), 'checkpoint overflow should be caught by Guard 2');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// User-configured exempt names keep exact matching alongside canonical (#2753)
// ═══════════════════════════════════════════════════════════════════════════

test('user-configured MCP-prefixed exempt names still match exactly (#2753)', () => {
  configureToolCallLoopGuard({ repeated_tool: { exempt_tools: ['mcp__custom__lookup'] } });
  resetToolCallLoopGuard();
  for (let i = 1; i <= 10; i++) {
    const result = checkToolCallLoop('mcp__custom__lookup', { arg: `v${i}` });
    assert.ok(result.block === false, `exact-match exempt call ${i} should be allowed`);
  }
  configureToolCallLoopGuard(null);
  resetToolCallLoopGuard();
});

// ═══════════════════════════════════════════════════════════════════════════
// Per-tool counts are independent per tool and reset together
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: per-tool counts are independent and reset together (#783) ──');

{
  resetToolCallLoopGuard();

  // Two different tools tracked separately.
  for (let i = 0; i < 3; i++) checkToolCallLoop('read', { path: `f${i}` });
  for (let i = 0; i < 3; i++) checkToolCallLoop('write', { path: `g${i}` });
  assert.deepStrictEqual(getToolCallCountForTool('read'), 3, 'read tracked separately');
  assert.deepStrictEqual(getToolCallCountForTool('write'), 3, 'write tracked separately');
  assert.deepStrictEqual(getToolCallCountForTool('edit'), 0, 'uncalled tool reports 0');

  resetToolCallLoopGuard();
  assert.deepStrictEqual(getToolCallCountForTool('read'), 0, 'per-tool counts cleared on reset');
  assert.deepStrictEqual(getToolCallCountForTool('write'), 0, 'per-tool counts cleared on reset');
}

// ═══════════════════════════════════════════════════════════════════════════
// Non-exempt repeatable tools from core-session-tools.ts get the higher cap.
// Read-only navigation tools are exempted earlier; mutating/execution repeatable
// tools (e.g. gsd_exec) must still trip the per-tool cap.
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: non-exempt repeatable tools get high cap ──');

{
  for (const toolName of ['bg_shell', 'gsd_exec', 'write']) {
    resetToolCallLoopGuard();

    // Should allow up to 15 varied calls without blocking.
    for (let i = 1; i <= 15; i++) {
      const result = checkToolCallLoop(toolName, { arg: `v${i}` });
      assert.ok(result.block === false, `${toolName} call ${i} (varied args) should be allowed`);
    }
    // 16th call with varied args must be blocked by the per-tool repeatable cap.
    const blocked = checkToolCallLoop(toolName, { arg: 'v16' });
    assert.ok(blocked.block === true, `${toolName}: 16th call must be blocked by repeatable cap`);
    assert.ok(blocked.reason?.includes('cap 15'), `${toolName}: reason must mention cap 15`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Non-repeatable tools excluded from INHERENTLY_REPEATABLE_TOOL_SET use the
// default cap (6), not the repeatable cap (15).
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: gsd_plan_task is inherently repeatable (#1739) ──');

{
  resetToolCallLoopGuard();
  for (let i = 1; i <= 8; i++) {
    const result = checkToolCallLoop('gsd_plan_task', { taskId: `T0${i}`, title: `Task ${i}` });
    assert.ok(result.block === false, `distinct gsd_plan_task call ${i} should be allowed`);
  }

  resetToolCallLoopGuard();
  for (let i = 1; i <= 4; i++) {
    const result = checkToolCallLoop('gsd_plan_task', { taskId: 'T01', title: 'Same' });
    assert.ok(result.block === false, `identical gsd_plan_task call ${i} should be allowed`);
  }
  const identicalBlocked = checkToolCallLoop('gsd_plan_task', { taskId: 'T01', title: 'Same' });
  assert.ok(identicalBlocked.block === true, '7th identical-args gsd_plan_task must still trip Guard 1');
}

console.log('\n── Loop guard: ToolSearch (excluded from repeatable set) hits default cap ──');

{
  // ToolSearch is in MINIMAL_AUTO_BASE but explicitly excluded from repeatable.
  // It should hit the default cap of 6, not 15.
  resetToolCallLoopGuard();
  for (let i = 1; i <= 6; i++) {
    const result = checkToolCallLoop('ToolSearch', { query: `q${i}` });
    assert.ok(result.block === false, `ToolSearch call ${i} should be allowed`);
  }
  const blocked = checkToolCallLoop('ToolSearch', { query: 'q7' });
  assert.ok(blocked.block === true, 'ToolSearch: 7th varied call must be blocked by default cap');
  assert.ok(!blocked.reason?.includes('cap 15'), 'ToolSearch must NOT use the repeatable cap');
}

// ═══════════════════════════════════════════════════════════════════════════
// Block reasons instruct the model to stop tooling this turn
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: block reasons tell model to respond in text ──');

{
  resetToolCallLoopGuard();

  for (let i = 0; i < 4; i++) {
    checkToolCallLoop('web_search', { query: 'same query' });
  }
  const identicalBlocked = checkToolCallLoop('web_search', { query: 'same query' });
  assert.ok(identicalBlocked.block === true, 'identical-args guard should block');
  assert.ok(
    identicalBlocked.reason!.includes('respond to the user in text'),
    'identical-args reason should tell the model to stop tooling',
  );
  assert.ok(
    !identicalBlocked.reason!.includes('Try a different approach'),
    'identical-args reason should not suggest retrying another tool',
  );

  resetToolCallLoopGuard();
  for (let i = 0; i < 6; i++) {
    checkToolCallLoop('gsd_complete_milestone', { milestone: `M${i}` });
  }
  const perToolBlocked = checkToolCallLoop('gsd_complete_milestone', { milestone: 'M7' });
  assert.ok(perToolBlocked.block === true, 'per-tool guard should block');
  assert.ok(
    perToolBlocked.reason!.includes('respond to the user in text'),
    'per-tool reason should tell the model to stop tooling',
  );
  assert.ok(
    perToolBlocked.reason!.includes('Do not retry this tool'),
    'per-tool reason should forbid retrying the blocked tool',
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Distinct-arg browser-automation calls are a legitimate UAT, not a loop (#1120)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: distinct-arg browser automation calls are not capped by per-tool count (#1120) ──');

{
  // A browser-backed UAT legitimately calls one browser verb many times with
  // DIFFERENT arguments (read a validation message, count staged edits, inspect
  // a control card, …). Guard 1's identical-signature streak never trips because
  // the args vary; Guard 2's arg-independent per-tool cap must NOT block it.
  for (const toolName of ['browser_evaluate', 'browser_act', 'browser_find']) {
    resetToolCallLoopGuard();
    for (let i = 1; i <= 12; i++) {
      const result = checkToolCallLoop(toolName, { script: `step ${i}` });
      assert.ok(result.block === false, `distinct ${toolName} call ${i} should be allowed`);
    }
  }

  // MCP-prefixed browser tools canonicalize to `browser_*` and are exempt too.
  resetToolCallLoopGuard();
  for (let i = 1; i <= 12; i++) {
    const result = checkToolCallLoop('mcp__agent-browser__browser_evaluate', { script: `step ${i}` });
    assert.ok(result.block === false, `distinct MCP-prefixed browser_evaluate call ${i} should be allowed`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Identical-arg browser loops are STILL caught by Guard 1 (#1120)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: identical-arg browser loops are still caught by Guard 1 (#1120) ──');

{
  resetToolCallLoopGuard();
  for (let i = 1; i <= 4; i++) {
    const result = checkToolCallLoop('browser_evaluate', { script: 'document.title' });
    assert.ok(result.block === false, `identical browser_evaluate call ${i} should be allowed`);
  }
  const blocked = checkToolCallLoop('browser_evaluate', { script: 'document.title' });
  assert.ok(blocked.block === true, '5th identical browser_evaluate call should be blocked by Guard 1');
  assert.ok(blocked.reason?.includes('identical args'), 'identical browser loops should be caught by Guard 1, not Guard 2');
}

// ═══════════════════════════════════════════════════════════════════════════
// The browser exemption must NOT widen to other non-exempt tools (#1120)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: browser exemption does not widen to other tools (#1120) ──');

{
  // Negative invariant: an arbitrary non-exempt, non-browser tool called past
  // the default cap with varied args must still be blocked by Guard 2.
  resetToolCallLoopGuard();
  for (let i = 1; i <= 6; i++) {
    const result = checkToolCallLoop('some_workflow_tool', { arg: `v${i}` });
    assert.ok(result.block === false, `non-exempt tool call ${i} should be allowed`);
  }
  const blocked = checkToolCallLoop('some_workflow_tool', { arg: 'v7' });
  assert.ok(blocked.block === true, '7th varied-arg non-exempt call must still trip Guard 2');
  assert.ok(blocked.reason?.includes('repeated tool'), 'non-exempt overflow should be caught by Guard 2');
}

// ═══════════════════════════════════════════════════════════════════════════
// Configurable thresholds (#1198)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: master switch disables both guards (#1198) ──');

{
  configureToolCallLoopGuard({ enabled: false });
  resetToolCallLoopGuard();
  // Neither identical-args nor per-tool cap should ever trip while disabled.
  for (let i = 1; i <= 30; i++) {
    const result = checkToolCallLoop('gsd_complete_milestone', { same: 'args' });
    assert.ok(result.block === false, `disabled guard should allow call ${i}`);
  }
  // Restore defaults for subsequent tests.
  configureToolCallLoopGuard(null);
}

console.log('\n── Loop guard: repeated_tool disabled keeps identical-args protection (#1198) ──');

{
  configureToolCallLoopGuard({ repeated_tool: { enabled: false } });
  resetToolCallLoopGuard();
  // Per-tool cap is off: many varied-arg calls are allowed.
  for (let i = 1; i <= 20; i++) {
    const result = checkToolCallLoop('gsd_exec', { cmd: `run-${i}` });
    assert.ok(result.block === false, `repeated_tool disabled should allow varied call ${i}`);
  }
  // Identical-args guard is still active.
  resetToolCallLoopGuard();
  for (let i = 1; i <= 4; i++) {
    assert.ok(checkToolCallLoop('gsd_exec', { cmd: 'same' }).block === false);
  }
  const blocked = checkToolCallLoop('gsd_exec', { cmd: 'same' });
  assert.ok(blocked.block === true, 'identical-args guard should still trip when repeated_tool is off');
  assert.ok(blocked.reason?.includes('identical args'));
  configureToolCallLoopGuard(null);
}

console.log('\n── Loop guard: raised caps allow more repeated calls (#1198) ──');

{
  configureToolCallLoopGuard({ repeated_tool: { default_cap: 10 } });
  resetToolCallLoopGuard();
  for (let i = 1; i <= 10; i++) {
    const result = checkToolCallLoop('gsd_complete_milestone', { arg: `v${i}` });
    assert.ok(result.block === false, `raised-cap call ${i} should be allowed`);
  }
  const blocked = checkToolCallLoop('gsd_complete_milestone', { arg: 'v11' });
  assert.ok(blocked.block === true, '11th call should trip the raised cap of 10');
  assert.ok(blocked.reason?.includes('cap 10'), 'block message should mention the active cap');
  assert.ok(blocked.reason?.includes('tool_call_loop_guard'), 'block message should mention the config key');
  configureToolCallLoopGuard(null);
}

console.log('\n── Loop guard: user-added exempt tools bypass the per-tool cap (#1198) ──');

{
  configureToolCallLoopGuard({ repeated_tool: { exempt_tools: ['ctx_execute'] } });
  resetToolCallLoopGuard();
  for (let i = 1; i <= 30; i++) {
    const result = checkToolCallLoop('ctx_execute', { arg: `v${i}` });
    assert.ok(result.block === false, `exempt tool call ${i} should be allowed`);
  }
  // Built-in exempt defaults are preserved alongside the user-added tool.
  resetToolCallLoopGuard();
  for (let i = 1; i <= 30; i++) {
    assert.ok(checkToolCallLoop('read', { path: `f${i}` }).block === false, 'built-in exempt read should remain exempt');
  }
  configureToolCallLoopGuard(null);
}

console.log('\n── Loop guard: identical-args max is configurable (#1198) ──');

{
  configureToolCallLoopGuard({ identical_args: { max_consecutive_calls: 2 } });
  resetToolCallLoopGuard();
  assert.ok(checkToolCallLoop('web_search', { q: 'x' }).block === false, 'call 1 allowed');
  assert.ok(checkToolCallLoop('web_search', { q: 'x' }).block === false, 'call 2 allowed');
  const blocked = checkToolCallLoop('web_search', { q: 'x' });
  assert.ok(blocked.block === true, '3rd identical call should trip lowered max of 2');
  assert.ok(blocked.reason?.includes('max 2'), 'block message should mention active max');
  configureToolCallLoopGuard(null);
}

console.log('\n── Loop guard: env overrides win over preferences (#1198) ──');

{
  process.env.GSD_TOOL_LOOP_REPEATED_DEFAULT_CAP = '2';
  configureToolCallLoopGuard({ repeated_tool: { default_cap: 6 } });
  resetToolCallLoopGuard();
  assert.ok(checkToolCallLoop('gsd_complete_milestone', { a: '1' }).block === false, 'call 1 allowed');
  assert.ok(checkToolCallLoop('gsd_complete_milestone', { a: '2' }).block === false, 'call 2 allowed');
  const blocked = checkToolCallLoop('gsd_complete_milestone', { a: '3' });
  assert.ok(blocked.block === true, 'env override cap of 2 should win over preference cap of 6');
  delete process.env.GSD_TOOL_LOOP_REPEATED_DEFAULT_CAP;
  configureToolCallLoopGuard(null);
}

// ═══════════════════════════════════════════════════════════════════════════
// Reset restores default guard state after configuration tests
// ═══════════════════════════════════════════════════════════════════════════
resetToolCallLoopGuard();
