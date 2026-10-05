// Project/App: gsd-pi
// File Purpose: Behavior tests for remote question prompts as database rows: the record of a prompt and the resume of an unanswered one.

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
  const fixture: SlackFixture = {
    home, dbPath: join(base, ".gsd", "gsd.db"), answered: new Set(), posted: [], polled: [],
  };

  const saved = {
    home: process.env.GSD_HOME,
    token: process.env.SLACK_BOT_TOKEN,
    disabled: process.env.GSD_DISABLE_REMOTE_QUESTIONS,
  };
  process.env.GSD_HOME = home;
  process.env.SLACK_BOT_TOKEN = ["xoxb", "test"].join("-");
  delete process.env.GSD_DISABLE_REMOTE_QUESTIONS;
  saveRemoteQuestionsConfig("slack", CHANNEL_ID);

  const json = (body: unknown) => ({
    ok: true,
    status: 200,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  }) as Response;
  const fetchMock = mock.method(globalThis, "fetch", async (url: string | URL) => {
    const href = String(url);
    if (href.includes("/auth.test")) return json({ ok: true, user_id: "bot-1" });
    if (href.includes("/chat.postMessage")) {
      const ts = `${fixture.posted.length + 1}00.000`;
      fixture.posted.push(ts);
      return json({ ok: true, ts, channel: CHANNEL_ID });
    }
    if (href.includes("/reactions.get")) {
      const ts = new URL(href).searchParams.get("timestamp") ?? "";
      fixture.polled.push(ts);
      return json({
        ok: true,
        message: { reactions: fixture.answered.has(ts) ? [{ name: "two", count: 1, users: ["human-1"] }] : [] },
      });
    }
    if (href.includes("/conversations.replies")) return json({ ok: true, messages: [] });
    return json({ ok: true });
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

  openDatabase(fixture.dbPath);
  return fixture;
}

/** The state a stopped process leaves: a prompt in the channel that waits for its answer. */
function seedUnansweredPrompt(id: string, messageTs: string, timeoutAt: number): void {
  writePromptRecord(createPromptRecord({
    id,
    channel: "slack",
    createdAt: Date.now() - 1000,
    timeoutAt,
    pollIntervalMs: 5000,
    context: { source: "ask_user_questions" },
    questions: QUESTIONS.map((question) => ({ ...question, allowMultiple: false })),
  }));
  const ref: RemotePromptRef = {
    id, channel: "slack", messageId: messageTs, threadTs: messageTs, channelId: CHANNEL_ID,
  };
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

test("a prompt that waits in the channel is polled again after a restart, and no second message is sent", async (t) => {
  const slack = slackFixture(t);
  seedUnansweredPrompt("prompt-before-restart", "777.000", Date.now() + 60_000);

  // Restart: only the database carries the prompt. The user answered meanwhile.
  closeDatabase();
  openDatabase(slack.dbPath);
  slack.answered.add("777.000");

  const result = await tryRemoteQuestions(QUESTIONS);

  assert.deepEqual(slack.posted, [], "the user must not get the question a second time");
  assert.deepEqual(slack.polled, ["777.000"], "the stored message is the one that is polled");
  assert.equal(result!.details!["promptId"], "prompt-before-restart");
  assert.deepEqual(JSON.parse(result!.content[0]!.text), { answers: { q1: { answers: ["JSON array"] } } });

  const record = readPromptRecord("prompt-before-restart");
  assert.equal(record?.status, "answered");
  assert.deepEqual(record?.response, { answers: { q1: { answers: ["JSON array"] } } });
  assert.equal(promptRows().length, 1, "no second prompt row");
});

test("an unanswered prompt past its timeout, or with other questions, is not resumed: a new message is sent", async (t) => {
  const slack = slackFixture(t);
  seedUnansweredPrompt("prompt-timed-out", "777.000", Date.now() - 1);
  slack.answered.add("777.000");
  slack.answered.add("100.000");
  slack.answered.add("200.000");

  const result = await tryRemoteQuestions(QUESTIONS);
  assert.deepEqual(slack.posted, ["100.000"]);
  assert.notEqual(result!.details!["promptId"], "prompt-timed-out");
  assert.equal(readPromptRecord("prompt-timed-out")?.status, "pending", "the old prompt is not answered by the new one");

  seedUnansweredPrompt("prompt-other-questions", "888.000", Date.now() + 60_000);
  await tryRemoteQuestions([{ ...QUESTIONS[0]!, question: "Which cache?" }]);
  assert.deepEqual(slack.posted, ["100.000", "200.000"]);
  assert.equal(readPromptRecord("prompt-other-questions")?.status, "pending");
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
