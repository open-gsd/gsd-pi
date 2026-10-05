/**
 * Remote Questions — durable prompt store
 *
 * A prompt record is a row of the project database (remote_question_prompts).
 * With no project database open, nothing is stored.
 */

import {
  readLatestRemoteQuestionPrompt,
  readRemoteQuestionPrompt,
  writeRemoteQuestionPrompt,
  type RemoteQuestionPromptRow,
} from "../gsd/db/writers/remote-question-prompts.js";
import type { RemoteChannel, RemotePrompt, RemotePromptRecord, RemotePromptRef, RemoteAnswer, RemotePromptStatus, RemoteQuestion } from "./types.js";

function rowToRecord(row: RemoteQuestionPromptRow): RemotePromptRecord {
  return {
    version: 1,
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status as RemotePromptStatus,
    channel: row.channel as RemoteChannel,
    timeoutAt: row.timeout_at,
    pollIntervalMs: row.poll_interval_ms,
    questions: JSON.parse(row.questions_json) as RemoteQuestion[],
    ...(row.ref_json ? { ref: JSON.parse(row.ref_json) as RemotePromptRef } : {}),
    ...(row.response_json ? { response: JSON.parse(row.response_json) as RemoteAnswer } : {}),
    ...(row.last_poll_at !== null ? { lastPollAt: row.last_poll_at } : {}),
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
    ...(row.context_source !== null ? { context: { source: row.context_source } } : {}),
  } as RemotePromptRecord;
}

export function createPromptRecord(prompt: RemotePrompt): RemotePromptRecord {
  return {
    version: 1,
    id: prompt.id,
    createdAt: prompt.createdAt,
    updatedAt: Date.now(),
    status: "pending",
    channel: prompt.channel,
    timeoutAt: prompt.timeoutAt,
    pollIntervalMs: prompt.pollIntervalMs,
    questions: prompt.questions,
    context: prompt.context,
  };
}

export function writePromptRecord(record: RemotePromptRecord): void {
  writeRemoteQuestionPrompt({
    id: record.id,
    channel: record.channel,
    status: record.status,
    questions_json: JSON.stringify(record.questions),
    ref_json: record.ref ? JSON.stringify(record.ref) : null,
    response_json: record.response ? JSON.stringify(record.response) : null,
    context_source: record.context?.source ?? null,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    timeout_at: record.timeoutAt,
    poll_interval_ms: record.pollIntervalMs,
    last_poll_at: record.lastPollAt ?? null,
    last_error: record.lastError ?? null,
  });
}

export function readPromptRecord(id: string): RemotePromptRecord | null {
  const row = readRemoteQuestionPrompt(id);
  return row ? rowToRecord(row) : null;
}

/** The prompt record that changed last, or null when the project has none. */
export function readLatestPromptRecord(): RemotePromptRecord | null {
  const row = readLatestRemoteQuestionPrompt();
  return row ? rowToRecord(row) : null;
}

export function updatePromptRecord(
  id: string,
  updates: Partial<RemotePromptRecord>,
): RemotePromptRecord | null {
  const current = readPromptRecord(id);
  if (!current) return null;
  const merged = {
    ...current,
    ...updates,
    updatedAt: Date.now(),
  };
  // After spreading, the merged object satisfies one of the union members
  // but TypeScript can't prove it statically. The invariant is maintained
  // by callers: once `ref` is set via markPromptDispatched it is never removed.
  const next = merged as RemotePromptRecord;
  writePromptRecord(next);
  return next;
}

export function markPromptDispatched(id: string, ref: RemotePromptRef): RemotePromptRecord | null {
  return updatePromptRecord(id, { ref, status: "pending" });
}

export function markPromptAnswered(id: string, response: RemoteAnswer): RemotePromptRecord | null {
  return updatePromptRecord(id, { response, status: "answered", lastPollAt: Date.now() });
}

export function markPromptStatus(id: string, status: RemotePromptStatus, lastError?: string): RemotePromptRecord | null {
  return updatePromptRecord(id, {
    status,
    lastPollAt: Date.now(),
    ...(lastError ? { lastError } : {}),
  });
}
