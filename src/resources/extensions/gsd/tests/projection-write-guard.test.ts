// Project/App: gsd-pi
// File Purpose: Behavior tests for the agent write guard on managed projections (native engine).

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerHooks } from "../bootstrap/register-hooks.ts";
import { resetToolCallLoopGuard } from "../bootstrap/tool-call-loop-guard.ts";
import { markDepthVerified, resetWriteGateState } from "../bootstrap/write-gate.ts";

type Handler = (event: any, ctx?: any) => Promise<any> | any;
type Block = { block?: boolean; reason?: string } | undefined;

const BASE = mkdtempSync(join(tmpdir(), "gsd-projection-write-guard-"));
const ctx = { cwd: BASE, ui: { notify: () => undefined } } as any;

// M001 has passed the depth question, so its CONTEXT write reaches the projection guard.
markDepthVerified("M001", BASE);
after(() => {
  resetWriteGateState(BASE);
  rmSync(BASE, { recursive: true, force: true });
});

function registeredToolCallHandlers(): Handler[] {
  const handlers: Handler[] = [];
  registerHooks({ on(event: string, handler: Handler) { if (event === "tool_call") handlers.push(handler); } } as any, []);
  return handlers;
}

const toolCallHandlers = registeredToolCallHandlers();
let callSeq = 0;

/** Run the real registered tool_call guards and return the first block, if any. */
async function guard(toolName: string, input: Record<string, unknown>): Promise<Block> {
  callSeq += 1;
  resetToolCallLoopGuard(); // each call stands for a new turn
  for (const handler of toolCallHandlers) {
    const result = await handler({ toolCallId: `call-${callSeq}`, toolName, input }, ctx);
    if (result?.block) return result;
  }
  return undefined;
}

// Each managed projection kind, in both layouts, with the tool that owns it.
const PROJECTIONS: Array<[path: string, tool: RegExp]> = [
  [".gsd/PROJECT.md", /gsd_summary_save/],
  [".gsd/REQUIREMENTS.md", /gsd_requirement_save/],
  [".gsd/DECISIONS.md", /gsd_decision_save/],
  [".gsd/KNOWLEDGE.md", /capture_thought/],
  [".gsd/QUEUE.md", /gsd_milestone_reorder/],
  [".gsd/milestones/M001/slices/S01/S01-REPLAN.md", /gsd_replan_slice/],
  [".gsd/ROADMAP.md", /gsd_plan_milestone/],
  [".gsd/milestones/M001/M001-ROADMAP.md", /gsd_plan_milestone/],
  [".gsd/milestones/M001/M001-CONTEXT.md", /gsd_summary_save/],
  [".gsd/milestones/M001/M001-CONTEXT-DRAFT.md", /gsd_summary_save/],
  [".gsd/milestones/M001/M001-RESEARCH.md", /gsd_summary_save/],
  [".gsd/milestones/M001/M001-VALIDATION.md", /gsd_validate_milestone/],
  [".gsd/milestones/M001/M001-SUMMARY.md", /gsd_complete_milestone/],
  [".gsd/milestones/M001/M001-PARKED.md", /gsd_milestone_park/],
  [".gsd/milestones/M001/slices/S01/S01-PLAN.md", /gsd_plan_slice/],
  [".gsd/milestones/M001/slices/S01/S01-UAT.md", /gsd_slice_complete/],
  [".gsd/milestones/M001/slices/S01/S01-ASSESSMENT.md", /gsd_uat_result_save/],
  [".gsd/milestones/M001/slices/S01/S01-UI-SPEC.md", /gsd_summary_save/],
  [".gsd/milestones/M001/slices/S01/tasks/T01-PLAN.md", /gsd_plan_task/],
  [".gsd/milestones/M001/slices/S01/tasks/T01-SUMMARY.md", /gsd_task_complete/],
  [".gsd/phases/01-auth/01-CONTEXT.md", /gsd_summary_save/],
  [".gsd/phases/01-auth/01-01-PLAN.md", /gsd_plan_slice/],
];

for (const [relPath, tool] of PROJECTIONS) {
  test(`write, edit and bash writes to ${relPath} are refused and name the tool`, async () => {
    const path = `${BASE}/${relPath}`;
    const attempts: Array<[string, Record<string, unknown>]> = [
      ["write", { path, content: "x" }],
      ["edit", { path, oldText: "- [ ]", newText: "- [x]" }],
      ["write", { path: relPath, content: "x" }],
      ["bash", { command: `echo done >> ${relPath}` }],
      ["bash", { command: `cat notes.md | tee ${path}` }],
      ["bash", { command: `sed -i '' 's/\\[ \\]/[x]/' ${relPath}` }],
      ["bash", { command: `cp /tmp/draft.md "${path}"` }],
    ];
    for (const [toolName, input] of attempts) {
      const result = await guard(toolName, input);
      assert.equal(result?.block, true, `${toolName} ${JSON.stringify(input)} must be blocked`);
      assert.match(result?.reason ?? "", tool);
    }
  });
}

test("an unverified milestone CONTEXT write still gets the depth question first", async () => {
  const result = await guard("write", { path: `${BASE}/.gsd/milestones/M002/M002-CONTEXT.md`, content: "x" });
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /depth_verification_M002/);
});

test("STATE.md and gsd.db stay blocked", async () => {
  assert.equal((await guard("write", { path: `${BASE}/.gsd/STATE.md`, content: "x" }))?.block, true);
  assert.equal((await guard("edit", { path: `${BASE}/.gsd/STATE.md`, oldText: "a", newText: "b" }))?.block, true);
  assert.equal((await guard("bash", { command: "echo x > .gsd/gsd.db" }))?.block, true);
});

test("the external state layout and a worktree .gsd are covered", async () => {
  const external = await guard("write", { path: "/home/u/.gsd/projects/app/milestones/M001/M001-ROADMAP.md", content: "x" });
  const worktree = await guard("write", { path: `${BASE}/.gsd/worktrees/M001/.gsd/DECISIONS.md`, content: "x" });
  assert.match(external?.reason ?? "", /gsd_plan_milestone/);
  assert.match(worktree?.reason ?? "", /gsd_decision_save/);
});

test("bash writes to a quoted, escaped, variable- or substitution-prefixed projection path are refused", async () => {
  const path = "/Users/me/My Project/.gsd/DECISIONS.md";
  const commands = [
    `echo x >> "${path}"`,
    `echo x > '${path}'`,
    `dd if=/tmp/draft.md of="${path}"`,
    `echo "note" > /tmp/note.txt; echo x >> "${path}"`,
    `cat notes.md | tee "${path}"`,
    `cp /tmp/draft.md "${path}"`,
    `echo x >> "$PWD"/.gsd/DECISIONS.md`,
    `echo x >> "$PROJECT_DIR"/.gsd/DECISIONS.md`,
    `echo x >> "$HOME/My Project"/.gsd/DECISIONS.md`,
    `echo x >> $HOME/.gsd/projects/app/DECISIONS.md`,
    `echo x >> /Users/me/My\\ Project/.gsd/DECISIONS.md`,
    `echo x >> "/Users/me/it's here/.gsd/DECISIONS.md"`,
    `dd if=/tmp/a of=/Users/me/My\\ Project/.gsd/DECISIONS.md`,
    `dd if=/tmp/a of="$PWD"/.gsd/DECISIONS.md bs=1k`,
    `cp /tmp/x "$PWD"/.gsd/DECISIONS.md`,
    `mv /tmp/x "\${ROOT}"/.gsd/DECISIONS.md`,
    `cp /tmp/x $(pwd)/.gsd/DECISIONS.md`,
    `echo x > $(pwd)/.gsd/DECISIONS.md`,
    `echo x > $(git rev-parse --show-toplevel)/.gsd/DECISIONS.md`,
    `echo x > $(dirname $(pwd))/.gsd/DECISIONS.md`,
    `install -m 644 /tmp/x "$PWD"/.gsd/DECISIONS.md`,
    `cat notes.md | tee -a "$PWD"/.gsd/DECISIONS.md`,
    `cp /tmp/x "$PWD"/.gsd/DECISIONS.md 2>/dev/null && echo ok`,
    `sed -i '' 's/a/b/' "$PWD"/.gsd/DECISIONS.md`,
  ];
  for (const command of commands) {
    const result = await guard("bash", { command });
    assert.equal(result?.block, true, `${command} must be blocked`);
    assert.match(result?.reason ?? "", /gsd_decision_save/);
  }
  const allowed = [
    `cat "${path}" > /tmp/out.txt`,
    `cp "${path}" "/tmp/My Copy/decisions.md"`,
    `echo x >> "$PWD"/.gsd/notes/DECISIONS.md`,
    `echo x >> "$HOME/My Project"/docs/DECISIONS.md`,
    `dd if="${path}" of=/tmp/My\\ Copy/decisions.md`,
    `cp .gsd/DECISIONS.md /tmp/x`,
    `cp "$PWD"/.gsd/DECISIONS.md $(pwd)/backup/`,
    `tee /tmp/x < .gsd/DECISIONS.md`,
    `sed -n '1,5p' "$PWD"/.gsd/DECISIONS.md`,
    `git commit -m "plan -> .gsd/DECISIONS.md"`,
  ];
  for (const command of allowed) {
    assert.equal(await guard("bash", { command }), undefined, `${command} must pass`);
  }
});

test("a workflow file name outside the paths the renderers own is not blocked", async () => {
  // /gsd milestone-summary writes its report to .gsd/summaries, named after the milestone.
  const documents = [
    ".gsd/summaries/M001-SUMMARY.md",
    ".gsd/summaries/2026-10-03-project-summary.md",
    ".gsd/reports/M001-SUMMARY.md",
    ".gsd/captures/x-SUMMARY.md",
    ".gsd/research/M001-RESEARCH.md",
    ".gsd/notes/DECISIONS.md",
    ".gsd/milestones/M001/DECISIONS.md",
  ];
  for (const relPath of documents) {
    const attempts: Array<[string, Record<string, unknown>]> = [
      ["write", { path: `${BASE}/${relPath}`, content: "x" }],
      ["edit", { path: relPath, oldText: "a", newText: "b" }],
      ["bash", { command: `echo done >> ${relPath}` }],
    ];
    for (const [toolName, input] of attempts) {
      assert.equal(await guard(toolName, input), undefined, `${toolName} ${JSON.stringify(input)} must pass`);
    }
  }
});

test("reads, source files and .gsd files that have no save tool are not blocked", async () => {
  const roadmap = ".gsd/milestones/M001/M001-ROADMAP.md";
  const allowed: Array<[string, Record<string, unknown>]> = [
    ["write", { path: `${BASE}/src/app.ts`, content: "x" }],
    ["write", { path: `${BASE}/docs/M001-ROADMAP.md`, content: "x" }],
    ["write", { path: `${BASE}/.gsd/milestones/M001/M001-LEARNINGS.md`, content: "x" }],
    ["write", { path: `${BASE}/.gsd/milestones/M001/M001-SECRETS.md`, content: "x" }],
    ["write", { path: `${BASE}/.gsd/spikes/001/README.md`, content: "x" }],
    ["write", { path: `${BASE}/.gsd/worktrees/M001/docs/API-SUMMARY.md`, content: "x" }],
    ["bash", { command: `cat ${roadmap}` }],
    ["bash", { command: `grep -n "S01" ${roadmap} > /tmp/out.txt` }],
    ["bash", { command: `cp ${roadmap} /tmp/roadmap-copy.md` }],
    ["bash", { command: `git add ${roadmap}` }],
  ];
  for (const [toolName, input] of allowed) {
    assert.equal(await guard(toolName, input), undefined, `${toolName} ${JSON.stringify(input)} must pass`);
  }
});
