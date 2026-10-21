/**
 * Parent-side question forwarding (#2713).
 *
 * Watches a child's question channel directory (GSD_QUESTION_CHANNEL_DIR).
 * When the headless child writes a request file, the interactive parent routes
 * the question through its own local/remote question path (the same race the
 * ask_user_questions tool uses) and writes the correlated answer file back.
 *
 * The channel carries only question requests, answers, and cancellation — no
 * orchestration. Multiple concurrent children each get their own channel
 * directory; routed dialogs are serialized module-wide so two children asking
 * at once queue instead of overlapping overlays.
 */

import * as fs from "node:fs";
import { sanitizeError } from "../shared/sanitize.js";
import {
	formatForLLM,
	playQuestionBell,
	raceRemoteAndLocal,
	sequentialSelectFallback,
} from "../shared/question-routing.js";
import {
	listPendingRequests,
	questionChannelRequestPath,
	writeQuestionAnswer,
	type QuestionChannelAnswer,
} from "../shared/question-channel.js";
import { showInterviewRound, type Question } from "../shared/tui.js";

/** Minimal slice of the extension context the parent dialog needs. */
export interface ForwarderQuestionCtx {
	hasUI: boolean;
	/** Extension UI surface (used for the sequential RPC-mode fallback). */
	ui?: unknown;
}

export interface ForwardedQuestionOutcome {
	content?: string;
	cancelled?: true;
	reason?: string;
}

function toAnswer(outcome: ForwardedQuestionOutcome, id: string): QuestionChannelAnswer {
	if (outcome.cancelled) return { id, cancelled: true, reason: outcome.reason };
	return { id, content: outcome.content ?? "" };
}

/** Remote-question surface, injectable for deterministic tests. */
export interface ForwarderRemote {
	configured: boolean;
	tryRemoteQuestions: (
		questions: Question[],
		signal?: AbortSignal,
	) => Promise<{ content: { type: "text"; text: string }[]; details?: unknown } | null>;
}

async function defaultRemote(): Promise<ForwarderRemote> {
	const manager = await import("../remote-questions/manager.js");
	return {
		configured: manager.isRemoteConfigured(),
		tryRemoteQuestions: (questions, signal) => manager.tryRemoteQuestions(questions, signal),
	};
}

/**
 * Route a forwarded question through the parent's own question paths:
 * local interview + remote race, local-only, remote-only, or an explicit
 * cancellation when the parent can neither show a dialog nor dispatch remotely.
 */
export async function routeForwardedQuestion(
	questions: Question[],
	options: {
		questionCtx?: ForwarderQuestionCtx;
		agentName?: string;
		signal?: AbortSignal;
		/** Test override; defaults to the real remote-questions manager. */
		remote?: ForwarderRemote;
	},
): Promise<ForwardedQuestionOutcome> {
	const remote = options.remote ?? await defaultRemote();
	const hasRemote = remote.configured;
	const questionCtx = options.questionCtx;
	const progress = options.agentName ? `subagent: ${options.agentName}` : undefined;

	if (questionCtx?.hasUI || hasRemote) {
		await playQuestionBell();
	}

	// Local interview and remote channel race — identical semantics to the
	// ask_user_questions tool's dual-channel case; the first valid answer wins.
	if (questionCtx?.hasUI && hasRemote) {
		const raceController = new AbortController();
		const onParentAbort = () => raceController.abort();
		options.signal?.addEventListener("abort", onParentAbort, { once: true });
		const interviewCtx = questionCtx as Parameters<typeof showInterviewRound>[2];
		try {
			const raced = await raceRemoteAndLocal(
				() => remote.tryRemoteQuestions(questions, raceController.signal),
				() => showInterviewRound(
					questions,
					{ signal: raceController.signal, overlay: true, progress },
					interviewCtx,
				),
				raceController,
				questions,
			);
			if (raced) return { content: raced.content[0]?.text ?? "" };
			return { cancelled: true, reason: "no response received from local UI or remote channel" };
		} finally {
			options.signal?.removeEventListener("abort", onParentAbort);
		}
	}

	// Local interview only.
	if (questionCtx?.hasUI) {
		const result = await showInterviewRound(
			questions,
			{ signal: options.signal, overlay: true, progress },
			questionCtx as Parameters<typeof showInterviewRound>[2],
		);
		const round = result || await sequentialSelectFallback(
			questions,
			questionCtx as Parameters<typeof sequentialSelectFallback>[1],
			options.signal,
		);
		if (!round || Object.keys(round.answers).length === 0) {
			return { cancelled: true, reason: "parent UI did not return an answer" };
		}
		return { content: formatForLLM(round) };
	}

	// Headless parent with a remote channel — remote only.
	if (hasRemote) {
		const remoteResult = await remote.tryRemoteQuestions(questions, options.signal);
		if (remoteResult) {
			const details = remoteResult.details as Record<string, unknown> | undefined;
			if (details?.timed_out || details?.error) {
				return { cancelled: true, reason: "remote channel returned no answer" };
			}
			return { content: remoteResult.content[0]?.text ?? "" };
		}
		return { cancelled: true, reason: "remote channel configured but returned no result" };
	}

	return { cancelled: true, reason: "no parent UI or remote channel available to answer the question" };
}

export interface QuestionChannelWatcher {
	/** Stop polling, close any open dialog, and wait for in-flight routing. */
	stop: () => Promise<void>;
}

// Module-wide queue: parallel children each run their own watcher; routing
// through one chain keeps concurrent forwarded questions queued (one dialog at
// a time) instead of overlapping overlays.
let routingQueue: Promise<unknown> = Promise.resolve();
function enqueueRouting<T>(task: () => Promise<T>): Promise<T> {
	const next = routingQueue.then(task, task);
	routingQueue = next.catch(() => { /* individual outcomes handled by callers */ });
	return next;
}

/**
 * Watch a child's question channel and answer forwarded requests. The watcher
 * polls (no fs.watch dependency), serializes routing module-wide, and aborts
 * any open dialog when stopped or when the parent signal fires.
 */
export function startQuestionChannelWatcher(options: {
	channelDir: string;
	agentName: string;
	questionCtx?: ForwarderQuestionCtx;
	signal?: AbortSignal;
	pollMs?: number;
	/** Test override; forwarded to routeForwardedQuestion. */
	remote?: ForwarderRemote;
}): QuestionChannelWatcher {
	const handled = new Set<string>();
	let stopped = false;
	let inFlight: Promise<void> | null = null;
	let routingAbort: AbortController | null = null;

	const poll = async (): Promise<void> => {
		if (stopped || inFlight) return;
		const requests = listPendingRequests(options.channelDir, handled);
		if (requests.length === 0) return;
		inFlight = (async () => {
			for (const request of requests) {
				if (stopped) break;
				// The child removes its request when it stops waiting (abort);
				// never open a dialog for a request nobody waits on anymore.
				if (!fs.existsSync(questionChannelRequestPath(options.channelDir, request.id))) continue;
				const controller = new AbortController();
				routingAbort = controller;
				const onParentAbort = () => routingAbort?.abort();
				options.signal?.addEventListener("abort", onParentAbort, { once: true });
				try {
					const outcome = await enqueueRouting(() => routeForwardedQuestion(request.questions, {
						questionCtx: options.questionCtx,
						agentName: options.agentName,
						signal: controller.signal,
						remote: options.remote,
					}));
					writeQuestionAnswer(options.channelDir, toAnswer(outcome, request.id));
				} catch (err) {
					// Fail loud: the child must not wait forever on a routing crash.
					try {
						writeQuestionAnswer(options.channelDir, {
							id: request.id,
							cancelled: true,
							reason: `parent failed to route the question: ${sanitizeError((err as Error).message)}`,
						});
					} catch {
						// Channel already removed (child exited first) — nothing to answer.
					}
				} finally {
					options.signal?.removeEventListener("abort", onParentAbort);
					routingAbort = null;
				}
			}
		})();
		try {
			await inFlight;
		} finally {
			inFlight = null;
		}
	};

	const timer = setInterval(() => { void poll(); }, options.pollMs ?? 250);
	const onSignalAbort = () => { void watcher.stop(); };
	if (options.signal) options.signal.addEventListener("abort", onSignalAbort, { once: true });

	const watcher: QuestionChannelWatcher = {
		stop: async () => {
			if (stopped) return;
			stopped = true;
			clearInterval(timer);
			if (options.signal) options.signal.removeEventListener("abort", onSignalAbort);
			routingAbort?.abort(); // close any open dialog / remote poll
			// Drain the in-flight batch (each remaining routing is aborted and
			// answers cancelled); stopped=true prevents any new batch.
			const current = inFlight;
			if (current) await current.catch(() => { /* routing errors already answered as cancelled */ });
		},
	};

	return watcher;
}
