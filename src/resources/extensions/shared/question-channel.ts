/**
 * Question channel — file-based request/answer protocol between a headless
 * subagent child and its interactive parent (#2713).
 *
 * When a subagent child (launched with GSD_SUBAGENT_CHILD=1, no UI) calls
 * ask_user_questions, it writes a request file into the channel directory the
 * parent exported via GSD_QUESTION_CHANNEL_DIR and waits for the correlated
 * answer file. The parent's subagent extension watches the directory, runs its
 * own question routing (local dialog and/or remote channel) and writes the
 * answer back. Both sides stay terminal-agnostic; the channel only carries
 * question requests, answers, and cancellation.
 *
 * Files (atomic via tmp+rename):
 *   <dir>/<id>.request.json — { id, questions, createdAt }
 *   <dir>/<id>.answer.json  — { id, cancelled?, reason?, content? }
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { Question } from "./tui.js";

export const QUESTION_CHANNEL_DIR_ENV = "GSD_QUESTION_CHANNEL_DIR";

export interface QuestionChannelRequest {
	id: string;
	questions: Question[];
	createdAt: string;
}

export interface QuestionChannelAnswer {
	id: string;
	/** True when the parent cancelled without an answer (child exit, abort, no routing available). */
	cancelled?: true;
	reason?: string;
	/** LLM-facing answers JSON (the same string ask_user_questions returns as content). */
	content?: string;
}

export function questionChannelRequestPath(dir: string, id: string): string {
	return path.join(dir, `${id}.request.json`);
}

export function questionChannelAnswerPath(dir: string, id: string): string {
	return path.join(dir, `${id}.answer.json`);
}

/** Atomic JSON write: tmp file + rename, so readers never see partial files. */
function writeJsonAtomic(filePath: string, value: unknown): void {
	const tmp = `${filePath}.${randomUUID()}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(value, null, "\t"));
	fs.renameSync(tmp, filePath);
}

export function writeQuestionRequest(dir: string, questions: Question[]): QuestionChannelRequest {
	const request: QuestionChannelRequest = {
		id: randomUUID(),
		questions,
		createdAt: new Date().toISOString(),
	};
	writeJsonAtomic(questionChannelRequestPath(dir, request.id), request);
	return request;
}

export function writeQuestionAnswer(dir: string, answer: QuestionChannelAnswer): void {
	writeJsonAtomic(questionChannelAnswerPath(dir, answer.id), answer);
}

/** Parse a request file; returns null for unreadable/malformed files. */
export function readQuestionRequest(filePath: string): QuestionChannelRequest | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as QuestionChannelRequest;
		if (typeof parsed?.id !== "string" || !Array.isArray(parsed?.questions)) return null;
		return parsed;
	} catch {
		return null;
	}
}

/** Parse an answer file; returns null when it does not exist yet. */
export function readQuestionAnswer(dir: string, id: string): QuestionChannelAnswer | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(questionChannelAnswerPath(dir, id), "utf-8")) as QuestionChannelAnswer;
		if (typeof parsed?.id !== "string") return null;
		return parsed;
	} catch {
		return null;
	}
}

/**
 * Wait for the answer to a request. Resolves:
 *   - the parsed answer once it appears,
 *   - null when the channel directory disappears (parent died / cleaned up).
 * Rejects never; poll until `signal` aborts (returns null) so the caller keeps
 * ownership of timeout/cancellation semantics.
 */
export async function waitForQuestionAnswer(
	dir: string,
	id: string,
	options: { pollMs?: number; signal?: AbortSignal } = {},
): Promise<QuestionChannelAnswer | null> {
	const pollMs = options.pollMs ?? 200;
	while (!options.signal?.aborted) {
		if (!fs.existsSync(dir)) return null;
		const answer = readQuestionAnswer(dir, id);
		if (answer) return answer;
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
	return null;
}

/** List pending request files in a channel directory (ids not yet handled). */
export function listPendingRequests(dir: string, handled: Set<string>): QuestionChannelRequest[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const requests: QuestionChannelRequest[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".request.json")) continue;
		const id = entry.slice(0, -".request.json".length);
		if (handled.has(id)) continue;
		const request = readQuestionRequest(path.join(dir, entry));
		if (request) {
			handled.add(id);
			requests.push(request);
		}
	}
	return requests;
}
