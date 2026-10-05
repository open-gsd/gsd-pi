// Project/App: gsd-pi
// File Purpose: Behavior tests for remote question prompts as database rows: the record of a prompt and of its answer.

import test, { mock, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { _getAdapter, closeDatabase, isDbAvailable, openDatabase } from "../gsd-db.ts";
import { tryRemoteQuestions } from "../../remote-questions/manager.ts";
import { saveRemoteQuestionsConfig } from "../../remote-questions/remote-command.ts";
import { getLatestPromptSummary } from "../../remote-questions/status.ts";
import {
  createPromptRecord,
  markPromptDispatched,
  readPromptRecord,
  writePromptRecord,
} from "../../remote-questions/store.ts";
import type { RemotePromptRef } from "../../remote-questions/types.ts";

const CHANNEL_ID = "C12345678";

const QUESTIONS = [{
  id: "q1",
  header: "Store",
  question: "Which store?",
  options: [
    { label: "Separate table", description: "More flexible" },
    { label: "JSON array", description: "Simpler" },
  ],
}];

interface SlackFixture {
  home: string;
  dbPath: string;
  /** Message timestamps that Slack reports a user reaction on. */
  answered: Set<string>;
  /** The timestamps of the messages that were posted. */
  posted: string[];
  /** The message timestamps that were polled for a reaction. */
  polled: string[];
}

/** A Slack channel behind a fetch mock, a temp GSD home that configures it, and an open project database. */
function slackFixture(t: TestContext): SlackFixture {
  const home = mkdtempSync(join(tmpdir(), "gsd-remote-prompt-home-"));
  const base = mkdtempSync(join(tmpdir(), "gsd-remote-prompt-base-"));
  mkdirSync(join(base, ".gsd"));
  const dbPath = join(base, ".gsd", "gsd.db");
  const fixture: SlackFixture = { home, dbPath, answered: new Set(), posted: [], polled: [] };

  const saved = {
    home: process.env.GSD_HOME,
    token: process.env.SLACK_BOT_TOKEN,
    disabled: process.env.GSD_DISABLE_REMOTE_QUESTIONS,
  };
  process.env.GSD_HOME = home;
  process.env.SLACK_BOT_TOKEN = ["xoxb", "test"].join("-");
  delete process.env.GSD_DISABLE_REMOTE_QUESTIONS;
  saveRemoteQuestionsConfig("slack", CHANNEL_ID);

  const respond = (href: string): unknown => {
    if (href.includes("/auth.test")) return { ok: true, user_id: "bot-1" };
    if (href.includes("/chat.postMessage")) {
      const ts = `${fixture.posted.length + 1}00.000`;
      fixture.posted.push(ts);
      return { ok: true, ts, channel: CHANNEL_ID };
    }
    if (href.includes("/reactions.get")) {
      const ts = new URL(href).searchParams.get("timestamp") ?? "";
      fixture.polled.push(ts);
      return {
        ok: true,
        message: { reactions: fixture.answered.has(ts) ? [{ name: "two", count: 1, users: ["human-1"] }] : [] },
      };
    }
    if (href.includes("/conversations.replies")) return { ok: true, messages: [] };
    return { ok: true };
  };
  const fetchMock = mock.method(globalThis, "fetch", async (url: string | URL) => {
    const body = respond(String(url));
    return {
      ok: true,
      status: 200,
      async json() { return body; },
      async text() { return JSON.stringify(body); },
    } as Response;
  });

  t.after(() => {
    fetchMock.mock.restore();
    if (isDbAvailable()) closeDatabase();
    for (const [key, value] of [
      ["GSD_HOME", saved.home], ["SLACK_BOT_TOKEN", saved.token], ["GSD_DISABLE_REMOTE_QUESTIONS", saved.disabled],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  });

  openDatabase(dbPath);
  return fixture;
}

/** A prompt in the channel that waits for its answer. */
function seedUnansweredPrompt(id: string, messageId: string, timeoutAt: number): void {
  writePromptRecord(createPromptRecord({
    id,
    channel: "slack",
    createdAt: Date.now() - 1000,
    timeoutAt,
    pollIntervalMs: 5000,
    context: { source: "ask_user_questions" },
    questions: QUESTIONS.map((question) => ({ ...question, allowMultiple: false })),
  }));
  const ref: RemotePromptRef = { id, channel: "slack", messageId, threadTs: messageId, channelId: CHANNEL_ID };
  markPromptDispatched(id, ref);
}

function promptRows(): Array<Record<string, unknown>> {
  return _getAdapter()!.prepare("SELECT * FROM remote_question_prompts ORDER BY created_at, id").all();
}

test("a remote prompt is stored as a database row with its channel message and its answer, and no runtime file", async (t) => {
  const slack = slackFixture(t);
  slack.answered.add("100.000");

  const result = await tryRemoteQuestions(QUESTIONS);

  assert.deepEqual(JSON.parse(result!.content[0]!.text), { answers: { q1: { answers: ["JSON array"] } } });
  const rows = promptRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!["id"], result!.details!["promptId"]);
  assert.equal(rows[0]!["status"], "answered");
  assert.equal(JSON.parse(String(rows[0]!["ref_json"])).messageId, "100.000");
  assert.deepEqual(JSON.parse(String(rows[0]!["response_json"])), { answers: { q1: { answers: ["JSON array"] } } });
  assert.equal(getLatestPromptSummary()?.id, rows[0]!["id"]);
  assert.equal(getLatestPromptSummary()?.status, "answered");
  assert.equal(
    existsSync(join(slack.home, "runtime", "remote-questions")),
    false,
    "no prompt file is written under the GSD home",
  );
});

test("the same questions asked again are sent as a new message, and the earlier prompt is not answered by it", async (t) => {
  const slack = slackFixture(t);
  seedUnansweredPrompt("prompt-before-restart", "777.000", Date.now() + 60_000);
  slack.answered.add("777.000");
  slack.answered.add("100.000");

  const result = await tryRemoteQuestions(QUESTIONS);

  assert.deepEqual(slack.posted, ["100.000"], "the new ask has its own message");
  assert.deepEqual(slack.polled, ["100.000"], "only the new message is polled");
  assert.notEqual(result!.details!["promptId"], "prompt-before-restart");
  assert.equal(readPromptRecord("prompt-before-restart")?.status, "pending", "the earlier prompt is not answered by the new one");
  assert.equal(promptRows().length, 2);
});

test("a remote question is asked and answered with no project database open, and nothing is stored", async (t) => {
  const slack = slackFixture(t);
  closeDatabase();
  slack.answered.add("100.000");

  const result = await tryRemoteQuestions(QUESTIONS);

  assert.deepEqual(JSON.parse(result!.content[0]!.text), { answers: { q1: { answers: ["JSON array"] } } });
  assert.equal(getLatestPromptSummary(), null);
  assert.equal(existsSync(join(slack.home, "runtime", "remote-questions")), false);
});
