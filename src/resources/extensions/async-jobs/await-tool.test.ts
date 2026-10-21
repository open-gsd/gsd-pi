/**
 * await-tool.test.ts — Tests for await_job timeout behavior.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { AsyncJobManager } from "./job-manager.ts";
import { createAwaitTool } from "./await-tool.ts";

function getTextFromResult(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((c) => c.text ?? "").join("\n");
}

const noopSignal = new AbortController().signal;

test("await_job returns immediately when no running jobs exist", async () => {
	const manager = new AsyncJobManager();
	const tool = createAwaitTool(() => manager);

	const result = await tool.execute("tc1", {}, noopSignal, () => {}, undefined as never);
	const text = getTextFromResult(result);
	assert.match(text, /No running background jobs/);
});

test("await_job returns immediately when all watched jobs are already completed", async () => {
	const manager = new AsyncJobManager();
	const tool = createAwaitTool(() => manager);

	// Register a job that completes instantly
	const jobId = manager.register("bash", "fast-job", async () => "done");
	// Wait for the job to settle
	const job = manager.getJob(jobId)!;
	await job.promise;

	const result = await tool.execute("tc2", { jobs: [jobId] }, noopSignal, () => {}, undefined as never);
	const text = getTextFromResult(result);
	assert.match(text, /fast-job/);
	assert.match(text, /completed/);
});

test("await_job returns on timeout when jobs are still running", async () => {
	const manager = new AsyncJobManager();
	const tool = createAwaitTool(() => manager);

	// Register a job that takes a long time
	const jobId = manager.register("bash", "slow-job", async (_signal) => {
		return new Promise<string>((resolve) => {
			const timer = setTimeout(() => resolve("finally done"), 60_000);
			if (typeof timer === "object" && "unref" in timer) timer.unref();
		});
	});

	const start = Date.now();
	const result = await tool.execute("tc3", { jobs: [jobId], timeout: 1 }, noopSignal, () => {}, undefined as never);
	const elapsed = Date.now() - start;
	const text = getTextFromResult(result);

	// Should have timed out within ~1-2 seconds, not 60
	assert.ok(elapsed < 5_000, `Expected timeout in ~1s but took ${elapsed}ms`);
	assert.match(text, /Timed out/);
	assert.match(text, /Still running/);
	assert.match(text, /slow-job/);

	// Cleanup
	manager.cancel(jobId);
	manager.shutdown();
});

test("await_job completes before timeout when job finishes quickly", async () => {
	const manager = new AsyncJobManager();
	const tool = createAwaitTool(() => manager);

	// Register a job that completes in 100ms
	const jobId = manager.register("bash", "quick-job", async () => {
		return new Promise<string>((resolve) => setTimeout(() => resolve("quick result"), 100));
	});

	const start = Date.now();
	const result = await tool.execute("tc4", { jobs: [jobId], timeout: 30 }, noopSignal, () => {}, undefined as never);
	const elapsed = Date.now() - start;
	const text = getTextFromResult(result);

	// Should complete in ~100ms, well before the 30s timeout
	assert.ok(elapsed < 5_000, `Expected quick completion but took ${elapsed}ms`);
	assert.ok(!text.includes("Timed out"), "Should not have timed out");
	assert.match(text, /quick-job/);
	assert.match(text, /completed/);

	manager.shutdown();
});

test("await_job uses default timeout of 120s when not specified", async () => {
	const manager = new AsyncJobManager();
	const tool = createAwaitTool(() => manager);

	// Register a job that completes immediately
	const jobId = manager.register("bash", "instant-job", async () => "instant");
	const job = manager.getJob(jobId)!;
	await job.promise;

	// Call without timeout param — should work fine for already-done jobs
	const result = await tool.execute("tc5", { jobs: [jobId] }, noopSignal, () => {}, undefined as never);
	const text = getTextFromResult(result);
	assert.match(text, /instant-job/);
	assert.match(text, /completed/);

	manager.shutdown();
});

test("await_job returns not-found message for invalid job IDs", async () => {
	const manager = new AsyncJobManager();
	const tool = createAwaitTool(() => manager);

	const result = await tool.execute("tc6", { jobs: ["bg_nonexistent"] }, noopSignal, () => {}, undefined as never);
	const text = getTextFromResult(result);
	assert.match(text, /No jobs found/);
	assert.match(text, /bg_nonexistent/);

	manager.shutdown();
});

test("await_job suppresses follow-up for jobs that complete while awaiting (#2248)", async () => {
	const followUps: string[] = [];
	const manager = new AsyncJobManager({
		onJobComplete: (job) => followUps.push(job.id),
	});
	const tool = createAwaitTool(() => manager);

	// Register a job that completes in 50ms
	const jobId = manager.register("bash", "awaited-job", async () => {
		return new Promise<string>((resolve) => setTimeout(() => resolve("result"), 50));
	});

	// await_job consumes the result — suppressFollowUp() should cancel delivery timer
	await tool.execute("tc7", { jobs: [jobId] }, noopSignal, () => {}, undefined as never);

	// Give the onJobComplete callback a tick to fire (if suppression failed)
	await new Promise((r) => setTimeout(r, 50));

	assert.equal(followUps.length, 0, "onJobComplete should not fire for jobs consumed by await_job");

	manager.shutdown();
});

test("await_job suppresses follow-up for already-completed jobs (cross-turn case) (#3787)", async () => {
	// This is the key regression: job completes in a prior LLM turn, then
	// await_job is called in a later turn. The delivery timer must still be
	// cancellable at that point.
	const followUps: string[] = [];
	const manager = new AsyncJobManager({
		onJobComplete: (job) => followUps.push(job.id),
	});
	const tool = createAwaitTool(() => manager);

	// Register and let the job complete fully before calling await_job
	const jobId = manager.register("bash", "pre-completed-job", async () => "done");
	const job = manager.getJob(jobId)!;
	await job.promise;

	// Simulate a "later turn" by yielding to the event loop — this lets any
	// queueMicrotask callbacks run, but the setTimeout(0) delivery timer has
	// not yet fired (it's scheduled for the next macrotask).
	await new Promise((r) => setImmediate(r));

	// Now call await_job — suppressFollowUp() should cancel the pending timer
	await tool.execute("tc7b", { jobs: [jobId] }, noopSignal, () => {}, undefined as never);

	// Drain the macrotask queue — the (now-cancelled) timer would have fired here
	await new Promise((r) => setTimeout(r, 50));

	assert.equal(
		followUps.length,
		0,
		"onJobComplete should not fire for already-completed jobs consumed by await_job",
	);

	manager.shutdown();
});

test("await_job aborts promptly when signal fires; job keeps running and is not suppressed", async () => {
	const manager = new AsyncJobManager();
	const tool = createAwaitTool(() => manager);

	// Register a job that would run for 60s
	const jobId = manager.register("bash", "long-job", async (_signal) => {
		return new Promise<string>((resolve) => {
			const timer = setTimeout(() => resolve("finally done"), 60_000);
			if (typeof timer === "object" && "unref" in timer) timer.unref();
		});
	});

	const ac = new AbortController();
	// Abort after ~100ms
	const abortTimer = setTimeout(() => ac.abort(), 100);
	if (typeof abortTimer === "object" && "unref" in abortTimer) (abortTimer as NodeJS.Timeout).unref();

	const start = Date.now();
	const result = await tool.execute("tc_abort1", { jobs: [jobId], timeout: 60 }, ac.signal, () => {}, undefined as never);
	const elapsed = Date.now() - start;
	const text = getTextFromResult(result);

	// Should abort quickly (within ~100ms + overhead), not wait for full timeout
	assert.ok(elapsed < 5_000, `Expected abort in ~100ms but took ${elapsed}ms`);
	assert.match(text, /interrupted/i);

	// Job should still be running (not killed)
	const job = manager.getJob(jobId)!;
	assert.equal(job.status, "running", "Job should still be running after abort");
	// Job should NOT be marked awaited — results must resurface later
	assert.ok(!job.awaited, "Job should not be suppressed after abort");

	// Cleanup
	manager.cancel(jobId);
	manager.shutdown();
});

test("after abort, a still-running job resurfaces via onJobComplete", async () => {
	const followUps: string[] = [];
	const manager = new AsyncJobManager({
		onJobComplete: (job) => {
			if (!job.awaited) followUps.push(job.id);
		},
	});
	const tool = createAwaitTool(() => manager);

	// Register a job that resolves after ~150ms
	const jobId = manager.register("bash", "resurface-job", async () => {
		return new Promise<string>((resolve) => {
			const timer = setTimeout(() => resolve("done"), 150);
			if (typeof timer === "object" && "unref" in timer) (timer as NodeJS.Timeout).unref();
		});
	});

	const ac = new AbortController();
	// Abort the await at ~50ms (before the job completes at ~150ms)
	const abortTimer = setTimeout(() => ac.abort(), 50);
	if (typeof abortTimer === "object" && "unref" in abortTimer) (abortTimer as NodeJS.Timeout).unref();

	const result = await tool.execute("tc_abort2", { jobs: [jobId], timeout: 10 }, ac.signal, () => {}, undefined as never);
	const text = getTextFromResult(result);
	assert.match(text, /interrupted/i);

	// Wait longer than the job's natural completion time (150ms) + delivery timer (0ms) + buffer
	await new Promise((r) => setTimeout(r, 350));

	// The job should have completed and the follow-up should have fired
	// (because we did NOT suppress it on abort)
	assert.ok(followUps.includes(jobId), `Expected job ${jobId} to resurface via onJobComplete, but got: ${followUps.join(", ")}`);

	manager.shutdown();
});

test("await_job does not reprint a job whose follow-up was already delivered (no duplicate-in-context)", async () => {
	// Real cross-turn timing: a job completes in a prior turn, its setTimeout(0)
	// follow-up FIRES (delivered to context), and only THEN does await_job run in a
	// later turn. The earlier #3787 test masked this by advancing with setImmediate,
	// which races ahead of setTimeout(0); a real turn boundary does not. await_job
	// must acknowledge the already-delivered job tersely instead of reprinting its
	// full output (which would duplicate it in context).
	const followUps: string[] = [];
	const manager = new AsyncJobManager({
		onJobComplete: (job) => {
			if (!job.awaited) followUps.push(job.id);
		},
	});
	const tool = createAwaitTool(() => manager);

	const jobId = manager.register("bash", "already-delivered-job", async () => "THE_RESULT_TEXT");
	await manager.getJob(jobId)!.promise;

	// Real macrotask gap — generously long so the setTimeout(0) delivery fires even
	// if the CI event loop is briefly starved (a tight 25ms could race the precondition).
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(followUps.length, 1, "follow-up should have been delivered before the later-turn await_job");

	const result = await tool.execute("tc_dup", { jobs: [jobId] }, noopSignal, () => {}, undefined as never);
	const text = getTextFromResult(result);

	// The full output must NOT be reprinted (it is already in context via the follow-up).
	assert.ok(
		!text.includes("THE_RESULT_TEXT"),
		`await_job must not reprint already-delivered output, got:\n${text}`,
	);
	// It should still acknowledge the job so the agent knows the wait resolved.
	assert.match(text, /already-delivered-job/);
	// Single already-delivered job must use grammatical singular wording, not
	// the plural form (regression: "These job ... their results ... they completed").
	assert.match(text, /This job already finished and its result was shown above when it completed/);
	assert.doesNotMatch(text, /These job\b/);

	manager.shutdown();
});

test("await_job still renders full output for a job consumed within the same turn (not yet delivered)", async () => {
	// Within-turn case: await_job wins the race against the delivery timer, so the
	// follow-up is suppressed and never delivered. Here await_job IS the only place
	// the result surfaces, so it must render the full output.
	const followUps: string[] = [];
	const manager = new AsyncJobManager({
		onJobComplete: (job) => {
			if (!job.awaited) followUps.push(job.id);
		},
	});
	const tool = createAwaitTool(() => manager);

	const jobId = manager.register("bash", "within-turn-job", async () => {
		return new Promise<string>((resolve) => setTimeout(() => resolve("WITHIN_TURN_OUTPUT"), 40));
	});

	const result = await tool.execute("tc_within", { jobs: [jobId] }, noopSignal, () => {}, undefined as never);
	const text = getTextFromResult(result);

	assert.equal(followUps.length, 0, "within-turn await must suppress the follow-up");
	assert.match(text, /WITHIN_TURN_OUTPUT/, "within-turn await must render the full output inline");

	manager.shutdown();
});

test("unawaited jobs still get follow-up delivery (#2248)", async () => {
	const followUps: string[] = [];
	const manager = new AsyncJobManager({
		onJobComplete: (job) => {
			if (!job.awaited) followUps.push(job.id);
		},
	});

	// Register a fire-and-forget job
	const jobId = manager.register("bash", "fire-and-forget", async () => "done");
	const job = manager.getJob(jobId)!;
	await job.promise;

	// Give the callback a tick
	await new Promise((r) => setTimeout(r, 50));

	assert.equal(followUps.length, 1, "onJobComplete should deliver follow-up for unawaited jobs");
	assert.equal(followUps[0], jobId);

	manager.shutdown();
});
