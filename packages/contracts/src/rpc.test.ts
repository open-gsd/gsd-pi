// Project/App: gsd-pi
// File Purpose: Tests for canonical RPC contract constants exported by the contracts package.

import assert from "node:assert/strict";
import test from "node:test";
import {
	RPC_COMMAND_TYPES,
	RPC_CONTRACT_VERSION,
	RPC_EXTENSION_UI_METHODS,
	RPC_THINKING_LEVELS,
	RPC_V2_EVENT_TYPES,
	type McpPendingBlocker,
} from "./rpc.js";
import { WORKFLOW_TOOL_CONTRACTS, WORKFLOW_TOOL_NAMES } from "./workflow.js";

test("rpc contract version is stable and public", () => {
	assert.equal(RPC_CONTRACT_VERSION, 1);
});

test("rpc command constants cover the public v2 handshake and core commands", () => {
	assert.deepEqual(
		["init", "prompt", "get_state", "get_project_progress", "get_project_snapshot", "bash", "get_session_stats", "shutdown"].filter(
			(command) => !RPC_COMMAND_TYPES.includes(command as (typeof RPC_COMMAND_TYPES)[number])
		),
		[]
	);
});

test("rpc constants include provider-agnostic thinking and event values", () => {
	assert.deepEqual([...RPC_THINKING_LEVELS], ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
	assert.deepEqual([...RPC_V2_EVENT_TYPES], ["execution_complete", "cost_update"]);
});

test("extension UI methods include interactive and display update requests", () => {
	assert.deepEqual(
		["select", "confirm", "input", "editor", "notify", "setStatus", "setWidget", "setTitle", "set_editor_text"].filter(
			(method) => !RPC_EXTENSION_UI_METHODS.includes(method as (typeof RPC_EXTENSION_UI_METHODS)[number])
		),
		[]
	);
});

test("mcp pending blocker preserves secure input payloads", () => {
	const blocker: McpPendingBlocker = {
		id: "blocker-1",
		method: "input",
		message: "API key",
		event: {
			type: "extension_ui_request",
			id: "blocker-1",
			method: "input",
			title: "API key",
			secure: true,
		},
	};

	assert.equal(blocker.method, "input");
	assert.equal(blocker.event.method, "input");
	assert.equal(blocker.event.secure, true);
});

test("workflow tool contracts expose canonical names and aliases", () => {
	assert.ok(WORKFLOW_TOOL_NAMES.includes("gsd_task_complete"));
	assert.ok(WORKFLOW_TOOL_NAMES.includes("gsd_complete_task"));
	assert.ok(WORKFLOW_TOOL_NAMES.includes("gsd_task_reopen"));
	assert.ok(WORKFLOW_TOOL_NAMES.includes("gsd_reopen_task"));
	assert.ok(WORKFLOW_TOOL_NAMES.includes("gsd_task_recovery_resume"));
	assert.ok(WORKFLOW_TOOL_NAMES.includes("gsd_plan_milestone"));
	assert.ok(WORKFLOW_TOOL_NAMES.includes("gsd_milestone_plan"));
	assert.ok(WORKFLOW_TOOL_NAMES.includes("gsd_plan_slice"));
	assert.ok(WORKFLOW_TOOL_NAMES.includes("gsd_slice_plan"));
	assert.ok(WORKFLOW_TOOL_NAMES.includes("gsd_summary_save"));
	assert.ok(WORKFLOW_TOOL_NAMES.includes("gsd_save_summary"));
	assert.ok(WORKFLOW_TOOL_NAMES.includes("gsd_checkpoint_db"));

	const taskComplete = WORKFLOW_TOOL_CONTRACTS.find((tool) => tool.canonicalName === "gsd_task_complete");
	assert.ok(taskComplete);
	assert.deepEqual([...taskComplete.aliases], ["gsd_complete_task"]);
	assert.equal(taskComplete.writePolicy, "write");
	assert.equal(taskComplete.schemaId, "workflow.task.complete");

	const taskReopen = WORKFLOW_TOOL_CONTRACTS.find((tool) => tool.canonicalName === "gsd_task_reopen");
	assert.ok(taskReopen);
	assert.deepEqual([...taskReopen.aliases], ["gsd_reopen_task"]);
	assert.equal(taskReopen.writePolicy, "write");
	assert.equal(taskReopen.schemaId, "workflow.task.reopen");

	const taskRecoveryResume = WORKFLOW_TOOL_CONTRACTS.find(
		(tool) => tool.canonicalName === "gsd_task_recovery_resume",
	);
	assert.ok(taskRecoveryResume);
	assert.deepEqual([...taskRecoveryResume.aliases], []);
	assert.equal(taskRecoveryResume.writePolicy, "write");
	assert.equal(taskRecoveryResume.schemaId, "workflow.task.recovery.resume");
	assert.equal(taskRecoveryResume.executorId, "executeTaskRecoveryResume");

	const summarySave = WORKFLOW_TOOL_CONTRACTS.find((tool) => tool.canonicalName === "gsd_summary_save");
	assert.ok(summarySave);
	assert.deepEqual([...summarySave.aliases], ["gsd_save_summary"]);

	const planMilestone = WORKFLOW_TOOL_CONTRACTS.find((tool) => tool.canonicalName === "gsd_plan_milestone");
	assert.ok(planMilestone);
	assert.deepEqual([...planMilestone.aliases], ["gsd_milestone_plan"]);

	const planSlice = WORKFLOW_TOOL_CONTRACTS.find((tool) => tool.canonicalName === "gsd_plan_slice");
	assert.ok(planSlice);
	assert.deepEqual([...planSlice.aliases], ["gsd_slice_plan"]);

	const checkpointDb = WORKFLOW_TOOL_CONTRACTS.find((tool) => tool.canonicalName === "gsd_checkpoint_db");
	assert.ok(checkpointDb);
	assert.equal(checkpointDb.writePolicy, "read");
	assert.equal(checkpointDb.schemaId, "workflow.database.checkpoint");
});
