// Project/App: gsd-pi
// File Purpose: Remote question prompt table — the record of a question sent to a remote channel and its answer.

import type { DbAdapter } from "./db-adapter.js";

export function hasRemoteQuestionPromptSchema(db: DbAdapter): boolean {
  return db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'remote_question_prompts'",
  ).get() != null;
}

/**
 * One row for each prompt sent to Slack, Discord or Telegram. `ref_json` is
 * the message in the channel. A row that is 'pending' with a ref is a prompt
 * the user has not answered yet: a later ask of the same questions polls that
 * message again and does not send a second one. Idempotent.
 */
export function createRemoteQuestionPromptSchema(db: DbAdapter): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS remote_question_prompts (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL CHECK (channel IN ('slack', 'discord', 'telegram')),
      status TEXT NOT NULL CHECK (status IN ('pending', 'answered', 'timed_out', 'failed', 'cancelled')),
      questions_json TEXT NOT NULL,
      ref_json TEXT,
      response_json TEXT,
      context_source TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      timeout_at INTEGER NOT NULL,
      poll_interval_ms INTEGER NOT NULL,
      last_poll_at INTEGER,
      last_error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_remote_question_prompts_pending
      ON remote_question_prompts(channel, questions_json) WHERE status = 'pending';
  `);
}
