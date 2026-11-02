import assert from "node:assert/strict";
import test from "node:test";
import { invokeProjectBindingRead, invokeProjectProgressRead, invokeProjectSnapshotRead, invokeWorkflowCommand } from "./rpc-mode.js";

test("project progress read forwards the active session CWD and request ID", async () => {
	let receivedInput: unknown;
	const response = await invokeProjectProgressRead(
		async (input) => {
			receivedInput = input;
			return { phase: "execute" };
		},
		"request-123",
		"/workspace/project",
	);

	assert.deepEqual(receivedInput, { cwd: "/workspace/project" });
	assert.deepEqual(response, {
		id: "request-123",
		type: "response",
		command: "get_project_progress",
		success: true,
		data: { phase: "execute" },
	});
});

test("project progress read preserves provenance metadata", async () => {
	const response = await invokeProjectProgressRead(
		async () => ({
			phase: "execute",
			readMetadata: { source: "database", authority: "db-authoritative" },
		}),
		"request-789",
		"/workspace/project",
	);

	assert.deepEqual(response, {
		id: "request-789",
		type: "response",
		command: "get_project_progress",
		success: true,
		data: {
			phase: "execute",
			readMetadata: { source: "database", authority: "db-authoritative" },
		},
	});
});

test("project progress read remains valid when an older producer omits readMetadata", async () => {
	const response = await invokeProjectProgressRead(
		async () => ({ phase: "execute" }),
		"request-999",
		"/workspace/project",
	);

	assert.equal(response.success, true);
	assert.deepEqual(response.data, { phase: "execute" });
	assert.equal((response.data as { readMetadata?: unknown }).readMetadata, undefined);
});

test("project progress reader failures preserve the request ID", async () => {
	const response = await invokeProjectProgressRead(
		async () => {
			throw new Error("database unavailable");
		},
		"request-456",
		"/workspace/project",
	);

	assert.deepEqual(response, {
		id: "request-456",
		type: "response",
		command: "get_project_progress",
		success: false,
		error: "database unavailable",
	});
});

test("project snapshot read forwards the active session CWD and request ID", async () => {
	let receivedInput: unknown;
	const response = await invokeProjectSnapshotRead(
		async (input) => {
			receivedInput = input;
			return { capturedAt: "2026-09-06T00:00:00.000Z" };
		},
		"request-789",
		"/workspace/project",
	);

	assert.deepEqual(receivedInput, { cwd: "/workspace/project" });
	assert.deepEqual(response, {
		id: "request-789",
		type: "response",
		command: "get_project_snapshot",
		success: true,
		data: { capturedAt: "2026-09-06T00:00:00.000Z" },
	});
});

test("project snapshot reader failures preserve the request ID", async () => {
	const response = await invokeProjectSnapshotRead(
		async () => {
			throw new Error("snapshot unavailable");
		},
		"request-987",
		"/workspace/project",
	);

	assert.deepEqual(response, {
		id: "request-987",
		type: "response",
		command: "get_project_snapshot",
		success: false,
		error: "snapshot unavailable",
	});
});

test("workflow command forwards the typed command, its identity and the session CWD", async () => {
	let receivedInput: unknown;
	const response = await invokeWorkflowCommand(
		async (input) => {
			receivedInput = input;
			return { ok: true, message: "Parked milestone M001.", revision: 8 };
		},
		{
			id: "request-321",
			type: "workflow_command",
			name: "milestone_park",
			args: { milestoneId: "M001", reason: "hold" },
			idempotencyKey: "user-action-1",
			expectedRevision: 7,
		},
		"/workspace/project",
	);

	assert.deepEqual(receivedInput, {
		cwd: "/workspace/project",
		name: "milestone_park",
		args: { milestoneId: "M001", reason: "hold" },
		idempotencyKey: "user-action-1",
		expectedRevision: 7,
	});
	assert.deepEqual(response, {
		id: "request-321",
		type: "response",
		command: "workflow_command",
		success: true,
		data: { ok: true, message: "Parked milestone M001.", revision: 8 },
	});
});

test("workflow command failures preserve the request ID", async () => {
	const response = await invokeWorkflowCommand(
		async () => {
			throw new Error("Unknown workflow command: nope");
		},
		{ id: "request-654", type: "workflow_command", name: "milestone_unpark", args: { milestoneId: "M001" }, idempotencyKey: "k" },
		"/workspace/project",
	);

	assert.deepEqual(response, {
		id: "request-654",
		type: "response",
		command: "workflow_command",
		success: false,
		error: "Unknown workflow command: nope",
	});
});

test("binding read keeps producer identity separate from project authority", async () => {
	let receivedInput: unknown;
	const response = await invokeProjectBindingRead(
		async (input) => {
			receivedInput = input;
			return {
				authority: { projectId: "project-a", schemaVersion: 1, revision: 4, authorityEpoch: 2 },
				projectRoot: "/workspace/project",
				worktreeRoot: null,
				rootResolution: "verified",
			};
		},
		"request-binding-1",
		"/workspace/project",
		{ sessionId: "session-a", processInstanceId: "process-a" },
		() => true,
	);

	assert.deepEqual(receivedInput, { cwd: "/workspace/project" });
	assert.equal(response.success, true);
	if (!response.success || response.command !== "get_binding_snapshot") assert.fail("expected binding snapshot");
	assert.deepEqual(response.data.producer, { sessionId: "session-a", processInstanceId: "process-a" });
	assert.deepEqual(response.data.project?.authority, {
		projectId: "project-a",
		schemaVersion: 1,
		revision: 4,
		authorityEpoch: 2,
	});
	assert.equal(response.data.projectStatus, "authoritative");
	assert.ok(Number.isFinite(Date.parse(response.data.capturedAt)));
});

test("binding read preserves producer identity when project authority is unavailable", async () => {
	const response = await invokeProjectBindingRead(
		undefined,
		"request-binding-2",
		"/workspace/project",
		{ sessionId: "session-b", processInstanceId: "process-b" },
		() => true,
	);

	assert.equal(response.success, true);
	if (!response.success || response.command !== "get_binding_snapshot") assert.fail("expected partial binding snapshot");
	assert.deepEqual(response.data.producer, { sessionId: "session-b", processInstanceId: "process-b" });
	assert.equal(response.data.project, null);
	assert.equal(response.data.projectStatus, "unavailable");
});

test("binding read rejects a torn session read conservatively", async () => {
	const response = await invokeProjectBindingRead(
		async () => ({ authority: null, projectRoot: null, worktreeRoot: null, rootResolution: "unavailable" }),
		"request-binding-3",
		"/workspace/project",
		{ sessionId: "session-c", processInstanceId: "process-c" },
		() => false,
	);

	assert.deepEqual(response, {
		id: "request-binding-3",
		type: "response",
		command: "get_binding_snapshot",
		success: false,
		error: "Session or working directory changed during binding read; retry",
	});
});