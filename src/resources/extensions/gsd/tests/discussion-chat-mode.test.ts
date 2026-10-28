// Project/App: gsd-pi
// File Purpose: discussion.question_mode preference (#2979) — plain-chat discussion interviews.
//
// Pins the three behaviors `chat` mode changes (and the ones it must not):
//   1. Discuss prompts take the plain-text branch: the structured-questions
//      flag resolves to "false" and the chat-mode note is appended.
//   2. The ask_user_questions tool surface is untouched — requiredWorkflowTools
//      keeps the tool and the workflow question-tool surface never disallows it
//      (the readiness gate keeps passing, unlike the env-var switch).
//   3. A chat-mode slice discussion holds until its CONTEXT row is (re)saved.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearGSDPreferencesCache,
  getDiscussionQuestionMode,
  loadEffectiveGSDPreferences,
} from "../preferences.ts";
import { validatePreferences } from "../preferences-validation.ts";
import { KNOWN_PREFERENCE_KEYS } from "../preferences-types.ts";
import { discussionChatPromptNote, resolveWorkflowQuestionToolSurface } from "../question-transport.ts";
import { getRequiredWorkflowToolsForUnit } from "../unit-tool-contracts.ts";
import { buildDiscussSlicePrompt, hasFreshSliceContext, waitForFreshSliceContext } from "../guided-flow.ts";
import { buildDiscussMilestonePrompt } from "../auto-prompts.ts";
import { _discussQuestionFlagForTest } from "../auto-dispatch.ts";
import {
  closeDatabase,
  getScopedArtifact,
  insertArtifact,
  openDatabase,
} from "../gsd-db.ts";

const CHAT_NOTE_MARKER = "Chat-mode discussions";

// ─── Preference schema & validation ──────────────────────────────────────────

test("#2979: discussion is a known preference key", () => {
  assert.ok(KNOWN_PREFERENCE_KEYS.has("discussion"));
});

test("#2979: discussion.question_mode accepts dialog and chat", () => {
  const dialog = validatePreferences({ discussion: { question_mode: "dialog" } });
  assert.deepEqual(dialog.errors, []);
  assert.equal(dialog.preferences.discussion?.question_mode, "dialog");

  const chat = validatePreferences({ discussion: { question_mode: "chat" } });
  assert.deepEqual(chat.errors, []);
  assert.equal(chat.preferences.discussion?.question_mode, "chat");
});

test("#2979: discussion.question_mode rejects other values and non-object discussion", () => {
  const badValue = validatePreferences({ discussion: { question_mode: "banana" as never } });
  assert.ok(badValue.errors.some((e) => e.includes('discussion.question_mode must be "dialog" or "chat"')));

  const badShape = validatePreferences({ discussion: "chat" } as never);
  assert.ok(badShape.errors.some((e) => e.includes("discussion must be an object")));

  const unknownKey = validatePreferences({ discussion: { question_mode: "chat", other: true } as never });
  assert.ok(unknownKey.warnings.some((w) => w.includes('unknown discussion key "other"')));
});

test("#2979: getDiscussionQuestionMode defaults to dialog and reads project + global prefs", (t) => {
  const originalCwd = process.cwd();
  const originalGsdHome = process.env.GSD_HOME;
  const tempProject = mkdtempSync(join(tmpdir(), "gsd-chat-mode-project-"));
  const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-chat-mode-home-"));

  t.after(() => {
    clearGSDPreferencesCache();
    process.chdir(originalCwd);
    if (originalGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    rmSync(tempProject, { recursive: true, force: true });
    rmSync(tempGsdHome, { recursive: true, force: true });
  });

  mkdirSync(join(tempProject, ".gsd"), { recursive: true });
  process.env.GSD_HOME = tempGsdHome;
  process.chdir(tempProject);
  clearGSDPreferencesCache();

  // No preferences anywhere: default dialog.
  assert.equal(getDiscussionQuestionMode(tempProject), "dialog");

  writeFileSync(
    join(tempProject, ".gsd", "PREFERENCES.md"),
    "---\nversion: 1\ndiscussion:\n  question_mode: chat\n---\n",
    "utf-8",
  );
  clearGSDPreferencesCache();
  assert.equal(getDiscussionQuestionMode(tempProject), "chat", "project scope must be readable");
  const loaded = loadEffectiveGSDPreferences(tempProject);
  assert.equal(loaded?.preferences.discussion?.question_mode, "chat");

  // Global scope resolves too (fresh project without the key).
  const otherProject = mkdtempSync(join(tmpdir(), "gsd-chat-mode-other-"));
  t.after(() => rmSync(otherProject, { recursive: true, force: true }));
  rmSync(join(tempProject, ".gsd", "PREFERENCES.md"));
  clearGSDPreferencesCache();
  writeFileSync(
    join(tempGsdHome, "PREFERENCES.md"),
    "---\nversion: 1\ndiscussion:\n  question_mode: chat\n---\n",
    "utf-8",
  );
  clearGSDPreferencesCache();
  assert.equal(getDiscussionQuestionMode(otherProject), "chat", "global scope must be readable");
});

// ─── Question transport ──────────────────────────────────────────────────────

test("#2979: chat note appends only for chat mode with the plain-text flag", () => {
  assert.equal(discussionChatPromptNote("dialog", "false"), "");
  assert.equal(discussionChatPromptNote("dialog", "true"), "");
  assert.equal(discussionChatPromptNote("chat", "true"), "", "no note when structured questions stay on");
  const note = discussionChatPromptNote("chat", "false");
  assert.ok(note.includes(CHAT_NOTE_MARKER));
  assert.ok(note.includes("Do NOT call `ask_user_questions`"));
});

test("#2979: discuss units keep requiring ask_user_questions so readiness still passes", () => {
  for (const unitType of ["discuss-milestone", "discuss-slice", "discuss-project", "discuss-requirements"]) {
    assert.ok(
      getRequiredWorkflowToolsForUnit(unitType).includes("ask_user_questions"),
      `${unitType} must still require ask_user_questions`,
    );
  }
});

test("#2979: the preference never feeds the workflow question-tool surface", (t) => {
  // Chat mode is a prompt-level switch: the surface resolution reads only the
  // env var, so a chat-mode project keeps ask_user_questions allowed. If this
  // assertion ever fails, someone wired the preference into the disallow path
  // and reintroduced the GSD_WORKFLOW_MCP_STRUCTURED_QUESTIONS=0 trap.
  const originalGsdHome = process.env.GSD_HOME;
  const tempProject = mkdtempSync(join(tmpdir(), "gsd-chat-surface-project-"));
  const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-chat-surface-home-"));

  t.after(() => {
    clearGSDPreferencesCache();
    if (originalGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    rmSync(tempProject, { recursive: true, force: true });
    rmSync(tempGsdHome, { recursive: true, force: true });
  });

  mkdirSync(join(tempProject, ".gsd"), { recursive: true });
  writeFileSync(
    join(tempProject, ".gsd", "PREFERENCES.md"),
    "---\nversion: 1\ndiscussion:\n  question_mode: chat\n---\n",
    "utf-8",
  );
  process.env.GSD_HOME = tempGsdHome;
  clearGSDPreferencesCache();
  assert.equal(getDiscussionQuestionMode(tempProject), "chat");

  const surface = resolveWorkflowQuestionToolSurface({
    workflowServerName: "gsd",
    workflowMcpTools: ["mcp__gsd__*"],
    exactWorkflowMcpTools: ["mcp__gsd__ask_user_questions", "mcp__gsd__gsd_summary_save"],
    env: {},
  });
  assert.deepEqual(surface.disallowedTools, [], "chat mode must not disallow ask_user_questions");
  assert.equal(surface.workflowQuestionsEnabled, true);
});

// ─── Prompt builders ─────────────────────────────────────────────────────────

interface PrefsFixture {
  base: string;
  cleanup: () => void;
}

function setupPrefsFixture(questionMode: "chat" | null): PrefsFixture {
  const originalGsdHome = process.env.GSD_HOME;
  const base = mkdtempSync(join(tmpdir(), "gsd-chat-prompt-"));
  const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-chat-prompt-home-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  if (questionMode) {
    writeFileSync(
      join(base, ".gsd", "PREFERENCES.md"),
      `---\nversion: 1\ndiscussion:\n  question_mode: ${questionMode}\n---\n`,
      "utf-8",
    );
  }
  process.env.GSD_HOME = tempGsdHome;
  clearGSDPreferencesCache();
  return {
    base,
    cleanup: () => {
      clearGSDPreferencesCache();
      if (originalGsdHome === undefined) delete process.env.GSD_HOME;
      else process.env.GSD_HOME = originalGsdHome;
      rmSync(base, { recursive: true, force: true });
      rmSync(tempGsdHome, { recursive: true, force: true });
    },
  };
}

test("#2979: chat mode puts the slice discuss prompt on the plain-text path", async (t) => {
  openDatabase(":memory:");
  const fixture = setupPrefsFixture("chat");
  t.after(() => {
    fixture.cleanup();
    try { closeDatabase(); } catch { /* no DB open */ }
  });

  const prompt = await buildDiscussSlicePrompt("M001", "S1", "Slice", fixture.base, {
    structuredQuestionsAvailable: "false",
  });

  assert.ok(prompt.includes(CHAT_NOTE_MARKER), "chat-mode note must be appended");
  assert.match(prompt, /If `false` is `false`:/, "plain-text question branch must be the live one");
});

test("#2979: dialog mode leaves the slice discuss prompt without the chat note", async (t) => {
  openDatabase(":memory:");
  const fixture = setupPrefsFixture(null);
  t.after(() => {
    fixture.cleanup();
    try { closeDatabase(); } catch { /* no DB open */ }
  });

  const prompt = await buildDiscussSlicePrompt("M001", "S1", "Slice", fixture.base, {
    structuredQuestionsAvailable: "true",
  });

  assert.ok(!prompt.includes(CHAT_NOTE_MARKER), "default dialog mode must be byte-identical (no note)");
  assert.match(prompt, /If `true` is `false`:/, "dialog branch must stay the live one");
});

test("#2979: chat mode note lands on the guided milestone discuss prompt", async (t) => {
  openDatabase(":memory:");
  const fixture = setupPrefsFixture("chat");
  t.after(() => {
    fixture.cleanup();
    try { closeDatabase(); } catch { /* no DB open */ }
  });

  const prompt = await buildDiscussMilestonePrompt("M001", "Test", fixture.base, "false");
  assert.ok(prompt.includes(CHAT_NOTE_MARKER));
  // The note leans on the template's plain-text depth-check branch — keep it real.
  assert.match(prompt, /depth_verification/i);
});

test("#2979: discussQuestionFlag forces plain text in chat mode, passes through otherwise", (t) => {
  const fixture = setupPrefsFixture("chat");
  t.after(() => {
    fixture.cleanup();
  });

  assert.equal(_discussQuestionFlagForTest(fixture.base, "true"), "false");
  assert.equal(_discussQuestionFlagForTest(fixture.base, "false"), "false");
  assert.equal(_discussQuestionFlagForTest(fixture.base, undefined), "false");

  const dialogFixture = setupPrefsFixture(null);
  t.after(() => dialogFixture.cleanup());
  assert.equal(_discussQuestionFlagForTest(dialogFixture.base, "true"), "true");
  assert.equal(_discussQuestionFlagForTest(dialogFixture.base, "false"), "false");
  assert.equal(_discussQuestionFlagForTest(dialogFixture.base, undefined), "false");
});

// ─── Chat-mode discussion hold (#2979) ───────────────────────────────────────

function seedSliceContext(mid: string, sid: string, content: string): void {
  insertArtifact({
    path: `.gsd/milestones/${mid}/slices/${sid}/${sid}-CONTEXT.md`,
    artifact_type: "CONTEXT",
    milestone_id: mid,
    slice_id: sid,
    task_id: null,
    full_content: content,
  });
}

test("#2979: hasFreshSliceContext treats a first save as fresh and an unchanged re-discuss as stale", async (t) => {
  openDatabase(":memory:");
  t.after(() => {
    try { closeDatabase(); } catch { /* no DB open */ }
  });

  // No row at all: not fresh.
  assert.equal(hasFreshSliceContext("M001", "S1", null), false);

  seedSliceContext("M001", "S1", "first discussion result");
  const row = getScopedArtifact("M001", "S1", null, "CONTEXT");
  assert.ok(row);
  const token = { importedAt: row.imported_at, content: row.full_content };

  // First discussion: any saved row counts.
  assert.equal(hasFreshSliceContext("M001", "S1", null), true);

  // Re-discuss: the pre-existing row is not a completion signal.
  assert.equal(hasFreshSliceContext("M001", "S1", token), false);

  // A re-save stamps a new imported_at, which the hold observes.
  await new Promise((resolve) => setTimeout(resolve, 5));
  seedSliceContext("M001", "S1", "re-discussed result");
  assert.equal(hasFreshSliceContext("M001", "S1", token), true);
});

test("#2979: a same-millisecond re-save still counts as fresh via the content token", (t) => {
  openDatabase(":memory:");
  t.after(() => {
    try { closeDatabase(); } catch { /* no DB open */ }
  });

  seedSliceContext("M003", "S1", "version one");
  const row = getScopedArtifact("M003", "S1", null, "CONTEXT");
  assert.ok(row);
  const token = { importedAt: row.imported_at, content: row.full_content };

  // Re-save with a fabricated identical imported_at but new content: the
  // content half of the token must still distinguish the save.
  insertArtifact({
    path: `.gsd/milestones/M003/slices/S1/S1-CONTEXT.md`,
    artifact_type: "CONTEXT",
    milestone_id: "M003",
    slice_id: "S1",
    task_id: null,
    full_content: "version two",
  });
  const fresh = getScopedArtifact("M003", "S1", null, "CONTEXT");
  assert.ok(fresh);
  assert.equal(hasFreshSliceContext("M003", "S1", {
    importedAt: fresh.imported_at, // same-ms collision simulated
    content: token.content,
  }), true);
});

test("#2979: waitForFreshSliceContext holds until the artifact row appears", (t) => {
  openDatabase(":memory:");
  t.after(() => {
    try { closeDatabase(); } catch { /* no DB open */ }
  });

  seedSliceContext("M002", "S9", "priming row for a different slice — must not satisfy M002/S1");
  let polls = 0;
  // Real timer yields: the poll must actually wait between checks, like the
  // production 1s delay (an instant delay would spin the loop synchronously).
  const delay = () => new Promise<void>((resolve) => setTimeout(() => {
    polls += 1;
    if (polls === 2) seedSliceContext("M002", "S1", "saved after the user answered in chat");
    resolve();
  }, 1));

  return waitForFreshSliceContext("M002", "S1", null, { delay }).then((completed) => {
    assert.equal(completed, true, "a saved artifact completes the hold");
    assert.equal(polls, 2, "must poll until the row exists");
  });
});

test("#2979: waitForFreshSliceContext ends early when the session leaves", async (t) => {
  openDatabase(":memory:");
  t.after(() => {
    try { closeDatabase(); } catch { /* no DB open */ }
  });

  let polls = 0;
  const delay = () => new Promise<void>((resolve) => setTimeout(() => {
    polls += 1;
    resolve();
  }, 1));
  let triggerLeave: () => void = () => {};
  const leave = new Promise<void>((resolve) => { triggerLeave = resolve; });

  const hold = waitForFreshSliceContext("M004", "S1", null, { delay, leave });
  // Fire the leave while the hold is parked in its first poll race.
  setTimeout(() => triggerLeave(), 5);
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("hold did not end on session leave")), 1_000);
  });

  await Promise.race([hold, timeout]);
  assert.ok(polls >= 1, "hold must have entered its poll loop before leaving");
  // The hold must report the session leave distinctly so the caller exits
  // instead of reopening its picker over a dead session.
  assert.equal(await hold, false);
});
