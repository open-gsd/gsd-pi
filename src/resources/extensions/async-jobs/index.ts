/**
 * Async Jobs Extension
 *
 * Allows bash commands to run in the background. The agent gets a job ID
 * immediately and can continue working. Results are delivered via follow-up
 * messages when jobs complete.
 *
 * Tools:
 *   async_bash — run a command in the background, get a job ID
 *   await_job  — wait for background jobs to complete, get results
 *   cancel_job — cancel a running background job
 *
 * Commands:
 *   /jobs — show running and recent background jobs
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { AsyncJobManager, type Job } from "./job-manager.js";
import { createAsyncBashTool } from "./async-bash-tool.js";
import { createAwaitTool } from "./await-tool.js";
import { createCancelJobTool } from "./cancel-job-tool.js";

export default function AsyncJobs(pi: ExtensionAPI) {
	let manager: AsyncJobManager | null = null;
	let latestCwd: string = process.cwd();

	function getManager(): AsyncJobManager {
		if (!manager) {
			throw new Error("AsyncJobManager not initialized. Wait for session_start.");
		}
		return manager;
	}

	function getCwd(): string {
		return latestCwd;
	}

	// ── Session lifecycle ──────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		latestCwd = ctx.cwd;

		manager = new AsyncJobManager({
			onJobComplete: (job) => {
				if (job.awaited) return;
				const statusEmoji = job.status === "completed" ? "done" : "error";
				const elapsed = ((Date.now() - job.startTime) / 1000).toFixed(1);
				const output = job.status === "completed"
					? job.resultText ?? "(no output)"
					: `Error: ${job.errorText ?? "unknown error"}`;

				// Truncate output for the follow-up message
				const maxLen = 2000;
				const truncatedOutput = output.length > maxLen
					? output.slice(0, maxLen) + "\n\n[... truncated, use await_job for full output]"
					: output;

				// Deliver as follow-up without triggering a new LLM turn (#875).
				// When the agent is streaming: the message is queued and picked up
				// by the agent loop's getFollowUpMessages() after the current turn.
				// When the agent is idle: the message is appended to context so it's
				// visible on the next user-initiated prompt. Previously triggerTurn:true
				// caused spurious autonomous turns — the model would interpret completed
				// job output as requiring action and cascade into unbounded self-reinforcing
				// loops (running more commands, spawning more jobs, burning context).
				pi.sendMessage(
					{
						customType: "async_job_result",
						content: [
							`**Background job ${statusEmoji}: ${job.id}** (${job.label}, ${elapsed}s)`,
							"",
							truncatedOutput,
						].join("\n"),
						display: true,
					},
					{ deliverAs: "followUp" },
				);
			},
		});
	});

	pi.on("session_before_switch", async () => {
		if (manager) {
			// Cancel all running background jobs — their results are no longer
			// relevant to the new session and would produce wasteful follow-up
			// notifications that trigger empty LLM turns (#1642).
			for (const job of manager.getRunningJobs()) {
				manager.cancel(job.id);
			}
		}
	});

	pi.on("session_shutdown", async () => {
		if (manager) {
			manager.shutdown();
			manager = null;
		}
	});

	// ── Tools ──────────────────────────────────────────────────────────────

	pi.registerTool(createAsyncBashTool(getManager, getCwd));
	pi.registerTool(createAwaitTool(getManager));
	pi.registerTool(createCancelJobTool(getManager));

	// ── /jobs command ──────────────────────────────────────────────────────

	pi.registerCommand("jobs", {
		description: "Show running and recent background jobs",
		handler: async (_args: string, _ctx: ExtensionCommandContext) => {
			if (!manager) {
				pi.sendMessage({
					customType: "async_jobs_list",
					content: "No async job manager active.",
					display: true,
				});
				return;
			}

			const ctx = _ctx;
			const running = manager.getRunningJobs();
			const recent = manager.getRecentJobs(10);
			const completed = recent.filter((j) => j.status !== "running");

			// Interactive kill-picker when there are running jobs and a UI is available
			if (running.length > 0 && ctx.hasUI) {
				// Kill-picker loop: each iteration shows live running jobs.
				// Step 1 picks a job (neutral label — selecting does NOT cancel yet);
				// step 2 confirms before the destructive cancel. Labels deliberately
				// omit a live elapsed time: ctx.ui.select renders the option strings
				// once and never refreshes them, so a "(24s)" baked into the label
				// would freeze and mislead. Accurate elapsed times are shown in the
				// post-picker summary (rebuilt fresh) instead.
				const DONE = "Close";
				while (true) {
					const liveJobs = manager.getRunningJobs();
					if (liveJobs.length === 0) break;

					// Map display label -> job id so we never parse ids back out of
					// free-form label text.
					const labelToId = new Map<string, string>();
					for (const j of liveJobs) {
						labelToId.set(`${j.id} — ${j.label} (running)`, j.id);
					}
					const options = [...labelToId.keys(), DONE];

					const choice = await ctx.ui.select(
						"Background jobs — pick one to cancel, Escape to close",
						options,
					);

					// ESC returns undefined; headless may return string[]; DONE closes
					if (!choice || typeof choice !== "string" || choice === DONE) break;

					const id = labelToId.get(choice);
					if (!id) break;

					const job = liveJobs.find((j) => j.id === id);
					const confirmed = await ctx.ui.confirm(
						"Cancel background job?",
						`This will stop ${id}${job ? ` — ${job.label}` : ""}. Other jobs keep running.`,
					);
					if (!confirmed) continue;

					const r = manager.cancel(id);
					ctx.ui.notify(
						r === "cancelled" ? `Job ${id} cancelled.` : `Job ${id}: ${r}`,
						r === "cancelled" ? "success" : "warning",
					);
				}

				// After picker, send a summary of any still-running jobs
				const stillRunning = manager.getRunningJobs();
				const summaryLines: string[] = ["## Background Jobs"];
				if (stillRunning.length > 0) {
					summaryLines.push("", "### Running");
					for (const job of stillRunning) {
						const elapsed = ((Date.now() - job.startTime) / 1000).toFixed(0);
						summaryLines.push(`- **${job.id}** — ${job.label} (${elapsed}s)`);
					}
				}
				const recentCompleted = manager.getRecentJobs(10).filter((j) => j.status !== "running");
				if (recentCompleted.length > 0) {
					summaryLines.push("", "### Recent");
					for (const job of recentCompleted) {
						const elapsed = ((Date.now() - job.startTime) / 1000).toFixed(1);
						summaryLines.push(`- **${job.id}** — ${job.label} (${job.status}, ${elapsed}s)`);
					}
				}
				if (stillRunning.length === 0 && recentCompleted.length === 0) {
					summaryLines.push("", "No background jobs.");
				}

				pi.sendMessage({
					customType: "async_jobs_list",
					content: summaryLines.join("\n"),
					display: true,
				});
				return;
			}

			// Text-only display: headless/RPC mode, or no running jobs
			const lines: string[] = ["## Background Jobs"];

			if (running.length === 0 && completed.length === 0) {
				lines.push("", "No background jobs.");
			} else {
				if (running.length > 0) {
					lines.push("", "### Running");
					for (const job of running) {
						const elapsed = ((Date.now() - job.startTime) / 1000).toFixed(0);
						lines.push(`- **${job.id}** — ${job.label} (${elapsed}s)`);
					}
				}

				if (completed.length > 0) {
					lines.push("", "### Recent");
					for (const job of completed) {
						const elapsed = ((Date.now() - job.startTime) / 1000).toFixed(1);
						lines.push(`- **${job.id}** — ${job.label} (${job.status}, ${elapsed}s)`);
					}
				}
			}

			pi.sendMessage({
				customType: "async_jobs_list",
				content: lines.join("\n"),
				display: true,
			});
		},
	});
}
