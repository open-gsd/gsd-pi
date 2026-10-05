// Project/App: gsd-pi
// File Purpose: Single-writer layer for remote_question_prompts — the record of
// a question sent to a remote channel and its answer (see
// db-remote-question-prompt-schema.ts).
//
// A prompt is delivery state of a transport, not workflow state, so it is
// written outside Domain Operations. A question can be asked with no project
// database open: then every reader returns "no row" and every writer writes
// nothing, and the prompt lives only as long as its poll. A write that fails
// is logged and not thrown: the row must not change the result of the question.

import { _getAdapter, isDbAvailable, transaction } from "../engine.js";
import { logWarning } from "../../workflow-logger.js";

export interface RemoteQuestionPromptRow {
  id: string;
  channel: string;
  status: string;
  questions_json: string;
  ref_json: string | null;
  response_json: string | null;
  context_source: string | null;
  created_at: number;
  updated_at: number;
  timeout_at: number;
  poll_interval_ms: number;
  last_poll_at: number | null;
  last_error: string | null;
}

/** Insert the prompt row, or replace the row with the same id. Best-effort. */
export function writeRemoteQuestionPrompt(row: RemoteQuestionPromptRow): void {
  if (!isDbAvailable()) return;
  try {
    transaction(() => _getAdapter()!.prepare(`
      INSERT OR REPLACE INTO remote_question_prompts (
        id, channel, status, questions_json, ref_json, response_json, context_source,
        created_at, updated_at, timeout_at, poll_interval_ms, last_poll_at, last_error
      ) VALUES (
        :id, :channel, :status, :questions_json, :ref_json, :response_json, :context_source,
        :created_at, :updated_at, :timeout_at, :poll_interval_ms, :last_poll_at, :last_error
      )
    `).run({
      ":id": row.id,
      ":channel": row.channel,
      ":status": row.status,
      ":questions_json": row.questions_json,
      ":ref_json": row.ref_json,
      ":response_json": row.response_json,
      ":context_source": row.context_source,
      ":created_at": row.created_at,
      ":updated_at": row.updated_at,
      ":timeout_at": row.timeout_at,
      ":poll_interval_ms": row.poll_interval_ms,
      ":last_poll_at": row.last_poll_at,
      ":last_error": row.last_error,
    }));
  } catch (err) {
    logWarning("db", `remote question prompt ${row.id} was not stored: ${(err as Error).message}`);
  }
}

export function readRemoteQuestionPrompt(id: string): RemoteQuestionPromptRow | null {
  if (!isDbAvailable()) return null;
  const row = _getAdapter()!.prepare(
    "SELECT * FROM remote_question_prompts WHERE id = :id",
  ).get({ ":id": id }) as RemoteQuestionPromptRow | undefined;
  return row ?? null;
}

/** The prompt that changed last, or null when the project has none. */
export function readLatestRemoteQuestionPrompt(): RemoteQuestionPromptRow | null {
  if (!isDbAvailable()) return null;
  const row = _getAdapter()!.prepare(
    "SELECT * FROM remote_question_prompts ORDER BY updated_at DESC, id DESC LIMIT 1",
  ).get() as RemoteQuestionPromptRow | undefined;
  return row ?? null;
}
