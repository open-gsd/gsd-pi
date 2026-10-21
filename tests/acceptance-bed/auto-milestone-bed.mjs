// Project/App: gsd-pi
// File Purpose: Acceptance bed for headless auto mode — runs the real engine
// against a scripted fake-LLM transcript over a one-milestone scratch project
// and reports COMPLETED (milestone finished) or WEDGED (engine blocked/looped).
//
// Usage:
//   GSD_SMOKE_BINARY=$PWD/dist/loader.js node tests/acceptance-bed/auto-milestone-bed.mjs
//
// This is a standalone driver, NOT a *.e2e.test.ts CI test. It never deletes
// its run dir; all artifacts (transcript, stdout.jsonl, stderr.log, .gsd state)
// stay behind for post-mortem.

import { execFileSync, spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRATCH_ROOT = process.env.BED_SCRATCH_ROOT ?? join(canonicalTmpdir(), "gsd-acceptance-bed");

const PENDING_ANSWER = 'export function answer() {\n\treturn "pending";\n}\n';
const READY_ANSWER = 'export function answer() {\n\treturn "ready";\n}\n';

function canonicalTmpdir() {
	try {
		return realpathSync(tmpdir());
	} catch {
		return tmpdir();
	}
}

function bedEnv(extra = {}) {
	const base = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (k.startsWith("GSD_")) continue;
		base[k] = v;
	}
	base.GSD_NON_INTERACTIVE = "1";
	base.TMPDIR = canonicalTmpdir();
	// Shared isolated HOME so gsd's resource sync (~/.gsd/agent/...) never
	// touches the operator's real home; reused across runs (sync is idempotent).
	const home = join(SCRATCH_ROOT, "bed-home");
	mkdirSync(home, { recursive: true });
	base.HOME = home;
	return { ...base, ...extra };
}

function stripAnsi(s) {
	return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function gsd(args, { cwd, timeoutMs = 60_000, env = {} } = {}) {
	const binary = process.env.GSD_SMOKE_BINARY ?? join(REPO_ROOT, "dist", "loader.js");
	const result = spawnSync(process.execPath, [binary, ...args], {
		cwd,
		encoding: "utf8",
		timeout: timeoutMs,
		stdio: ["pipe", "pipe", "pipe"],
		env: bedEnv(env),
		maxBuffer: 64 * 1024 * 1024,
	});
	const stdout = result.stdout ?? "";
	const stderr = result.stderr ?? "";
	return {
		stdout,
		stderr,
		stdoutClean: stripAnsi(stdout),
		stderrClean: stripAnsi(stderr),
		code: result.status,
		signal: result.signal,
		timedOut: result.error?.code === "ETIMEDOUT" || (result.signal === "SIGTERM" && result.status === null),
	};
}

function git(dir, args) {
	execFileSync("git", args, { cwd: dir, stdio: "pipe" });
}

function nextRunDir() {
	mkdirSync(SCRATCH_ROOT, { recursive: true });
	let n = 1;
	for (const entry of readdirSync(SCRATCH_ROOT)) {
		const m = /^bed-run-(\d+)$/.exec(entry);
		if (m) n = Math.max(n, Number(m[1]) + 1);
	}
	const dir = join(SCRATCH_ROOT, `bed-run-${n}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function scaffoldProject(runDir) {
	const dir = join(runDir, "project");
	mkdirSync(join(dir, "src"), { recursive: true });
	mkdirSync(join(dir, "test"), { recursive: true });
	writeFileSync(join(dir, ".gitignore"), ".gsd/\n");
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({ type: "module", scripts: { test: "node --test test/answer.test.js" } }, null, 2) + "\n",
	);
	writeFileSync(join(dir, "src", "answer.js"), PENDING_ANSWER);
	writeFileSync(
		join(dir, "test", "answer.test.js"),
		[
			'import test from "node:test";',
			'import assert from "node:assert/strict";',
			'import { answer } from "../src/answer.js";',
			"",
			'test("answer returns ready", () => {',
			'\tassert.equal(answer(), "ready");',
			"});",
			"",
		].join("\n"),
	);
	git(dir, ["init", "--initial-branch=main"]);
	git(dir, ["config", "user.email", "bed@gsd.test"]);
	git(dir, ["config", "user.name", "GSD Acceptance Bed"]);
	git(dir, ["commit", "--allow-empty", "-m", "init"]);
	git(dir, ["add", ".gitignore", "package.json", "src/answer.js", "test/answer.test.js"]);
	git(dir, ["commit", "-m", "test: seed acceptance bed fixture"]);
	return dir;
}

// Mirrors tests/e2e/headless-auto-pause-blocked.e2e.test.ts writeRecoveredMilestone.
function writeRecoveredMilestone(dir) {
	const milestoneDir = join(dir, ".gsd", "milestones", "M001");
	const sliceDir = join(milestoneDir, "slices", "S01");
	mkdirSync(join(sliceDir, "tasks"), { recursive: true });

	writeFileSync(
		join(milestoneDir, "M001-CONTEXT.md"),
		["# M001: Acceptance Bed Fixture", "", "## Purpose", "Prove auto mode can finish a tiny planned milestone.", ""].join("\n"),
	);
	writeFileSync(
		join(milestoneDir, "M001-ROADMAP.md"),
		[
			"# M001: Acceptance Bed Fixture",
			"",
			"## Slices",
			"",
			"- [ ] **S01: Update answer** `risk:low` `depends:[]`",
			"  > Demo: answer() returns ready.",
			"",
		].join("\n"),
	);
	writeFileSync(
		join(sliceDir, "S01-PLAN.md"),
		[
			"# S01: Update answer",
			"",
			"**Goal:** Make the answer implementation return ready.",
			"",
			"## Tasks",
			"",
			"- [ ] **T01: Update answer implementation** `est:5m`",
			"",
			"### T01: Update answer implementation",
			"",
			"Inputs:",
			"- `src/answer.js`",
			"",
			"Expected Output:",
			"- `src/answer.js`",
			"",
			"Verification:",
			"- Verify: `node --test test/answer.test.js` exits 0.",
			"",
			"## Files Likely Touched",
			"",
			"- `src/answer.js`",
			"",
			"## Verification",
			"",
			"- Verify: `node --test test/answer.test.js` exits 0.",
			"",
		].join("\n"),
	);
	// Recovery artifact verification requires a per-task plan artifact when the
	// tasks/ dir exists (artifact-verification.ts: "task artifact missing").
	writeFileSync(
		join(sliceDir, "tasks", "T01-PLAN.md"),
		[
			"---",
			"estimated_steps: 1",
			"estimated_files: 1",
			"---",
			"",
			"# T01: Update answer implementation",
			"",
			"**Slice:** S01 — Update answer",
			"**Milestone:** M001",
			"",
			"## Description",
			"",
			"Change `src/answer.js` so `answer()` returns `ready`, then run the verification command.",
			"",
			"## Steps",
			"",
			"1. Edit `src/answer.js` so the exported function returns \"ready\".",
			"2. Run `node --test test/answer.test.js` and confirm it exits 0.",
			"",
			"## Must-Haves",
			"",
			"- [ ] `answer()` returns \"ready\".",
			"",
			"## Verification",
			"",
			"- Verify: `node --test test/answer.test.js` exits 0.",
			"",
			"## Expected Output",
			"",
			"- `src/answer.js` — returns \"ready\".",
			"",
		].join("\n"),
	);
}

function recoverWithApproval(dir) {
	const preview = gsd(["headless", "recover"], { cwd: dir, timeoutMs: 60_000 });
	const previewHash = /re-run with --preview=(sha256:[0-9a-f]{64})/u.exec(preview.stderrClean)?.[1];
	if (!previewHash) {
		throw new Error(`no recovery preview hash. stderr:\n${preview.stderrClean.slice(0, 2000)}`);
	}
	const approved = gsd(["headless", "recover", `--preview=${previewHash}`], { cwd: dir, timeoutMs: 60_000 });
	if (approved.code !== 0) {
		throw new Error(`recover approval exit ${approved.code}. stderr:\n${approved.stderrClean.slice(0, 2000)}`);
	}
	return { preview, approved };
}

async function computeTestedSourceRevision(dir) {
	// Snapshot must reflect the post-edit source (like the tiny-milestone e2e).
	const mod = await import(
		pathToFileURL(join(REPO_ROOT, "dist", "resources", "extensions", "gsd", "verification-source-integrity.js")).href
	);
	// Pre-apply the engine's idempotent `.gitignore` baseline (auto-start.ts runs
	// ensureGitignore at bootstrap). Without this the tracked `.gitignore` mutates
	// AFTER we hash, so validate-milestone's anti-stale-evidence check correctly
	// rejects the precomputed revision (#1660). Same pattern as the tiny-milestone
	// e2e, which calls ensureGitignore before snapshotting.
	const gitignoreMod = await import(
		pathToFileURL(join(REPO_ROOT, "dist", "resources", "extensions", "gsd", "gitignore.js")).href
	);
	gitignoreMod.ensureGitignore(dir);
	writeFileSync(join(dir, "src", "answer.js"), READY_ANSWER);
	const source = mod.captureVerificationSourceSnapshot([{ id: "project", cwd: dir }]);
	writeFileSync(join(dir, "src", "answer.js"), PENDING_ANSWER);
	if (!source.ok) throw new Error(`source snapshot failed: ${source.error}`);
	return source.snapshot.aggregateRevision;
}

// Transcript: the fake agent plausibly executes the already-planned T01, then
// walks the closeout ladder. No `expect` fields — mismatches surface as engine
// behavior, which is what the bed measures. Trailing text turns absorb extra
// provider invocations so transcript exhaustion (a fake-llm throw → provider
// error pause) cannot masquerade as an engine wedge.
function buildTranscript(testedSourceRevision, workingDirectory) {
	const turns = [];
	const tool = (id, name, input) =>
		turns.push({ turn: turns.length + 1, emit: { kind: "tool_use", calls: [{ id, name, input }] } });
	const text = (t) => turns.push({ turn: turns.length + 1, emit: { kind: "text", text: t } });

	tool("write-source", "write", { path: "src/answer.js", content: READY_ANSWER });
	tool("verify-source", "bash", { command: "node --test test/answer.test.js", timeout: 30 });
	tool("complete-task", "gsd_task_complete", {
		taskId: "T01",
		sliceId: "S01",
		milestoneId: "M001",
		oneLiner: "Updated answer() to return ready.",
		narrative: "Changed the answer module and verified the behavior with the planned command.",
		verification: "`node --test test/answer.test.js` exited 0.",
		deviations: "None.",
		knownIssues: "None.",
		keyFiles: ["src/answer.js"],
		keyDecisions: ["Keep the fixture to one source file so the workflow signal is isolated."],
		blockerDiscovered: false,
		verificationEvidence: [
			{ command: "node --test test/answer.test.js", exitCode: 0, verdict: "pass", durationMs: 100 },
		],
	});
	text("Task T01 complete.");
	tool("complete-slice", "gsd_slice_complete", {
		sliceId: "S01",
		milestoneId: "M001",
		sliceTitle: "Update answer",
		oneLiner: "The answer module now returns ready.",
		narrative: "The only planned task changed the source module and verified the behavior.",
		verification: "`node --test test/answer.test.js` exited 0.",
		uatContent: "# UAT\n\nPASS: answer() returns ready.\n",
		deviations: "None.",
		knownLimitations: "None.",
		followUps: "None.",
		keyFiles: ["src/answer.js"],
		keyDecisions: ["Keep the milestone fixture intentionally tiny."],
		filesModified: [{ path: "src/answer.js", description: "answer() now returns ready." }],
	});
	text("Slice S01 complete.");
	tool("validate-milestone", "gsd_validate_milestone", {
		milestoneId: "M001",
		verdict: "pass",
		remediationRound: 0,
		successCriteriaChecklist: "- PASS: answer() returns ready. Evidence: S01 summary and task verification.",
		sliceDeliveryAudit:
			"| Slice | Status | Evidence |\n| --- | --- | --- |\n| S01 | PASS | S01 summary and task summary are present. |",
		crossSliceIntegration: "Single-slice milestone; no cross-slice boundary exists.",
		requirementCoverage: "R001 is covered by S01/T01 and verified by `node --test test/answer.test.js`.",
		verificationClasses:
			"| Class | Planned Check | Evidence | Verdict |\n| --- | --- | --- | --- |\n| Contract | Local command exits 0. | `node --test test/answer.test.js` exited 0 in T01. | PASS |",
		verificationEvidence: [
			{
				verificationClass: "Contract",
				evidenceClass: "command",
				commandOrTool: "node --test test/answer.test.js",
				workingDirectory,
				startedAt: new Date(Date.now() - 60_000).toISOString(),
				endedAt: new Date().toISOString(),
				exitCode: 0,
				observation: "passed",
				durableOutputRef: "command://node-test/answer",
				testedSourceRevision,
				environment: { runtime: "node", suite: "test/answer.test.js" },
				rationale: "The planned Contract command passed against the current source.",
			},
		],
		verdictRationale: "All planned source, task, slice, requirement, and contract evidence passed.",
	});
	text("Milestone M001 validation complete - verdict: pass.");
	tool("complete-milestone", "gsd_complete_milestone", {
		milestoneId: "M001",
		title: "Acceptance Bed Fixture",
		oneLiner: "Updated one source module and verified it locally.",
		narrative:
			"Auto mode executed the planned task, verified it, completed the slice, validated the milestone, and closed it.",
		verificationPassed: true,
		successCriteriaResults: "- PASS: answer() returns ready.",
		definitionOfDoneResults: "- PASS: source changed.\n- PASS: verification command exited 0.",
		requirementOutcomes: "Covered by S01/T01.",
		keyDecisions: ["Use a tiny isolated fixture for the acceptance bed."],
		keyFiles: ["src/answer.js"],
		lessonsLearned: ["The bed exercises the real auto-mode dispatch loop."],
		followUps: "None.",
		deviations: "None.",
	});
	text("Milestone M001 complete.");
	// Generous filler: any extra dispatches get a plain acknowledgement instead
	// of a fake-llm exhaustion throw.
	for (let i = 0; i < 20; i++) text("Acknowledged. No further action required.");
	return turns;
}

function parseJsonEvents(stdout) {
	const events = [];
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed);
			if (parsed && typeof parsed === "object" && "type" in parsed) events.push(parsed);
		} catch {
			// non-JSON preamble
		}
	}
	return events;
}

function classify(result, events) {
	const notifications = events
		.filter((e) => e.type === "extension_ui_request" && e.method === "notify")
		.map((e) => String(e.message ?? ""));

	const completed =
		result.code === 0 &&
		notifications.some((m) => /auto-mode stopped/i.test(m) && /milestone m001 complete|all milestones complete/i.test(m));
	if (completed) return { result: "COMPLETED", firstBlock: null, notifications };

	const transcriptBug = notifications.find((m) => /fake-llm/i.test(m)) ?? (/fake-llm/i.test(result.stderrClean) ? "fake-llm error in stderr" : null);

	// The engine's own terminal guard message is authoritative for a wedge.
	const terminalGuard = notifications.find((m) => /^auto-mode (blocked|paused|stopped with an issue)/i.test(m)) ?? null;
	// First contributing engine-side cause: tool errors surfaced in tool results
	// plus the guard-flavored notifications that preceded the terminal block.
	const toolErrors = events
		.filter((e) => e.type === "tool_execution_end")
		.map((e) => {
			const text = JSON.stringify(e.result ?? {});
			const m = /Error [a-z]+ing [a-z]+: ([^"\\]+)/.exec(text);
			return m ? `${e.toolName}: ${m[1]}` : null;
		})
		.filter(Boolean);
	const contributing = [
		...toolErrors,
		...notifications.filter((m) =>
			/verify-fail|policy rejection|handed off|drift|conflict|waiting for|migration failed/i.test(m),
		),
	];

	if (transcriptBug && !terminalGuard) {
		return {
			result: "INCONCLUSIVE",
			firstBlock: { guard: "transcript-bug (fake-llm)", message: String(transcriptBug).slice(0, 500) },
			notifications,
		};
	}
	if (terminalGuard || result.code === 10) {
		return {
			result: "WEDGED",
			firstBlock: {
				guard: terminalGuard
					? terminalGuard.split("\n")[0].slice(0, 200)
					: `exit code ${result.code} with no pause notification`,
				message: [terminalGuard ?? result.stderrClean.slice(-400), ...contributing.slice(0, 5).map((c) => `cause: ${c}`)].join("\n"),
			},
			notifications,
		};
	}
	return {
		result: "INCONCLUSIVE",
		firstBlock: {
			guard: `exit ${result.code}${result.timedOut ? " (harness timeout)" : ""}`,
			message: result.stderrClean.slice(-800),
		},
		notifications,
	};
}

async function main() {
	const runDir = nextRunDir();
	console.error(`[bed] run dir: ${runDir}`);
	const projectDir = scaffoldProject(runDir);
	writeRecoveredMilestone(projectDir);

	const { preview, approved } = recoverWithApproval(projectDir);
	writeFileSync(join(runDir, "recover-preview.stderr.log"), preview.stderr);
	writeFileSync(join(runDir, "recover-approved.stderr.log"), approved.stderr);
	console.error("[bed] recover approved (exit 0)");

	const testedSourceRevision = await computeTestedSourceRevision(projectDir);
	const turns = buildTranscript(testedSourceRevision, projectDir);
	const transcriptPath = join(runDir, "transcript.jsonl");
	writeFileSync(transcriptPath, turns.map((t) => JSON.stringify(t)).join("\n") + "\n");

	console.error("[bed] running headless auto (cap ~90s)...");
	const result = gsd(
		[
			"headless",
			"--output-format",
			"stream-json",
			"--events",
			"extension_ui_request,message_start,message_end,agent_end,tool_execution_start,tool_execution_end",
			"--model",
			"gsd-fake-model",
			"--timeout",
			"90000",
			"--max-restarts",
			"0",
			"auto",
		],
		{
			cwd: projectDir,
			timeoutMs: 120_000,
			env: { GSD_FAKE_LLM_TRANSCRIPT: transcriptPath },
		},
	);

	writeFileSync(join(runDir, "stdout.jsonl"), result.stdout);
	writeFileSync(join(runDir, "stderr.log"), result.stderr);

	const events = parseJsonEvents(result.stdoutClean);
	const verdictBits = classify(result, events);

	// Preserve .gsd state for post-mortem (skip nothing; it is small).
	try {
		cpSync(join(projectDir, ".gsd"), join(runDir, "gsd-state"), { recursive: true });
	} catch {
		// best-effort forensics copy
	}
	writeFileSync(join(runDir, "notifications.log"), verdictBits.notifications.join("\n") + "\n");

	const verdict = {
		result: verdictBits.result,
		firstBlock: verdictBits.firstBlock,
		exitCode: result.code,
		runDir,
	};
	writeFileSync(join(runDir, "verdict.json"), JSON.stringify(verdict, null, 2) + "\n");
	console.log(JSON.stringify(verdict, null, 2));
	process.exitCode = verdictBits.result === "COMPLETED" ? 0 : verdictBits.result === "WEDGED" ? 10 : 1;
}

main().catch((err) => {
	console.error(`[bed] driver failure: ${err?.stack ?? err}`);
	console.log(JSON.stringify({ result: "INCONCLUSIVE", firstBlock: { guard: "driver-failure", message: String(err?.message ?? err) }, exitCode: null, runDir: null }, null, 2));
	process.exitCode = 1;
});
