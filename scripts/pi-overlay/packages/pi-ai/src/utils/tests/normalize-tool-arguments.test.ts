import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Type } from "@sinclair/typebox";
import { isEmptyPathToolArguments, normalizeToolArguments } from "../normalize-tool-arguments.js";
import { validateToolArguments } from "../validation.js";

describe("normalizeToolArguments", () => {
	test("aliases filePath to path for read", () => {
		const args = { filePath: "src/app.js" };
		normalizeToolArguments("read", args);
		assert.deepEqual(args, { path: "src/app.js" });
	});

	test("aliases file_path to path for Read (PascalCase tool name)", () => {
		const args = { file_path: "src/app.js" };
		normalizeToolArguments("Read", args);
		assert.deepEqual(args, { path: "src/app.js" });
	});

	test("aliases file_path to path for write", () => {
		const args = { file_path: "src/app.js", content: "x" };
		normalizeToolArguments("write", args);
		assert.deepEqual(args, { path: "src/app.js", content: "x" });
	});

	test("aliases file to path for read", () => {
		const args = { file: ".gsd/milestones/M003/M003-CONTEXT.md" };
		normalizeToolArguments("read", args);
		assert.deepEqual(args, { path: ".gsd/milestones/M003/M003-CONTEXT.md" });
	});

	test("aliases contents to content for write", () => {
		const args = { file_path: "src/app.js", contents: "hello" };
		normalizeToolArguments("Write", args);
		assert.deepEqual(args, { path: "src/app.js", content: "hello" });
	});

	test("aliases cmd to command for bash", () => {
		const args = { cmd: "npm test" };
		normalizeToolArguments("Bash", args);
		assert.deepEqual(args, { command: "npm test" });
	});

	test("converts Cursor-style Edit arguments to pi edit schema", () => {
		const args = {
			file_path: "/tmp/index.html",
			old_string: "foo",
			new_string: "bar",
			replace_all: false,
		};
		normalizeToolArguments("Edit", args);
		assert.deepEqual(args, {
			path: "/tmp/index.html",
			edits: [{ oldText: "foo", newText: "bar" }],
		});
	});

	test("merges Cursor-style edit into existing edits array", () => {
		const args = {
			path: "/tmp/a.ts",
			edits: [{ oldText: "a", newText: "b" }],
			old_string: "c",
			new_string: "d",
		};
		normalizeToolArguments("edit", args);
		assert.deepEqual(args, {
			path: "/tmp/a.ts",
			edits: [
				{ oldText: "a", newText: "b" },
				{ oldText: "c", newText: "d" },
			],
		});
	});

	test("parses JSON-string tasks for subagent", () => {
		const args = {
			tasks: '[{"agent":"tester","task":"Evaluate Q3"}]',
		};
		normalizeToolArguments("subagent", args);
		assert.deepEqual(args.tasks, [{ agent: "tester", task: "Evaluate Q3" }]);
	});

	test("converts Claude Code Agent args for subagent tool", () => {
		const args = {
			subagent_type: "Explore",
			description: "Scout project",
			prompt: "Summarize structure",
		};
		normalizeToolArguments("Agent", args);
		assert.deepEqual(args, {
			agent: "scout",
			task: "Scout project\n\nSummarize structure",
		});
	});

	test("leaves non-JSON strings unchanged", () => {
		const args = { tasks: "not-json" };
		normalizeToolArguments("subagent", args);
		assert.equal(args.tasks, "not-json");
	});
});

describe("isEmptyPathToolArguments", () => {
	test("detects empty read calls", () => {
		assert.equal(isEmptyPathToolArguments("Read", {}), true);
	});

	test("ignores non-read calls with non-record arguments", () => {
		assert.equal(isEmptyPathToolArguments("bash", undefined), false);
	});

	test("accepts aliased paths before normalization", () => {
		assert.equal(isEmptyPathToolArguments("read", { file_path: "/tmp/x" }), false);
	});
});

describe("validateToolArguments integration", () => {
	test("accepts read calls that use file_path instead of path", () => {
		const tool = {
			name: "read",
			description: "read",
			parameters: Type.Object({
				path: Type.String(),
			}),
		};
		const validated = validateToolArguments(tool, {
			type: "toolCall",
			id: "read-3",
			name: "Read",
			arguments: { file_path: "/tmp/index.html" },
		});
		assert.equal(validated.path, "/tmp/index.html");
	});

	test("accepts read calls that use filePath instead of path", () => {
		const tool = {
			name: "read",
			description: "read",
			parameters: Type.Object({
				path: Type.String(),
			}),
		};
		const validated = validateToolArguments(tool, {
			type: "toolCall",
			id: "read-1",
			name: "read",
			arguments: { filePath: "README.md" },
		});
		assert.equal(validated.path, "README.md");
	});

	test("accepts read calls that use file instead of path", () => {
		const tool = {
			name: "read",
			description: "read",
			parameters: Type.Object({
				path: Type.String(),
			}),
		};
		const validated = validateToolArguments(tool, {
			type: "toolCall",
			id: "read-2",
			name: "read",
			arguments: { file: "README.md" },
		});
		assert.equal(validated.path, "README.md");
	});

	test("accepts gsd_task_complete calls with JSON-stringified verificationEvidence", () => {
		const evidence = [{ command: "npm test", exitCode: 0, verdict: "pass", durationMs: 1234 }];
		const tool = {
			name: "gsd_task_complete",
			description: "complete task",
			parameters: Type.Object({
				verificationEvidence: Type.Array(
					Type.Object({
						command: Type.String(),
						exitCode: Type.Number(),
						verdict: Type.String(),
						durationMs: Type.Number(),
					}),
				),
			}),
		};
		const validated = validateToolArguments(tool, {
			type: "toolCall",
			id: "complete-task-1",
			name: "gsd_task_complete",
			arguments: { verificationEvidence: JSON.stringify(evidence) },
		});
		assert.deepEqual(validated.verificationEvidence, evidence);
	});

	test("accepts item-wrapped string fields for gsd_task_complete", () => {
		const tool = {
			name: "gsd_task_complete",
			description: "complete task",
			parameters: Type.Object({
				verification: Type.Optional(Type.String()),
				deviations: Type.Optional(Type.String()),
				knownIssues: Type.Optional(Type.String()),
				failureModes: Type.Optional(Type.String()),
				loadProfile: Type.Optional(Type.String()),
				negativeTests: Type.Optional(Type.String()),
			}),
		};
		const validated = validateToolArguments(tool, {
			type: "toolCall",
			id: "complete-task-2",
			name: "gsd_task_complete",
			arguments: {
				verification: { item: "npm test passed" },
				deviations: { item: "None." },
				knownIssues: { item: "Scenario 3b out-of-scope" },
				failureModes: { item: "Dependency outage" },
				loadProfile: { item: "Ten requests per second" },
				negativeTests: { item: "Malformed input rejected" },
			},
		});

		assert.deepEqual(validated, {
			verification: "npm test passed",
			deviations: "None.",
			knownIssues: "Scenario 3b out-of-scope",
			failureModes: "Dependency outage",
			loadProfile: "Ten requests per second",
			negativeTests: "Malformed input rejected",
		});
	});

	test("accepts Edit calls that use Cursor-style old_string/new_string", () => {
		const tool = {
			name: "edit",
			description: "edit",
			parameters: Type.Object({
				path: Type.String(),
				edits: Type.Array(
					Type.Object({
						oldText: Type.String(),
						newText: Type.String(),
					}),
				),
			}),
		};
		const validated = validateToolArguments(tool, {
			type: "toolCall",
			id: "edit-1",
			name: "Edit",
			arguments: {
				file_path: "/tmp/index.html",
				old_string: "<html>",
				new_string: '<html id="root">',
				replace_all: false,
			},
		});
		assert.deepEqual(validated, {
			path: "/tmp/index.html",
			edits: [{ oldText: "<html>", newText: '<html id="root">' }],
		});
	});
});
