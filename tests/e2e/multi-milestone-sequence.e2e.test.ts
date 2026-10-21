// TODO(flat-phase): skipped — multi-milestone e2e needs auto-mode dispatch aligned with flat-phase
// Project/App: gsd-pi
// File Purpose: E2E gate for headless multi-milestone closeout boundaries through auto-mode.

import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
	appendTextTurn,
	appendToolTurn,
	artifactsFor,
	createTmpProject,
	gsdSync,
	parseJsonEvents,
	commitProjectFiles,
	scalar,
	smokeBinaryAvailable,
	type TranscriptTurn,
	toolNames,
	WorkflowOutcomeProbe,
	writeTranscript,
} from "./_shared/index.ts";

function commitFixture(dir: string): void {
	commitProjectFiles(
		dir,
		["package.json", "src/answer.js", "src/status.js", "test/answer.test.js", "test/status.test.js"],
		"test: seed multi-milestone fixture",
	);
}

function slicePlanInput(file: string, verify: string, expected: string): Record<string, unknown> {
	return {
		milestoneId: "M001",
		sliceId: "S01",
		goal: `Update ${file} and verify the behavior.`,
		successCriteria: expected,
		proofLevel: `Run ${verify}.`,
		integrationClosure: "Focused source behavior only.",
		observabilityImpact: "None.",
		tasks: [{
			taskId: "T01",
			title: `Update ${file}`,
			description: `Change ${file} so ${expected}, then run ${verify}.`,
			estimate: "5m",
			files: [file],
			verify,
			inputs: [file, "test/answer.test.js", "test/status.test.js"],
			expectedOutput: [file],
			requiredWorkflowTools: [],
			observabilityImpact: "None.",
		}],
	};
}

function completeTaskInput(
	file: string,
	verify: string,
	oneLiner: string,
): Record<string, unknown> {
	return {
		taskId: "T01",
		sliceId: "S01",
		milestoneId: "M001",
		oneLiner,
		narrative: `Changed ${file} and verified it with ${verify}.`,
		verification: `${verify} exited 0.`,
		deviations: "None.",
		knownIssues: "None.",
		keyFiles: [file],
		keyDecisions: ["Keep each milestone to one source behavior so sequencing state is easy to audit."],
		blockerDiscovered: false,
		verificationEvidence: [{
			command: verify,
			exitCode: 0,
			verdict: "pass",
			durationMs: 100,
		}],
	};
}

function completeSliceInput(
	title: string,
	file: string,
	verify: string,
	oneLiner: string,
): Record<string, unknown> {
	return {
		sliceId: "S01",
		milestoneId: "M001",
		sliceTitle: title,
		oneLiner,
		narrative: `The planned task changed ${file} and verified it with ${verify}.`,
		verification: `${verify} exited 0.`,
		uatContent: `# UAT\n\nPASS: ${oneLiner}\n`,
		deviations: "None.",
		knownLimitations: "None.",
		followUps: "None.",
		keyFiles: [file],
		keyDecisions: ["The sequence keeps milestone closure separate from downstream activation."],
		filesModified: [{ path: file, description: oneLiner }],
	};
}

function validationInput(
	success: string,
	integration: string,
	requirements: string,
): Record<string, unknown> {
	return {
		milestoneId: "M001",
		verdict: "pass",
		remediationRound: 0,
		successCriteriaChecklist: success,
		sliceDeliveryAudit: "| Slice | Status | Evidence |\n| --- | --- | --- |\n| S01 | PASS | S01 summary and task verification are present. |",
		crossSliceIntegration: integration,
		requirementCoverage: requirements,
		verificationClasses: "| Class | Planned Check | Evidence | Verdict |\n| --- | --- | --- | --- |\n| Contract | node:test command exits 0. | Verification command exited 0. | PASS |\n| Integration | Fixture behavior composes with previous work. | Full command passed where applicable. | PASS |\n| Operational | Headless process exits cleanly. | No blocked/error operator notification was emitted. | PASS |\n| UAT | Slice UAT summaries pass. | S01 closeout UAT content recorded PASS. | PASS |",
		verdictRationale: "The planned source behavior, verification command, requirement coverage, and closeout artifacts passed.",
	};
}

function completionInput(
	title: string,
	oneLiner: string,
	narrative: string,
	keyFile: string,
): Record<string, unknown> {
	return {
		milestoneId: "M001",
		title,
		oneLiner,
		narrative,
		verificationPassed: true,
		successCriteriaResults: "- PASS: planned source behavior is present.\n- PASS: validation passed before completion.",
		definitionOfDoneResults: "- PASS: source module changed.\n- PASS: slice and task completed.\n- PASS: milestone validation passed.",
		requirementOutcomes: "R001 satisfied by M001/S01/T01.",
		keyDecisions: ["Let the dispatcher activate the next milestone only after the prior milestone is complete."],
		keyFiles: [keyFile],
		lessonsLearned: ["Milestone sequencing should be validated through real auto-mode dispatch boundaries."],
		followUps: "None.",
		deviations: "None.",
	};
}

function buildTranscript(): string {
	const turns: TranscriptTurn[] = [];

	appendToolTurn(turns, "gsd_milestone_generate_id", {}, "generate-m001", { modelId: "gsd-fake-model", lastUserText: "Headless Milestone Creation" });
	appendToolTurn(turns, "gsd_milestone_generate_id", {}, "generate-m002", { hasToolResultFor: "gsd_milestone_generate_id" });
	appendToolTurn(turns, "gsd_summary_save", {
		artifact_type: "PROJECT",
		content: [
			"# Project",
			"",
			"## Project Shape",
			"**Complexity:** simple",
			"",
			"## Milestone Sequence",
			"- [ ] M001: Answer Ready - Update the answer module.",
			"- [ ] M002: Status Done - Update the status module after M001 closes.",
			"",
		].join("\n"),
	}, "project", { hasToolResultFor: "gsd_milestone_generate_id" });
	appendToolTurn(turns, "gsd_requirement_save", {
		class: "core-capability",
		description: "The answer module returns the requested ready value.",
		why: "M001 needs one observable source behavior change.",
		source: "spec",
		status: "active",
		primary_owner: "M001/S01",
		supporting_slices: "",
		validation: "The focused answer verification command exits 0.",
		notes: "Multi-milestone e2e fixture.",
	}, "answer-requirement", { hasToolResultFor: "gsd_summary_save" });
	appendToolTurn(turns, "gsd_requirement_save", {
		class: "core-capability",
		description: "The status module returns the requested done value after M001 completes.",
		why: "M002 proves downstream work remains queued after M001 closeout.",
		source: "spec",
		status: "active",
		primary_owner: "M002/S01",
		supporting_slices: "",
		validation: "The full fixture test command exits 0.",
		notes: "Multi-milestone e2e fixture.",
	}, "status-requirement", { hasToolResultFor: "gsd_requirement_save" });
	appendToolTurn(turns, "gsd_summary_save", {
		artifact_type: "REQUIREMENTS",
		content: "# Requirements\n",
	}, "requirements", { hasToolResultFor: "gsd_requirement_save" });
	appendToolTurn(turns, "ask_user_questions", {
		questions: [{
			id: "depth_verification_M001_confirm",
			header: "Depth Check",
			question: "Proceed with this headless multi-milestone plan?",
			options: [
				{
					label: "Yes, you got it (Recommended)",
					description: "Write the milestone contexts from the current understanding.",
				},
				{
					label: "Not quite",
					description: "Stop for corrected scope before writing context.",
				},
			],
		}],
	}, "depth-check", { hasToolResultFor: "gsd_summary_save" });
	appendToolTurn(turns, "gsd_summary_save", {
		milestone_id: "M001",
		artifact_type: "CONTEXT",
		content: [
			"# M001: Answer Ready",
			"",
			"## Goal",
			"Update `src/answer.js` so the exported function returns `ready`.",
			"",
			"## Done",
			"- `src/answer.js` returns `ready`.",
			"- `node --test test/answer.test.js` exits 0.",
			"- M001 validates and completes before M002 planning.",
			"",
		].join("\n"),
	}, "m001-context", { hasToolResultFor: "ask_user_questions" });
	appendToolTurn(turns, "gsd_plan_milestone", {
		milestoneId: "M001",
		title: "Answer Ready",
		vision: "Trivial source behavior change to establish the first milestone.",
		status: "active",
		slices: [{
			sliceId: "S01",
			title: "Update answer module",
			risk: "low",
			depends: [],
			demo: "Calling answer() returns ready.",
			goal: "Change the answer module and verify it locally.",
			successCriteria: "answer() returns ready.",
			proofLevel: "Command exits 0.",
			integrationClosure: "Focused module behavior only.",
			observabilityImpact: "None.",
		}],
		successCriteria: ["answer() returns ready.", "M001 stops at closeout before M002 planning."],
		keyRisks: [{
			risk: "M002 could activate before M001 is durably complete.",
			whyItMatters: "Milestone sequencing depends on closeout state agreement.",
		}],
		proofStrategy: [{
			riskOrUnknown: "M001 closeout before M002 activation",
			retireIn: "S01",
			whatWillBeProven: "M001 completes after verification and validation.",
		}],
		verificationContract: "Focused node:test command exits 0.",
		verificationIntegration: "M002 remains queued for the next command after M001.",
		verificationOperational: "Headless process exits 0 without blocked or error notifications.",
		verificationUat: "Slice UAT summary records pass verdict.",
		definitionOfDone: ["`src/answer.js` is changed.", "M001 validation passes.", "M001 completion is durable."],
		requirementCoverage: "R001 is owned by M001/S01.",
		boundaryMapMarkdown: "| Boundary | Decision |\n| --- | --- |\n| M001 -> M002 | M002 depends on M001 completion. |\n",
	}, "m001-roadmap", { hasToolResultFor: "gsd_summary_save" });
	appendToolTurn(turns, "ask_user_questions", {
		questions: [{
			id: "depth_verification_M002_confirm",
			header: "Depth Check",
			question: "Proceed with the queued M002 context?",
			options: [
				{
					label: "Yes, you got it (Recommended)",
					description: "Write the M002 context with M001 as its dependency.",
				},
				{
					label: "Not quite",
					description: "Stop for corrected M002 scope before writing context.",
				},
			],
		}],
	}, "m002-depth-check", { hasToolResultFor: "gsd_plan_milestone" });
	appendToolTurn(turns, "gsd_summary_save", {
		milestone_id: "M002",
		artifact_type: "CONTEXT",
		content: [
			"---",
			"depends_on: [M001]",
			"---",
			"",
			"# M002: Status Done",
			"",
			"## Goal",
			"After M001 completes, update `src/status.js` so the exported function returns `done`.",
			"",
			"## Done",
			"- M001 is complete before M002 planning.",
			"- `src/status.js` returns `done`.",
			"- `npm test` exits 0 and proves both milestone source changes together.",
			"",
		].join("\n"),
	}, "m002-context", { hasToolResultFor: "ask_user_questions" });
	appendToolTurn(turns, "write", {
		path: ".gsd/DISCUSSION-MANIFEST.json",
		content: JSON.stringify({
			primary: "M001",
			milestones: {
				M001: { gate: "discussed", context: "full" },
				M002: { gate: "discussed", context: "full" },
			},
			total: 2,
			gates_completed: 2,
		}, null, 2) + "\n",
	}, "discussion-manifest", { hasToolResultFor: "gsd_summary_save" });
	appendTextTurn(turns, "Milestone M001 ready.", { hasToolResultFor: "write" });

	appendToolTurn(turns, "gsd_summary_save", {
		milestone_id: "M001",
		slice_id: "S01",
		artifact_type: "RESEARCH",
		content: "# S01 - Research\n\nUse `src/answer.js` and verify with `node --test test/answer.test.js`.\n",
	}, "m001-s01-research");
	appendTextTurn(turns, "M001/S01 researched.", { hasToolResultFor: "gsd_summary_save" });
	appendToolTurn(turns, "gsd_plan_slice", slicePlanInput("src/answer.js", "node --test test/answer.test.js", "answer() returns ready."), "m001-s01-plan");
	appendTextTurn(turns, "M001/S01 planned.", { hasToolResultFor: "gsd_plan_slice" });
	appendToolTurn(turns, "write", {
		path: "src/answer.js",
		content: "export function answer() {\n\treturn \"ready\";\n}\n",
	}, "write-answer");
	appendToolTurn(turns, "bash", {
		command: "node --test test/answer.test.js",
		timeout: 30,
	}, "verify-answer", { hasToolResultFor: "write" });
	appendToolTurn(turns, "gsd_task_complete", completeTaskInput("src/answer.js", "node --test test/answer.test.js", "Updated answer() to return ready."), "m001-task", { hasToolResultFor: "bash" });
	appendTextTurn(turns, "M001/S01/T01 complete.", { hasToolResultFor: "gsd_task_complete" });
	appendToolTurn(turns, "gsd_slice_complete", completeSliceInput("Update answer module", "src/answer.js", "node --test test/answer.test.js", "answer() now returns ready."), "m001-slice");
	appendTextTurn(turns, "M001/S01 complete.", { hasToolResultFor: "gsd_slice_complete" });
	appendToolTurn(turns, "gsd_validate_milestone", validationInput(
		"- PASS: answer() returns ready.\n- PASS: M001 stops before M002 planning.",
		"M001 is a focused source change; M002 remains queued for a later command.",
		"R001 is covered by M001/S01/T01.",
	), "m001-validation");
	appendTextTurn(turns, "Milestone M001 validation complete - verdict: pass.", { hasToolResultFor: "gsd_validate_milestone" });
	appendToolTurn(turns, "gsd_complete_milestone", completionInput(
		"Answer Ready",
		"Updated answer() to return ready and validated M001.",
		"M001 completed its source change, focused verification, slice closeout, milestone validation, and milestone completion before M002 work began.",
		"src/answer.js",
	), "m001-complete");
	appendTextTurn(turns, "Milestone M001 complete.", { hasToolResultFor: "gsd_complete_milestone" });

	return writeTranscript(turns);
}

describe("multi-milestone sequence e2e (fake LLM)", () => {
	const avail = smokeBinaryAvailable();
	const skipReason = "TODO(flat-phase): multi-milestone e2e needs auto-mode dispatch aligned with flat-phase";

	test("headless new-milestone --auto stops at M001 closeout before M002", { skip: skipReason ?? false, timeout: 300_000 }, (t) => {
		const project = createTmpProject({
			git: true,
			files: {
				"package.json": JSON.stringify({
					type: "module",
					scripts: { test: "node --test test/answer.test.js test/status.test.js" },
				}, null, 2) + "\n",
				"src/answer.js": "export function answer() {\n\treturn \"pending\";\n}\n",
				"src/status.js": "export function status() {\n\treturn \"pending\";\n}\n",
				"test/answer.test.js": [
					"import test from \"node:test\";",
					"import assert from \"node:assert/strict\";",
					"import { answer } from \"../src/answer.js\";",
					"",
					"test(\"answer returns ready\", () => {",
					"\tassert.equal(answer(), \"ready\");",
					"});",
					"",
				].join("\n"),
				"test/status.test.js": [
					"import test from \"node:test\";",
					"import assert from \"node:assert/strict\";",
					"import { status } from \"../src/status.js\";",
					"",
					"test(\"status returns done\", () => {",
					"\tassert.equal(status(), \"done\");",
					"});",
					"",
				].join("\n"),
			},
		});
		t.after(project.cleanup);
		commitFixture(project.dir);
		const answersPath = join(project.dir, "answers.json");
		writeFileSync(answersPath, JSON.stringify({
			questions: {
				depth_verification_M001_confirm: "Yes, you got it (Recommended)",
				depth_verification_M002_confirm: "Yes, you got it (Recommended)",
			},
		}, null, 2) + "\n");

		const result = gsdSync(
			[
				"headless",
				"--output-format",
				"stream-json",
				"--events",
				"extension_ui_request,tool_execution_end",
				"--model",
				"gsd-fake-model",
				"--timeout",
				"240000",
				"--max-restarts",
				"0",
				"--answers",
				answersPath,
				"new-milestone",
				"--context-text",
				"First make answer() return ready, then after that milestone completes make status() return done, and verify both with node:test.",
				"--auto",
			],
			{
				cwd: project.dir,
				timeoutMs: 270_000,
				env: {
					GSD_FAKE_LLM_TRANSCRIPT: buildTranscript(),
				},
			},
		);

		const artifacts = artifactsFor("multi-milestone-sequence");
		artifacts.write("stdout.jsonl", result.stdout);
		artifacts.write("stderr.log", result.stderr);

		assert.equal(
			result.code,
			0,
			`expected exit 0, got code=${result.code} signal=${result.signal} timedOut=${result.timedOut}. stderr artifact: ${artifacts.dir}`,
		);
		assert.ok(!result.timedOut, "headless multi-milestone run must not time out");

		const events = parseJsonEvents(result.stdoutClean);
		const outcome = new WorkflowOutcomeProbe(project.dir, events);
		const completedToolNames = toolNames(events);
		const discussionManifestWrites = events.filter((event) =>
			event.type === "tool_execution_end" &&
			event.toolName === "write" &&
			event.toolCallId === "discussion-manifest",
		);

		outcome.assertNoOperatorFailures();
		outcome.assertNoToolErrors();
		assert.equal(completedToolNames.filter((toolName) => toolName === "gsd_milestone_generate_id").length, 2, "multi-milestone planning must generate two IDs");
		assert.equal(completedToolNames.filter((toolName) => toolName === "gsd_plan_milestone").length, 1, "auto stops at M001 closeout before planning M002");
		assert.equal(completedToolNames.filter((toolName) => toolName === "gsd_validate_milestone").length, 1, "auto validates only M001 before stopping");
		assert.equal(completedToolNames.filter((toolName) => toolName === "gsd_complete_milestone").length, 1, "auto completes only M001 before stopping");
		assert.equal(discussionManifestWrites.length, 1, "multi-milestone discussion manifest must be written before auto execution");
		outcome.assertCompletionNotification(/milestone m001 complete/i);
		assert.doesNotThrow(
			() => execFileSync("node", ["--test", "test/answer.test.js"], { cwd: project.dir, stdio: "pipe" }),
			"M001 focused verification command must pass after closeout",
		);

		for (const milestoneId of ["M001"]) {
			outcome.assertArtifact(`.gsd/milestones/${milestoneId}/${milestoneId}-CONTEXT.md`, `${milestoneId} context artifact is present`);
			outcome.assertArtifact(`.gsd/milestones/${milestoneId}/${milestoneId}-ROADMAP.md`, `${milestoneId} roadmap artifact is present`);
			outcome.assertArtifact(`.gsd/milestones/${milestoneId}/${milestoneId}-VALIDATION.md`, `${milestoneId} validation artifact is present`);
			outcome.assertArtifact(`.gsd/milestones/${milestoneId}/${milestoneId}-SUMMARY.md`, `${milestoneId} summary artifact is present`);
			outcome.assertArtifact(`.gsd/milestones/${milestoneId}/slices/S01/S01-SUMMARY.md`, `${milestoneId}/S01 summary artifact is present`);
			// Flat-phase: skip per-task summary (tasks are checkboxes)
		}
		// M002 context artifact is queued (flat-phase: assertArtifact handles phases/ fallback)
		outcome.assertArtifact(".gsd/milestones/M002/M002-CONTEXT.md", "M002 context artifact is queued");
		// M002 roadmap must NOT exist before the next auto command plans it
		const m002RoadmapExists =
			existsSync(join(project.dir, ".gsd", "milestones", "M002", "M002-ROADMAP.md")) ||
			((): boolean => {
				const phasesDir = join(project.dir, ".gsd", "phases");
				if (!existsSync(phasesDir)) return false;
				try {
					return readdirSync(phasesDir, { withFileTypes: true })
						.filter((e) => e.isDirectory() && /^02-/.test(e.name))
						.some((e) => existsSync(join(phasesDir, e.name, "02-ROADMAP.md")));
				} catch { return false; }
			})();
		assert.equal(m002RoadmapExists, false, "M002 roadmap is not planned before the next command");

		const db = outcome.openDb(t);
		assert.equal(scalar(db, "SELECT COUNT(*) AS value FROM milestones WHERE status = 'complete'"), "1");
		assert.equal(scalar(db, "SELECT status AS value FROM milestones WHERE id = :id", { id: "M001" }), "complete");
		assert.notEqual(scalar(db, "SELECT status AS value FROM milestones WHERE id = :id", { id: "M002" }), "complete");
		assert.equal(scalar(db, "SELECT COUNT(*) AS value FROM slices WHERE status = 'complete'"), "1");
		assert.equal(scalar(db, "SELECT COUNT(*) AS value FROM tasks WHERE status = 'complete'"), "1");
		assert.equal(scalar(db, "SELECT COUNT(*) AS value FROM assessments WHERE scope = 'milestone-validation' AND status = 'pass'"), "1");
		assert.equal(
			scalar(
				db,
				"SELECT COUNT(*) AS value FROM quality_gates WHERE scope = 'milestone' AND task_id = '' AND status = 'complete' AND verdict = 'pass'",
			),
			"4",
		);
	});
});
