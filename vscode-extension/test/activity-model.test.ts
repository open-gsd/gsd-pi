// Project/App: gsd-pi
// File Purpose: Verifies activity-feed presentation transitions without a VS
// Code host: active start roles, completion/error settlement, disconnect and
// session-rebind interruption with outcome unknown, and late-event safety
// (issue #2930).

import test from "node:test";
import assert from "node:assert/strict";

import { ActivityModel, type ActivityEntry } from "../src/activity-model.ts";

function start(model: ActivityModel, extra: Record<string, unknown> = {}): void {
	model.handleEvent({ type: "agent_start", ...extra });
}

function end(model: ActivityModel, extra: Record<string, unknown> = {}): void {
	model.handleEvent({ type: "agent_end", messages: [], ...extra });
}

function toolStart(model: ActivityModel, id: string, toolName = "Read"): void {
	model.handleEvent({ type: "tool_execution_start", toolUseId: id, toolName, toolInput: {} });
}

function toolEnd(model: ActivityModel, id: string, extra: Record<string, unknown> = {}): void {
	model.handleEvent({ type: "tool_execution_end", toolUseId: id, ...extra });
}

function agentRows(model: ActivityModel): ActivityEntry[] {
	return model.getEntries().filter((i) => i.type === "agent");
}

function toolRows(model: ActivityModel): ActivityEntry[] {
	return model.getEntries().filter((i) => i.type === "tool");
}

test("agent start is presented as active, never with a passed conclusion", () => {
	const model = new ActivityModel();
	start(model);

	const rows = agentRows(model);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].status, "running");
	assert.equal(rows[0].icon, "play");
	assert.notEqual(rows[0].color, "testing.iconPassed");
	assert.equal(rows[0].color, "charts.yellow");
});

test("normal agent end settles the started row and adds a completed row", () => {
	const model = new ActivityModel();
	start(model);
	end(model);

	const rows = agentRows(model);
	assert.equal(rows.length, 2);
	assert.equal(rows[0].status, "success", "the started row must not stay running after the run ends");
	assert.equal(rows[0].icon, "check");
	assert.equal(typeof rows[0].duration, "number");
	assert.equal(rows[1].label, "Agent finished");
	assert.equal(rows[1].status, "success");
	assert.equal(rows[1].color, "charts.green");
});

test("agent end with error abort origin presents as error, not success", () => {
	const model = new ActivityModel();
	start(model);
	end(model, { abortOrigin: "error" });

	const rows = agentRows(model);
	assert.equal(rows[0].status, "error");
	assert.equal(rows[1].status, "error");
	assert.equal(rows[1].icon, "error");
	assert.equal(rows[1].color, "charts.red");
});

test("agent end with a non-error abort origin presents as interrupted outcome unknown", () => {
	const model = new ActivityModel();
	start(model);
	end(model, { abortOrigin: "user" });

	const rows = agentRows(model);
	assert.equal(rows[0].status, "interrupted");
	assert.equal(rows[1].status, "interrupted");
	assert.notEqual(rows[1].color, "testing.iconPassed");
	assert.equal(rows[1].color, "charts.foreground");
});

test("an abort without abortOrigin is classified by the terminal stop reason, not as success", () => {
	const aborted = new ActivityModel();
	start(aborted);
	end(aborted, {
		messages: [{ role: "assistant", stopReason: "aborted", content: [] }],
	});
	for (const row of agentRows(aborted)) {
		assert.equal(row.status, "interrupted", "an unknown-origin abort must not present as success");
	}
	assert.equal(
		agentRows(aborted)[1].detail,
		"Agent stopped before completing",
		"the finished row must not claim completion for an aborted run",
	);

	const errored = new ActivityModel();
	start(errored);
	end(errored, {
		messages: [{ role: "assistant", stopReason: "error", content: [] }],
	});
	for (const row of agentRows(errored)) {
		assert.equal(row.status, "error");
	}
	assert.equal(agentRows(errored)[1].detail, "Agent ended with an error");

	// A normal end keeps its success presentation regardless of origin absence.
	const normal = new ActivityModel();
	start(normal);
	end(normal, {
		messages: [{ role: "assistant", stopReason: "stop", content: [] }],
	});
	assert.equal(agentRows(normal)[1].status, "success");
	assert.equal(agentRows(normal)[1].detail, "Agent completed processing");
});

test("a duplicate agent end is ignored and appends nothing", () => {
	const model = new ActivityModel();
	start(model);
	end(model);
	end(model);

	const rows = agentRows(model);
	assert.equal(rows.length, 2, "a duplicate end must not append a second completion row");
	assert.equal(rows.filter((r) => r.label === "Agent finished").length, 1);
});

test("tool execution end settles the row with the run outcome and execution colors", () => {
	const model = new ActivityModel();
	toolStart(model, "t1");
	toolEnd(model, "t1");
	toolStart(model, "t2");
	toolEnd(model, "t2", { error: true });
	toolStart(model, "t3");
	toolEnd(model, "t3", { isError: true });

	const rows = toolRows(model);
	assert.equal(rows[0].status, "success");
	assert.equal(rows[0].icon, "check");
	assert.equal(rows[0].color, "charts.green");
	assert.equal(typeof rows[0].duration, "number");
	assert.equal(rows[1].status, "error");
	assert.equal(rows[1].icon, "error");
	assert.equal(rows[1].color, "charts.red");
	assert.equal(rows[2].status, "error", "the isError flag must classify the row as error");
});

test("disconnect settles every unfinished row as interrupted outcome unknown", () => {
	const model = new ActivityModel();
	start(model);
	toolStart(model, "t1");
	model.setConnected(false);

	const all = model.getEntries();
	assert.equal(all.length, 2);
	for (const row of all) {
		assert.equal(row.status, "interrupted", `${row.label} must not stay running after disconnect`);
		assert.equal(row.icon, "circle-slash");
		assert.equal(row.color, "charts.foreground", "interrupted rows must not read as failure");
		assert.equal(row.duration, undefined, "interrupted rows must not show a finished duration");
	}
});

test("a late end event after disconnect cannot resurrect or mutate settled rows", () => {
	const model = new ActivityModel();
	start(model);
	toolStart(model, "t1");
	model.setConnected(false);

	toolEnd(model, "t1");
	end(model);

	assert.equal(model.getEntries().length, 2, "a late agent end must not append a phantom completion");
	const tool = toolRows(model)[0];
	const started = agentRows(model)[0];
	assert.equal(tool.status, "interrupted", "a late tool end must not un-interrupt a settled row");
	assert.equal(started.status, "interrupted", "a late agent end must not rewrite settled rows");
});

test("reconnecting after a disconnect accepts new activity normally", () => {
	const model = new ActivityModel();
	start(model);
	model.setConnected(false);
	model.setConnected(true);

	toolStart(model, "t2");
	toolEnd(model, "t2");

	const agent = agentRows(model)[0];
	const tool = toolRows(model)[0];
	assert.equal(tool.status, "success", "post-reconnect activity must settle normally");
	assert.ok(tool.id > agent.id, "post-reconnect rows must be new rows, not reused history");
});

test("session rebind reasons settle unfinished rows; cosmetic reasons do not", () => {
	for (const reason of ["new_session", "switch_session", "fork"]) {
		const model = new ActivityModel();
		start(model);
		toolStart(model, "t1");
		model.handleEvent({ type: "session_state_changed", reason });
		for (const row of model.getEntries()) {
			assert.equal(row.status, "interrupted", `${reason} must settle ${row.label}`);
		}
	}

	const model = new ActivityModel();
	start(model);
	toolStart(model, "t1");
	model.handleEvent({ type: "session_state_changed", reason: "set_session_name" });
	model.handleEvent({ type: "session_state_changed", reason: "set_model" });
	for (const row of model.getEntries()) {
		assert.equal(row.status, "running", `${row.label} must survive cosmetic session updates`);
	}
});

test("a tool still running when the run ends abnormally is settled as outcome unknown", () => {
	const model = new ActivityModel();
	start(model);
	toolStart(model, "t1");
	end(model, { abortOrigin: "error" });

	const tool = toolRows(model)[0];
	assert.equal(tool.status, "interrupted", "an orphaned tool row must not spin forever");
	assert.equal(tool.icon, "circle-slash");

	// Its late end event must not mutate the settled row.
	toolEnd(model, "t1");
	assert.equal(tool.status, "interrupted");
});

test("clear drops history but keeps an in-flight run tracked", () => {
	const model = new ActivityModel();
	start(model);
	model.clear();
	assert.equal(model.getEntries().length, 0);

	// The run continues after the view was cleared: its events must still settle.
	toolStart(model, "t1");
	end(model, { abortOrigin: "programmatic" });

	const tool = toolRows(model)[0];
	assert.equal(tool.status, "interrupted", "an orphaned tool after clear must still be settled");
	assert.equal(agentRows(model)[0].label, "Agent finished", "the run's end must still be recorded");

	model.clear();
	model.setConnected(false);
	assert.equal(model.getEntries().length, 0);
	assert.equal(model.setConnected(false), false, "disconnect with nothing running must report no change");
});

test("rows are evicted beyond maxItems and setMaxItems trims existing history", () => {
	const model = new ActivityModel(2);
	start(model);
	toolStart(model, "t1");
	toolStart(model, "t2");
	assert.equal(model.getEntries().length, 2);
	assert.ok(model.getEntries()[0].label.startsWith("Read"), "oldest rows must be evicted first");

	toolEnd(model, "t2");
	assert.equal(toolRows(model)[1].status, "success", "settling must still work after sibling eviction");

	model.setMaxItems(1);
	assert.equal(model.getEntries().length, 1);
});

test("unknown events are ignored without mutating state", () => {
	const model = new ActivityModel();
	start(model);
	for (const type of ["message_start", "message_update", "cost_update", "execution_complete"]) {
		assert.equal(model.handleEvent({ type }), false, "ignored events must report no change");
	}
	assert.equal(model.getEntries().length, 1);
	assert.equal(model.getEntries()[0].status, "running");
});

test("eviction prunes pending bookkeeping so maps stay bounded by live rows", () => {
	const model = new ActivityModel(2);
	start(model);
	for (let i = 0; i < 1000; i++) {
		toolStart(model, `t${i}`);
	}
	assert.equal(model.getEntries().length, 2, "row cap must hold");

	// A tracked id whose row was evicted must not settle anything or linger:
	// ends for evicted rows are no-ops and the maps do not grow unbounded.
	toolEnd(model, "t0");
	assert.equal(model.getEntries().some((r) => r.status === "success" && r.label.startsWith("Read")), false);

	// The surviving live tool can still settle normally.
	toolEnd(model, "t999");
	assert.equal(toolRows(model)[1].status, "success");
});
