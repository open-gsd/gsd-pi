/**
 * Shared ask_user_questions routing primitives.
 *
 * Used by the ask_user_questions tool itself and by the subagent extension
 * when it routes a headless child's forwarded question in the interactive
 * parent (#2713). Kept in one place so the local/remote race semantics cannot
 * drift between the two callers.
 */

import type { NotificationPreferences } from "../gsd/types.js";
import type { Question, RoundResult } from "./tui.js";

/** @internal Exported for testing only. */
export async function playQuestionBell(
	preferences?: NotificationPreferences,
	stream?: { isTTY?: boolean; write(chunk: string): unknown },
): Promise<void> {
	try {
		const { playNotificationBell } = await import("../gsd/notifications.js");
		playNotificationBell("question", preferences, stream);
	} catch {
		// Best-effort: question rendering must never depend on alert delivery.
	}
}

/** Convert the shared RoundResult into the JSON the LLM expects. */
export function formatForLLM(result: RoundResult): string {
	const answers: Record<string, { answers: string[] }> = {};
	for (const [id, answer] of Object.entries(result.answers)) {
		const list: string[] = [];
		if (Array.isArray(answer.selected)) {
			list.push(...answer.selected);
		} else {
			list.push(answer.selected);
		}
		if (answer.notes) {
			list.push(`user_note: ${answer.notes}`);
		}
		answers[id] = { answers: list };
	}
	return JSON.stringify({ answers });
}

/** Parse the LLM-facing JSON payload back into a RoundResult for TUI rendering. */
export function parseLlmAnswersContent(text: string): RoundResult | null {
	try {
		const parsed = JSON.parse(text) as { answers?: Record<string, { answers?: string[] }> };
		if (!parsed?.answers || typeof parsed.answers !== "object") return null;

		const answers: RoundResult["answers"] = {};
		for (const [id, entry] of Object.entries(parsed.answers)) {
			const list = Array.isArray(entry?.answers) ? [...entry.answers] : [];
			let notes = "";
			const noteIdx = list.findIndex((item) => typeof item === "string" && item.startsWith("user_note:"));
			if (noteIdx >= 0) {
				notes = list.splice(noteIdx, 1)[0].replace(/^user_note:\s*/, "");
			}
			if (list.length === 0) continue;
			answers[id] = {
				selected: list.length === 1 ? list[0] : list,
				notes,
			};
		}
		if (Object.keys(answers).length === 0) return null;
		return { endInterview: false, answers };
	} catch {
		return null;
	}
}

export function isCancelledResultContent(text: string): boolean {
	return /\bwas cancelled before receiving a response\b/i.test(text)
		|| /\bwas interrupted before receiving a response\b/i.test(text);
}

interface RaceableResult {
	content: { type: "text"; text: string }[];
	details?: unknown;
}

/**
 * Race a remote channel dispatch against the local TUI. The first to produce
 * a valid (non-error, non-timeout) result wins. The loser is cancelled via
 * the shared AbortController.
 *
 * If the local TUI responds first, the remote poll is aborted (the message
 * stays in Discord/Slack but polling stops). If remote responds first, the
 * local TUI prompt is cancelled.
 *
 * Returns null only when both sides fail or are cancelled.
 */
export async function raceRemoteAndLocal(
	startRemote: () => Promise<RaceableResult | null>,
	startLocal: () => Promise<RoundResult | null | undefined>,
	controller: AbortController,
	questions: Question[],
): Promise<RaceableResult | null> {
	// Wrap local TUI result into the same shape as remote results
	const localPromise = startLocal().then((result): RaceableResult | null => {
		if (!result || Object.keys(result.answers).length === 0) return null;
		return {
			content: [{ type: "text" as const, text: formatForLLM(result) }],
			details: { questions, response: result, cancelled: false },
		};
	}).catch(() => null);

	const remotePromise = startRemote().then((result): RaceableResult | null => {
		if (!result) return null;
		const details = result.details as Record<string, unknown> | undefined;
		// Treat timeouts and errors as non-wins — let the local TUI win instead
		if (details?.timed_out || details?.error) return null;
		return result;
	}).catch(() => null);

	// Race: first non-null result wins
	const winner = await Promise.race([
		localPromise.then((r) => r ? { source: "local" as const, result: r } : null),
		remotePromise.then((r) => r ? { source: "remote" as const, result: r } : null),
	]);

	if (winner) {
		// Cancel the loser
		controller.abort();
		return winner.result;
	}

	// First to resolve was null — wait for the other
	const [localResult, remoteResult] = await Promise.all([localPromise, remotePromise]);
	controller.abort();
	return localResult ?? remoteResult;
}

export const OTHER_OPTION_LABEL = "None of the above";

/**
 * Sequential ctx.ui.select fallback for callers whose ctx.ui.custom() cannot
 * render the interview UI (RPC mode). Mirrors the ask_user_questions tool
 * fallback, including the free-text note prompt when the user picks
 * "None of the above" (#2715). Returns null when cancelled.
 */
export async function sequentialSelectFallback(
	questions: Question[],
	ctx: { ui: { select: (...args: any[]) => Promise<any>; input: (...args: any[]) => Promise<any> } },
	signal: AbortSignal | undefined,
): Promise<RoundResult | null> {
	const answers: Record<string, { answers: string[] }> = {};
	for (const q of questions) {
		const options = q.options.map((o) => o.label);
		if (!q.allowMultiple) {
			options.push(OTHER_OPTION_LABEL);
		}
		const selected = await ctx.ui.select(
			`${q.header}: ${q.question}`,
			options,
			{ signal, ...(q.allowMultiple ? { allowMultiple: true } : {}) },
		);
		if (selected === undefined) {
			return null;
		}

		// When the user picks "None of the above" on a single-select
		// question, prompt for a free-text explanation so they are not
		// trapped in a re-asking loop (bug #2715).
		let freeTextNote = "";
		const selectedStr = Array.isArray(selected) ? selected[0] : selected;
		if (!q.allowMultiple && selectedStr === OTHER_OPTION_LABEL) {
			const note = await ctx.ui.input(
				`${q.header}: Please explain in your own words`,
				"Type your answer here…",
			);
			if (note) {
				freeTextNote = note;
			}
		}

		const answerList = Array.isArray(selected) ? selected : [selected];
		if (freeTextNote) {
			answerList.push(`user_note: ${freeTextNote}`);
		}
		answers[q.id] = { answers: answerList };
	}
	return {
		endInterview: false,
		answers: Object.fromEntries(
			Object.entries(answers).map(([id, a]) => [
				id,
				{ selected: a.answers.length === 1 ? a.answers[0] : a.answers, notes: "" },
			]),
		),
	};
}
