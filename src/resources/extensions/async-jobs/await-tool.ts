/**
 * await_job tool — wait for one or more background jobs to complete.
 *
 * If specific job IDs are provided, waits for those jobs.
 * If omitted, waits for any running job to complete.
 */

import type { ToolDefinition } from "@gsd/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { AsyncJobManager, Job } from "./job-manager.js";

const DEFAULT_TIMEOUT_SECONDS = 120;

const schema = Type.Object({
	jobs: Type.Optional(
		Type.Array(Type.String(), {
			description: "Job IDs to wait for. Omit to wait for any running job.",
		}),
	),
	timeout: Type.Optional(
		Type.Number({
			description:
				"Maximum seconds to wait before returning control. Defaults to 120. " +
				"Jobs continue running in the background after timeout.",
		}),
	),
});

export function createAwaitTool(getManager: () => AsyncJobManager): ToolDefinition<typeof schema> {
	return {
		name: "await_job",
		label: "Await Background Job",
		description:
			"Wait for background jobs to complete. Provide specific job IDs or omit to wait for the next job that finishes. Returns results of completed jobs.",
		parameters: schema,
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const manager = getManager();
			const { jobs: jobIds, timeout } = params;
			const timeoutMs = ((timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000);

			let watched: Job[];
			if (jobIds && jobIds.length > 0) {
				watched = [];
				const notFound: string[] = [];
				for (const id of jobIds) {
					const job = manager.getJob(id);
					if (job) {
						watched.push(job);
					} else {
						notFound.push(id);
					}
				}
				if (notFound.length > 0 && watched.length === 0) {
					return {
						content: [{ type: "text", text: `No jobs found: ${notFound.join(", ")}` }],
						details: undefined,
					};
				}
			} else {
				watched = manager.getRunningJobs();
				if (watched.length === 0) {
					return {
						content: [{ type: "text", text: "No running background jobs." }],
						details: undefined,
					};
				}
			}

			// If all watched jobs are already done, suppress follow-up and return immediately.
			// suppressFollowUp() cancels the pending delivery timer (if any), which
			// handles both the within-turn case (job completes while we await) and
			// the cross-turn case (job already completed before await_job was called).
			// Previously this only set j.awaited = true, which missed the cross-turn
			// case because the queueMicrotask had already fired (#3787).
			const running = watched.filter((j) => j.status === "running");
			if (running.length === 0) {
				for (const j of watched) manager.suppressFollowUp(j.id);
				return { content: [{ type: "text", text: renderCompleted(watched) }], details: undefined };
			}

			// Wait for at least one to complete, timeout, or abort signal
			const TIMEOUT_SENTINEL = Symbol("timeout");
			const ABORT_SENTINEL = Symbol("abort");

			// The race timer and abort listener are explicitly torn down once the race
			// settles (below) so a completion- or timeout-won race never leaks a pending
			// timer or a lingering abort listener — the listener holds a closure over the
			// race resolver, so { once: true } alone (which only detaches on fire) is not
			// enough when ESC never happens.
			let raceTimer: ReturnType<typeof setTimeout> | undefined;
			let abortListener: (() => void) | undefined;
			const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
				raceTimer = setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutMs);
				// Allow the process to exit even if the timer is pending
				if (typeof raceTimer === "object" && "unref" in raceTimer) raceTimer.unref();
			});

			const abortPromise = new Promise<typeof ABORT_SENTINEL>((resolve) => {
				if (!signal || signal.aborted) {
					resolve(ABORT_SENTINEL);
				} else {
					abortListener = () => resolve(ABORT_SENTINEL);
					signal.addEventListener("abort", abortListener, { once: true });
				}
			});

			const raceResult = await Promise.race([
				Promise.race(running.map((j) => j.promise)).then(() => "completed" as const),
				timeoutPromise,
				abortPromise,
			]);

			// Tear down race resources now that a winner is decided.
			if (raceTimer) clearTimeout(raceTimer);
			if (abortListener && signal) signal.removeEventListener("abort", abortListener);

			const aborted = raceResult === ABORT_SENTINEL;
			const timedOut = raceResult === TIMEOUT_SENTINEL;

			// Collect all completed results (more may have finished while waiting)
			const completed = watched.filter((j) => j.status !== "running");
			const stillRunning = watched.filter((j) => j.status === "running");

			// Suppress follow-up ONLY for completed jobs — leave stillRunning unsuppressed
			// so deliverResult/onJobComplete can resurface their results later.
			for (const j of completed) manager.suppressFollowUp(j.id);

			if (aborted) {
				// ESC ended the wait, not the jobs: still-running jobs keep going and
				// resurface via onJobComplete (they were deliberately not suppressed above).
				const runningDesc = stillRunning.map((j) => `${j.id} (${j.label})`).join(", ");
				const interrupt = stillRunning.length > 0
					? `Wait interrupted. Still running: ${runningDesc} — results will surface when complete.`
					: "Wait interrupted.";
				const text = completed.length > 0
					? `${renderCompleted(completed)}\n\n${interrupt}`
					: interrupt;
				return { content: [{ type: "text", text }], details: undefined };
			}

			let result = renderCompleted(completed);
			if (stillRunning.length > 0) {
				result += `\n\n**Still running:** ${stillRunning.map((j) => `${j.id} (${j.label})`).join(", ")}`;
			}
			if (timedOut) {
				result += `\n\n⏱ **Timed out** after ${timeout ?? DEFAULT_TIMEOUT_SECONDS}s waiting for jobs to finish. ` +
					`Jobs are still running in the background. ` +
					`Use \`await_job\` again later or \`async_bash\` + \`await_job\` for shorter polling intervals.`;
			}

			return { content: [{ type: "text", text: result }], details: undefined };
		},
	};
}

/**
 * Render completed jobs for the await_job result, de-duplicating against
 * follow-ups that have already been delivered to context.
 *
 * A job's follow-up fires ~immediately (setTimeout(0)) once it settles, so when
 * await_job runs in a LATER turn the result is already in context. Reprinting it
 * inline produces the same output twice. Jobs already `delivered` are therefore
 * acknowledged on a single line instead of having their full output reprinted;
 * not-yet-delivered jobs (the within-turn case, where suppressFollowUp won the
 * race) are rendered in full as before.
 */
function renderCompleted(jobs: Job[]): string {
	if (jobs.length === 0) return "No completed jobs.";

	const fresh = jobs.filter((j) => !j.delivered);
	const alreadyDelivered = jobs.filter((j) => j.delivered);

	const sections: string[] = [];
	if (fresh.length > 0) sections.push(formatResults(fresh));
	if (alreadyDelivered.length > 0) {
		const names = alreadyDelivered
			.map((j) => `${j.id} (${j.label})`)
			.join(", ");
		const sentence =
			alreadyDelivered.length === 1
				? `This job already finished and its result was shown above when it completed, so there is nothing new to report: ${names}.`
				: `These jobs already finished and their results were shown above when they completed, so there is nothing new to report: ${names}.`;
		sections.push(sentence);
	}
	return sections.join("\n\n");
}

function formatResults(jobs: Job[]): string {
	if (jobs.length === 0) return "No completed jobs.";

	const parts: string[] = [];
	for (const job of jobs) {
		const elapsed = ((Date.now() - job.startTime) / 1000).toFixed(1);
		const header = `### ${job.id} — ${job.label} (${job.status}, ${elapsed}s)`;

		if (job.status === "completed") {
			parts.push(`${header}\n\n${job.resultText ?? "(no output)"}`);
		} else if (job.status === "failed") {
			parts.push(`${header}\n\nError: ${job.errorText ?? "unknown error"}`);
		} else if (job.status === "cancelled") {
			parts.push(`${header}\n\nCancelled.`);
		}
	}

	return parts.join("\n\n---\n\n");
}
