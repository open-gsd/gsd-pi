// Project/App: gsd-pi
// File Purpose: Tests for interactive terminal tool execution rendering.
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import stripAnsi from "strip-ansi";
import { isImageLine, resetCapabilitiesCache, setCapabilities, setCellDimensions, Text, visibleWidth } from "@gsd/pi-tui";
import {
	TOOL_TUI_EXPANDED_MAX_LINES,
	ToolExecutionComponent,
	ToolPhaseSummaryComponent,
	type ToolExecutionPhase,
} from "../tool-execution.js";
import { setRailAnimationEnabled } from "../transcript-design.js";
import { initTheme, Theme } from "@gsd/pi-coding-agent/theme/theme.js";
import { READ_TUI_EXPANDED_MAX_LINES } from "@gsd/pi-coding-agent/core/tools/read.js";

initTheme("dark", false);

/**
 * Build a minimal valid PNG header (signature + IHDR) with the given dimensions.
 * getImageDimensions/getPngDimensions only read the 24-byte header, so this is
 * enough to drive image rendering without a real encoded image.
 */
function tinyPngBase64(widthPx: number, heightPx: number): string {
	const buf = Buffer.alloc(24);
	// PNG signature
	buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	buf.writeUInt32BE(widthPx, 16);
	buf.writeUInt32BE(heightPx, 20);
	return buf.toString("base64");
}

function renderTool(
	toolName: string,
	args: Record<string, unknown>,
	result?: {
		content: Array<{ type: string; text?: string }>;
		isError: boolean;
		details?: Record<string, unknown>;
	},
	toolDefinition?: { label?: string; renderCall?: (...args: any[]) => any; renderResult?: (...args: any[]) => any },
): string {
	const component = new ToolExecutionComponent(
		toolName,
		args,
		{},
		toolDefinition as any,
		{ requestRender() {} } as any,
	);
	component.setExpanded(true);
	if (result) component.updateResult(result);
	return stripAnsi(component.render(120).join("\n"));
}

function renderToolCollapsed(
	toolName: string,
	args: Record<string, unknown>,
	result?: {
		content: Array<{ type: string; text?: string }>;
		isError: boolean;
		details?: Record<string, unknown>;
	},
	toolDefinition?: { label?: string; renderCall?: (...args: any[]) => any; renderResult?: (...args: any[]) => any },
	width = 120,
): string {
	const component = new ToolExecutionComponent(
		toolName,
		args,
		{},
		toolDefinition as any,
		{ requestRender() {} } as any,
	);
	if (result) component.updateResult(result);
	return stripAnsi(component.render(width).join("\n"));
}

async function registeredExecDefinition(name: string): Promise<any> {
	const { registerExecTools } = await import(
		new URL("../../../../../../../src/resources/extensions/gsd/bootstrap/exec-tools.ts", import.meta.url).href
	);
	const definitions = new Map<string, any>();
	registerExecTools({ registerTool(definition: any) { definitions.set(definition.name, definition); } });
	const definition = definitions.get(name);
	assert.ok(definition, `missing registered tool ${name}`);
	return definition;
}

describe("ToolExecutionComponent", () => {

	test("registered exec callbacks leave purpose to the native frame across lifecycle and history", async () => {
		for (const name of ["gsd_exec", "gsd_uat_exec"]) {
			const definition = await registeredExecDefinition(name);
			const component = new ToolExecutionComponent(
				name, { purpose: "Inspect application", script: "echo secret-script" }, {},
				{ ...definition, label: "Native Exec" } as any,
				{ requestRender() {} } as any,
			);
			for (const resultPurpose of [undefined, "Verify application", null]) {
				if (resultPurpose !== undefined) component.updateResult({
					content: [], isError: false,
					details: { id: "exec-1", runtime: "bash", purpose: resultPurpose, digest: "ready", exit_code: 0, duration_ms: 12 },
				});
				for (const expanded of [false, true]) {
					component.setExpanded(expanded);
					const output = component.render(180).map(stripAnsi).join("\n");
					const purpose = resultPurpose === "Verify application" ? resultPurpose : "Inspect application";
					assert.equal(output.split(purpose).length - 1, 1, `${name} expanded=${expanded}\n${output}`);
					assert.match(output, /NATIVE EXEC/);
					assert.match(output, resultPurpose === undefined ? /running/ : /success/);
					if (expanded) assert.match(output, /collapse/);
					assert.doesNotMatch(output, /Run a Bash script|secret-script/);
					if (expanded && resultPurpose !== undefined) assert.match(output, /exit 0/);
				}
			}
		}
	});

	test("schema-shaped UAT args display sanitized identifiers while running without mutation", async () => {
		const args = { milestoneId: " \x1b[31mM001\x1b[0m ", sliceId: "S01\n", checkId: "C01\u202e", intent: "uat-runtime-check", script: "echo ready" };
		const before = structuredClone(args);
		const definition = { ...await registeredExecDefinition("gsd_uat_exec"), label: "UAT Exec" };
		for (const expanded of [false, true]) {
			const component = new ToolExecutionComponent("gsd_uat_exec", args, {}, definition as any, { requestRender() {} } as any);
			component.setExpanded(expanded);
			let output = component.render(180).map(stripAnsi).join("\n");
			assert.equal(output.split("UAT M001/S01/C01 (uat-runtime-check)").length - 1, 1);
			assert.doesNotMatch(output, /\u202e|Run a Bash script/);
			component.updateResult({ content: [], isError: false, details: { purpose: "Authoritative result", digest: "ready" } });
			output = component.render(180).map(stripAnsi).join("\n");
			assert.equal(output.split("Authoritative result").length - 1, 1);
			assert.doesNotMatch(output, /UAT M001/);
		}
		assert.deepEqual(args, before);
		for (const field of ["milestoneId", "sliceId", "checkId", "intent"]) {
			for (const value of [undefined, 42, "\n\u202e"]) {
				const output = renderToolCollapsed("gsd_uat_exec", { ...args, [field]: value });
				assert.match(output, /Run a Bash script/);
				assert.doesNotMatch(output, /UAT M001/);
			}
		}
		assert.match(renderToolCollapsed("gsd_exec", args), /Run a Bash script/);
	});

	test("registered recording warnings have one native owner while standalone failures stay visible", async () => {
		for (const name of ["gsd_exec", "gsd_uat_exec"]) {
			const definition = await registeredExecDefinition(name);
			for (const reason of ["database offline", ""]) {
				for (const isError of [false, true]) {
					for (const expanded of [false, true]) {
						const component = new ToolExecutionComponent(name, {}, {}, definition, { requestRender() {} } as any);
						component.updateResult({ content: [{ type: "text", text: "command output" }], isError,
							details: { digest: "command output", exit_code: 0, run_not_recorded: reason } });
						component.setExpanded(expanded);
						const output = component.render(120).map(stripAnsi).join("\n").replace(/\s+/g, " ");
						assert.equal(output.split("not verification or UAT evidence").length - 1, 1, output);
						assert.equal(output.split("Do not run the command again").length - 1, 1, output);
						if (reason) assert.match(output, /database offline/);
						assert.equal(component.getRollupPhase(), null);
					}
				}
			}
		}
	});

	test("ordinary warning-like output without a digest remains compact and rollup eligible", () => {
		for (const toolName of ["gsd_exec", "gsd_uat_exec"]) {
			for (const details of [undefined, { id: "exec-1", exit_code: 0 }]) {
				const markers = ["--- warning ---", "done\n--- warning ---\nRecording failed", "The command ran, but the host did not record this run: output only."];
				if (details) markers.push("--- warning ---\nThe command ran, but the host did not record this run: output imitation.");
				for (const text of markers) {
					const component = new ToolExecutionComponent(toolName, {}, {}, undefined, { requestRender() {} } as any);
					component.updateResult({ content: [{ type: "text", text }], details, isError: false });
					assert.ok(component.getRollupPhase(), `${toolName}: ${text}`);
					assert.equal(component.render(180).length, 1);
					assert.doesNotMatch(component.render(180).map(stripAnsi).join("\n"), /not verification or UAT evidence/);
				}
			}
		}
	});

	test("digest-less warning metadata wins over output and raw paired legacy warnings survive", () => {
		const footer = "--- warning ---\nThe command ran, but the host did not record this run: misleading output.";
		for (const toolName of ["gsd_exec", "gsd_uat_exec"]) {
			const component = new ToolExecutionComponent(toolName, {}, {}, undefined, { requestRender() {} } as any);
			component.updateResult({ content: [{ type: "text", text: footer }], details: { run_not_recorded: "stored database reason" }, isError: false });
			assert.match(component.render(180).map(stripAnsi).join("\n"), /did not record this run: stored database reason/);
			assert.equal(component.getRollupPhase(), null);
			component.updateResult({ content: [{ type: "text", text: footer }], isError: false });
			assert.equal(component.getRollupPhase(), null);
			assert.match(component.render(180).map(stripAnsi).join("\n"), /did not record this run: misleading output/);
		}
	});

	test("canonical exec tools show muted italic purpose in compact and expanded headers", (t) => {
		const italic = t.mock.method(Theme.prototype, "italic");
		const fg = t.mock.method(Theme.prototype, "fg");
		for (const toolName of ["gsd_exec", "gsd_uat_exec"]) {
			const component = new ToolExecutionComponent(
				toolName, { purpose: "Check the application", script: "echo ready" }, {}, undefined,
				{ requestRender() {} } as any,
			);
			const pending = component.render(140);
			assert.ok(italic.mock.calls.some((call) => call.arguments[0] === "Check the application"));
			assert.ok(fg.mock.calls.some((call) => call.arguments[0] === "muted" &&
				stripAnsi(call.arguments[1]) === "Check the application"));
			assert.match(stripAnsi(pending[0]), /Check the application/);
			assert.match(stripAnsi(pending[0]), /running/);
			component.updateResult({ content: [{ type: "text", text: "ready" }], isError: false });
			for (const expanded of [false, true]) {
				component.setExpanded(expanded);
				const lines = component.render(140);
				assert.match(stripAnsi(lines[0]), /Check the application/);
				assert.match(stripAnsi(lines[0]), /success/);
				if (!expanded) {
					assert.equal(lines.length, 1);
					assert.equal(component.getDisplayedLineCount(140), 1);
					assert.match(stripAnsi(lines[0]), /output hidden · ctrl\+o expand/);
					assert.deepEqual(component.getRollupPhase()?.targets, ["Check the application"]);
				} else {
					assert.match(stripAnsi(lines[0]), /ctrl\+o collapse/);
				}
			}
		}
	});

	test("exec purpose prefers valid result details including synthesized UAT purpose", () => {
		for (const toolName of ["gsd_exec", "gsd_uat_exec"]) {
			const rendered = renderToolCollapsed(toolName, { purpose: "Argument purpose" }, {
				content: [{ type: "text", text: "done" }], isError: false,
				details: { purpose: "UAT M001/S01/C01 (uat-runtime-check)" },
			});
			assert.match(rendered, /UAT M001\/S01\/C01/);
			assert.doesNotMatch(rendered, /Argument purpose/);
			for (const purpose of [undefined, null, {}, 7, "", " \n\t ", "\x1b[31m\x00\x1b[0m"]) {
				assert.match(renderToolCollapsed(toolName, { purpose: "Argument purpose" }, {
					content: [], isError: false, details: { purpose },
				}), /Argument purpose/);
			}
		}
	});

	test("exec purpose fallbacks match runtime aliases and defaults", () => {
		for (const toolName of ["gsd_exec", "gsd_uat_exec"]) {
			for (const [runtimes, expected] of [
				[[undefined, null, "", " ", "bash", "sh", " SHELL "], "Run a Bash script"],
				[["node", "nodejs", "js", " JavaScript "], "Run a Node.js script"],
				[["python", "python3", " PY "], "Run a Python script"],
				[["ruby", 42, {}], "Run a script"],
			] as const) {
				for (const runtime of runtimes) {
					assert.ok(renderToolCollapsed(toolName, { runtime, purpose: "\n\t" }).includes(expected));
				}
			}
		}
		for (const name of ["exec", "GSD_EXEC", "mcp__gsd__gsd_exec", "gsd_exec_search", "bash"]) {
			assert.doesNotMatch(renderToolCollapsed(name, { purpose: "Not an exec header" }), /Not an exec header/);
		}
	});

	test("exec purpose strips terminal strings and controls and collapses multiline without changing args", () => {
		const purpose = " \x1b[31mCheck\x1b[0m\n\r\tapp\x00\x07\x7f\u0085 " +
			"\x1b]8;;https://example.com\x07link\x1b]8;;\x07 " +
			"\x1bPprivate-terminal-payload\x1b\\ready\u202e ";
		const args = { purpose };
		const component = new ToolExecutionComponent("gsd_exec", args, {}, undefined, { requestRender() {} } as any);
		const lines = component.render(160);
		const text = stripAnsi(lines.join("\n"));
		assert.equal(lines.length, 1);
		assert.match(text, /Check app link ready/);
		assert.doesNotMatch(text, /private-terminal-payload|https:\/\/|[\x00-\x1f\x7f-\x9f\u202e]/);
		assert.equal(args.purpose, purpose);
	});

	test("long exec purpose stays on one row at narrow widths and preserves hints when they fit", () => {
		const component = new ToolExecutionComponent(
			"gsd_exec", { purpose: "Check ".repeat(100) }, {}, undefined, { requestRender() {} } as any,
		);
		component.updateResult({ content: [], isError: false });
		for (const width of [20, 40, 80, 120]) {
			const lines = component.render(width);
			assert.equal(lines.length, 1);
			assert.ok(visibleWidth(lines[0]) <= width);
			assert.equal(component.getDisplayedLineCount(width), lines.length);
		}
		assert.match(stripAnsi(component.render(120)[0]), /ctrl\+o expand/);
	});

	test("recording warnings bypass compact success and rollup, even with empty reasons", () => {
		for (const toolName of ["gsd_exec", "gsd_uat_exec"]) {
			for (const reason of ["database unavailable", ""]) {
				const component = new ToolExecutionComponent(
					toolName, { purpose: "Check application" }, {}, undefined, { requestRender() {} } as any,
				);
				component.updateResult({
					content: [{ type: "text", text: "command output" }], isError: false,
					details: { digest: "command output", run_not_recorded: reason },
				});
				for (const expanded of [false, true]) {
					component.setExpanded(expanded);
					const lines = component.render(100);
					const rendered = stripAnsi(lines.join("\n")).replace(/\s+/g, " ");
					assert.match(rendered, /The command ran, but the host did not record this run/);
					assert.match(rendered, /not verification or UAT evidence/);
					assert.match(rendered, /Do not run the command again/);
					assert.doesNotMatch(rendered, /output hidden/);
					assert.match(stripAnsi(lines[0]), expanded ? /ctrl\+o collapse/ : /ctrl\+o expand/);
					assert.equal(component.getRollupPhase(), null);
					assert.equal(component.getDisplayedLineCount(100), lines.length);
					assert.ok(lines.length > 1);
				}
			}
		}
	});

	test("structured warning-like output does not fabricate recording failures or disable compact rollup", () => {
		for (const toolName of ["gsd_exec", "gsd_uat_exec"]) {
			for (const digest of ["", "--- warning ---", "The command ran, but the host did not record this run"]) {
				const component = new ToolExecutionComponent(
					toolName, { purpose: "Inspect output" }, {}, undefined, { requestRender() {} } as any,
				);
				const text = `header\n--- digest ---\n${digest || "--- warning ---"}`;
				component.updateResult({ content: [{ type: "text", text }], isError: false, details: { digest } });
				const lines = component.render(120);
				assert.equal(lines.length, 1);
				assert.match(stripAnsi(lines[0]), /output hidden.*ctrl\+o expand/);
				assert.ok(component.getRollupPhase());
				assert.equal(component.getDisplayedLineCount(120), 1);
				component.setExpanded(true);
				const expanded = stripAnsi(component.render(120).join("\n"));
				assert.doesNotMatch(expanded, /not verification or UAT evidence|Do not run the command again/);
			}
		}
	});

	test("structured recording warnings use metadata even when output imitates the host warning", () => {
		for (const toolName of ["gsd_exec", "gsd_uat_exec"]) {
			const digest = "The command ran, but the host did not record this run: printed by command.";
			const component = new ToolExecutionComponent(
				toolName, {}, {}, undefined, { requestRender() {} } as any,
			);
			component.updateResult({
				content: [{ type: "text", text: `header\n--- digest ---\n${digest}` }], isError: false,
				details: { digest, run_not_recorded: "actual database failure" },
			});
			for (const expanded of [false, true]) {
				component.setExpanded(expanded);
				const rendered = stripAnsi(component.render(160).join("\n")).replace(/\s+/g, " ");
				assert.match(rendered, /did not record this run: actual database failure/);
				assert.equal(component.getRollupPhase(), null);
			}
		}
	});

	test("middle recording warnings survive generic caps, failures, and custom renderers", () => {
		const warning = "The command ran, but the host did not record this run: database offline. " +
			"This run is not verification or UAT evidence. Do not run the command again only to get the output.";
		const output = [...Array.from({ length: 80 }, (_, i) => `before ${i}`),
			"--- warning ---", warning, ...Array.from({ length: 80 }, (_, i) => `after ${i}`)].join("\n");
		for (const isError of [false, true]) {
			for (const definition of [undefined, { renderResult() { throw new Error("renderer failed"); } },
				{ renderResult() { return { render() { return ["custom output"]; } }; } }]) {
				const component = new ToolExecutionComponent(
					"gsd_exec", {}, {}, definition as any, { requestRender() {} } as any,
				);
				component.updateResult({
					content: [{ type: "text", text: output }], isError,
					details: { run_not_recorded: "database offline", ...(isError ? { displayReason: "Command failed" } : {}) },
				});
				for (const expanded of [false, true]) {
					component.setExpanded(expanded);
					const lines = component.render(120);
					const rendered = stripAnsi(lines.join("\n")).replace(/\s+/g, " ");
					assert.ok(rendered.includes(warning), rendered);
					assert.equal(component.getDisplayedLineCount(120), lines.length);
					assert.equal(component.getRollupPhase(), null);
					if (isError) assert.match(rendered, /failed/);
				}
			}
		}
	});

	test("legacy paired host-warning footers prevent compact success without result details", () => {
		for (const text of [
			"done\n--- warning ---\nThe command ran, but the host did not record this run: offline.\n" +
				"This run is not verification or UAT evidence.\nDo not run the command again only to get the output.",
			"done\n--- warning ---\nThe command ran, but the host did not record this run: offline. " +
				"This run is not verification or UAT evidence. Do not run the command again only to get the output.",
		]) {
			const component = new ToolExecutionComponent("gsd_uat_exec", {}, {}, undefined, { requestRender() {} } as any);
			component.updateResult({ content: [{ type: "text", text }], isError: false });
			const rendered = stripAnsi(component.render(120).join("\n")).replace(/\s+/g, " ");
			assert.match(rendered, /The command ran, but the host did not record this run/);
			assert.match(rendered, /not verification or UAT evidence/);
			assert.match(rendered, /Do not run the command again/);
			assert.equal(component.getRollupPhase(), null);
		}
	});

	test("does not duplicate custom renderer warnings wrapped within words at narrow widths", () => {
		const warning = "Warning: The command ran, but the host did not record this run: " +
			"database_recording_failure_with_a_long_unbroken_reason. " +
			"This run is not verification or UAT evidence. Do not run the command again only to get the output.";
		const component = new ToolExecutionComponent("gsd_exec", {}, {}, {
			renderResult() { return new Text(warning, 0, 0); },
		} as any, { requestRender() {} } as any);
		component.updateResult({
			content: [{ type: "text", text: `done\n--- warning ---\n${warning}` }],
			isError: false,
			details: { run_not_recorded: "database_recording_failure_with_a_long_unbroken_reason" },
		});
		for (const expanded of [false, true]) {
			component.setExpanded(expanded);
			for (const width of [20, 30, 40, 80, 120]) {
				const lines = component.render(width);
				const rendered = stripAnsi(lines.join("\n")).replace(/\s/g, "");
				assert.equal(rendered.split("Thecommandran,butthehostdidnotrecordthisrun").length - 1, 1);
				assert.equal(rendered.split("Donotrunthecommandagainonlytogettheoutput.").length - 1, 1);
				assert.equal(component.getDisplayedLineCount(width), lines.length);
			}
		}
	});

	test("running timer uses rail cadence only for expanded cards", (t) => {
		// Expanded running tool cards animate their rail at the rail frame cadence.
		// Collapsed strips are static except for the elapsed-seconds label, so they
		// must not drive full-tree renders every 70ms.
		mock.timers.enable({ apis: ["setInterval", "Date"] });
		t.after(() => {
			setRailAnimationEnabled(true); // module-global — restore default for other tests
			mock.timers.reset();
		});

		setRailAnimationEnabled(true);

		// Collapsed non-bash tools render as a static compact strip. The elapsed
		// label changes only once per second, so the timer uses that cadence.
		let collapsedRenderRequests = 0;
		const collapsedCard = new ToolExecutionComponent(
			"gsd_plan_slice",
			{ prompt: "large context" },
			{},
			undefined,
			{ requestRender() { collapsedRenderRequests++; } } as any,
		);
		collapsedCard.render(120);
		mock.timers.tick(70);
		mock.timers.tick(70);
		assert.equal(collapsedRenderRequests, 0, "compact strip does not use the 70ms rail cadence");
		mock.timers.tick(860);
		assert.equal(collapsedRenderRequests, 1, "compact strip refreshes at elapsed-seconds cadence");

		// Expanded cards keep the fast rail cadence while in-flight.
		let expandedRenderRequests = 0;
		const expandedCard = new ToolExecutionComponent(
			"gsd_plan_slice",
			{ prompt: "large context" },
			{},
			undefined,
			{ requestRender() { expandedRenderRequests++; } } as any,
		);
		expandedCard.setExpanded(true);
		mock.timers.tick(70);
		mock.timers.tick(70);
		assert.ok(expandedRenderRequests >= 2, `rail should animate while expanded, got ${expandedRenderRequests}`);

		// It keeps animating indefinitely while in-flight — no cap, no freeze.
		const before = expandedRenderRequests;
		for (let i = 0; i < 200; i++) mock.timers.tick(70);
		const animatedTicks = expandedRenderRequests - before;
		assert.ok(
			animatedTicks >= 180,
			`rail must keep animating at a constant rate (no cap), got ${animatedTicks} over 200 ticks`,
		);

		// Stops once the result arrives.
		expandedCard.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
		const afterResult = expandedRenderRequests;
		mock.timers.tick(70);
		mock.timers.tick(70);
		assert.equal(expandedRenderRequests, afterResult, "rail stops once the tool has a result");

		// Animation OFF: the timer is never armed.
		setRailAnimationEnabled(false);
		let offRenders = 0;
		const offCard = new ToolExecutionComponent(
			"gsd_plan_slice",
			{ prompt: "large context" },
			{},
			undefined,
			{ requestRender() { offRenders++; } } as any,
		);
		offCard.render(120);
		mock.timers.tick(1000);
		assert.equal(offRenders, 0, "no running timer when the setting is off (zero idle CPU)");
	});

	test("reuses shared tool-argument normalization for pending invocation matching", () => {
		const sourceUrl = existsSync(new URL("../tool-execution.ts", import.meta.url))
			? new URL("../tool-execution.ts", import.meta.url)
			: new URL("../tool-execution.js", import.meta.url);
		const source = readFileSync(sourceUrl, "utf8");

		assert.match(source, /import \{ normalizeToolArguments \} from "@gsd\/pi-ai";/);
		assert.doesNotMatch(source, /function tryParseJsonValue/);
		assert.doesNotMatch(source, /filePath \?\? normalized\.file_path \?\? normalized\.file/);
	});

	test("matches pending invocations after normalizing equivalent path aliases", () => {
		const component = new ToolExecutionComponent(
			"read",
			{ filePath: "README.md" },
			{},
			undefined,
			{ requestRender() {} } as any,
		);

		assert.equal(component.matchesInvocation("read", { path: "README.md" }), true);
	});

	test("renders framed header with running status while tool is partial", () => {
		const rendered = renderToolCollapsed("mcp__demo__do_thing", { ok: true });

		assert.match(rendered, /DEMO\u00b7DO_THING/);
		assert.doesNotMatch(rendered, /Tool demo\u00b7do_thing/);
		assert.match(rendered, /running/);
		assert.match(rendered, /running · \d+(ms|s)/);
		// Variant A uses a plain single-line compact card (no framed border/rail);
		// the ━ rail sweep was removed from renderToolLineCard in fa2cf288.
	});

	test("does not render active rail sweep on completed cards", () => {
		const rendered = renderToolCollapsed(
			"mcp__demo__do_thing",
			{ ok: true },
			{ content: [{ type: "text", text: "done" }], isError: false },
		);

		assert.match(rendered, /success · \d+(ms|s)/);
		assert.doesNotMatch(rendered, /━/);
	});

	test("does not duplicate running generic tool labels before args", () => {
		const rendered = renderToolCollapsed(
			"Agent",
			{
				description: "Scout habit tracker codebase",
				subagent_type: "Explore",
				prompt: "Read these files and give me a concise summary of each.",
			},
		);

		const labelMatches = rendered.match(/AGENT/g) ?? [];
		assert.equal(labelMatches.length, 1, `expected only the card title to contain AGENT:\n${rendered}`);
		assert.doesNotMatch(rendered, /description="Scout habit tracker codebase"/);
		assert.doesNotMatch(rendered, /subagent_type="Explore"/);
		assert.match(rendered, /running · \d+(ms|s)/);
	});

	test("renders framed header with failed status for failed tool result", () => {
		const rendered = renderTool(
			"mcp__demo__do_thing",
			{ ok: true },
			{ content: [{ type: "text", text: "boom" }], isError: true },
		);

		assert.match(rendered, /DEMO\u00b7DO_THING/);
		assert.doesNotMatch(rendered, /Tool demo\u00b7do_thing/);
		assert.match(rendered, /failed/);
		assert.match(rendered, /failed · \d+(ms|s)/);
		assert.match(rendered, /boom/);
	});

	test("generic failed tools render displayReason instead of model-facing policy text", () => {
		const modelFacingReason = [
			'HARD BLOCK: unit "discuss-requirements" is constrained by auto-unit tool scope.',
			'GSD lifecycle tool "gsd_milestone_status" is not permitted.',
			"This is a mechanical phase-boundary gate. You MUST NOT proceed, retry the same call, or route around this block.",
		].join(" ");
		const rendered = renderTool(
			"gsd_milestone_status",
			{ milestoneId: "M001" },
			{
				content: [
					{
						type: "text",
						text: modelFacingReason,
					},
				],
				isError: true,
				details: {
					displayReason: "This GSD phase only allows its scoped workflow tools.",
				},
			},
		);

		assert.match(rendered, /This GSD phase only allows its scoped workflow tools/);
		assert.doesNotMatch(rendered, /HARD BLOCK/);
		assert.doesNotMatch(rendered, /phase-boundary gate/);
		assert.doesNotMatch(rendered, /MUST NOT proceed/);
	});

	test("collapses successful low-signal tool cards by default", () => {
		const rendered = renderToolCollapsed(
			"mcp__demo__noop",
			{ ok: true },
			{ content: [], isError: false },
		);

		assert.match(rendered, /success · \d+(ms|s)/);
		assert.match(rendered, /DEMO\u00b7NOOP/);
		assert.doesNotMatch(rendered, /Completed/);
		assert.doesNotMatch(rendered, /ok=true/);
	});

	test("does not duplicate generic tool labels in collapsed cards", () => {
		const rendered = renderToolCollapsed(
			"TodoWrite",
			{ todos: [{ content: "Ship it", status: "pending" }] },
			{ content: [{ type: "text", text: "TodoWrite" }], isError: false },
		);

		const labelMatches = rendered.match(/TODOWRITE/g) ?? [];
		assert.equal(labelMatches.length, 1, `expected only the card title to contain TODOWRITE:\n${rendered}`);
		assert.match(rendered, /output hidden/);
		assert.match(rendered, /ctrl\+o expand/);
	});

	test("exposes phase metadata for successful low-signal tool rows", () => {
		const component = new ToolExecutionComponent(
			"gsd_requirement_update",
			{ id: "R001" },
			{},
			{ label: "Update Requirement" } as any,
			{ requestRender() {} } as any,
		);
		component.updateResult({ content: [], isError: false });

		assert.deepEqual(component.getRollupPhase()?.label, "Requirement writes");
	});

	test("exposes phase metadata for collapsed output-bearing generic tools", () => {
		const component = new ToolExecutionComponent(
			"mcp__demo__do_thing",
			{ ok: true },
			{},
			undefined,
			{ requestRender() {} } as any,
		);
		component.updateResult({ content: [{ type: "text", text: "important output" }], isError: false });

		assert.deepEqual(component.getRollupPhase()?.label, "Other tool actions");
	});

	test("renders compact read rows with target metadata", () => {
		const rendered = renderToolCollapsed(
			"read",
			{ path: "src/Inspector.tsx" },
			{
				content: [{ type: "text", text: "source" }],
				isError: false,
				details: {
					target: {
						kind: "file",
						action: "read",
						inputPath: "src/Inspector.tsx",
						resolvedPath: "/tmp/project/src/Inspector.tsx",
						range: { start: 4, end: 12 },
					},
				},
			},
		);

		assert.match(rendered, /READ/);
		assert.match(rendered, /src\/Inspector\.tsx:4-12/);
		assert.doesNotMatch(rendered, /source/);
		assert.doesNotMatch(rendered, /output hidden\n\s*│\s*ctrl\+o expand/);
	});

	test("renders compact capitalized read rows from file_path args", () => {
		const rendered = renderToolCollapsed(
			"Read",
			{ file_path: "~/projects/gsd-pi/src/resources/extensions/gsd/health-widget-core.ts" },
			{ content: [{ type: "text", text: "hidden body output" }], isError: false },
		);

		assert.match(rendered, /READ/);
		assert.match(rendered, /health-widget-core\.ts/);
		assert.doesNotMatch(rendered, /hidden body output/);
	});

	test("renders compact read rows from direct result details path", () => {
		const rendered = renderToolCollapsed(
			"read",
			{},
			{
				content: [{ type: "text", text: "hidden body output" }],
				isError: false,
				details: {
					path: "/tmp/project/src/resources/extensions/gsd/health-widget-core.ts",
					range: { start: 1, end: 12 },
				},
			},
		);

		assert.match(rendered, /READ/);
		assert.match(rendered, /health-widget-core\.ts:1-12/);
		assert.doesNotMatch(rendered, /hidden body output/);
	});

	test("truncates expanded read output lines to the display cap", () => {
		const output = Array.from({ length: READ_TUI_EXPANDED_MAX_LINES + 2 }, (_, index) => `line-${index + 1}`).join("\n");
		const rendered = renderTool(
			"read",
			{ path: "big.txt" },
			{ content: [{ type: "text", text: output }], isError: false },
		);

	assert.match(rendered, /line-1/);
	assert.match(rendered, new RegExp(`line-${READ_TUI_EXPANDED_MAX_LINES}\\b`));
	assert.doesNotMatch(rendered, new RegExp(`line-${READ_TUI_EXPANDED_MAX_LINES + 1}\\b`));
	assert.match(rendered, /2 more lines hidden from display/);
});

test("truncates expanded write content to the shared display cap", () => {
	const total = TOOL_TUI_EXPANDED_MAX_LINES + 40;
	const content = Array.from({ length: total }, (_, index) => `wline-${index + 1}`).join("\n");
	const rendered = renderTool(
		"write",
		{ path: "big.txt", content },
		{ content: [{ type: "text", text: "ok" }], isError: false },
	);

	// Head+tail window: first and last lines visible, middle elided with a hint.
	assert.match(rendered, /wline-1\b/);
	assert.match(rendered, new RegExp(`wline-${total}\\b`));
	assert.doesNotMatch(rendered, /wline-30\b/, "middle lines must be elided from the expanded body");
	assert.match(rendered, /40 middle lines hidden from display/);
});

test("truncates expanded bash output to the shared display cap", () => {
	const total = TOOL_TUI_EXPANDED_MAX_LINES + 40;
	const output = Array.from({ length: total }, (_, index) => `out-${index + 1}`).join("\n");
	const rendered = renderTool(
		"bash",
		{ command: "generate" },
		{ content: [{ type: "text", text: output }], isError: false },
	);

	assert.match(rendered, /out-1\b/);
	assert.match(rendered, new RegExp(`out-${total}\\b`));
	assert.doesNotMatch(rendered, /out-30\b/, "middle lines must be elided from the expanded body");
	assert.match(rendered, /40 middle lines hidden from display/);
});

test("truncates huge error bodies with the same display window", () => {
	const total = TOOL_TUI_EXPANDED_MAX_LINES + 40;
	const errorOutput = Array.from({ length: total }, (_, index) => `err-${index + 1}`).join("\n");
	const rendered = renderTool(
		"write",
		{ path: "x.txt", content: "hi" },
		{ content: [{ type: "text", text: errorOutput }], isError: true },
	);

	assert.match(rendered, /err-1\b/);
	assert.match(rendered, new RegExp(`err-${total}\\b`));
	assert.doesNotMatch(rendered, /err-30\b/, "middle lines must be elided from the error body");
	assert.match(rendered, /40 middle lines hidden from display/);
});

test("collapses carriage-return progress frames to the last frame", () => {
	const rendered = renderTool(
		"write",
		{ path: "progress.txt", content: "0%\r25%\r50%\r100%\nnext" },
		{ content: [{ type: "text", text: "ok" }], isError: false },
	);

	assert.match(rendered, /100%/);
	assert.match(rendered, /next/);
	assert.doesNotMatch(rendered, /0%25%50%/, "progress frames must not concatenate into one giant line");
	assert.doesNotMatch(rendered, /\b25%\b/, "overwritten frames must be gone entirely");
});

test("collapses carriage-return frames in tool output bodies", () => {
	const rendered = renderTool(
		"bash",
		{ command: "progress" },
		{ content: [{ type: "text", text: "frame1\rframe2\rframe3\nafter" }], isError: false },
	);

	assert.match(rendered, /frame3/);
	assert.match(rendered, /after/);
	assert.doesNotMatch(rendered, /frame1frame2frame3/, "progress frames must not concatenate into one giant line");
	assert.doesNotMatch(rendered, /\bframe1\b/, "overwritten frames must be gone entirely");
	assert.doesNotMatch(rendered, /\bframe2\b/, "overwritten frames must be gone entirely");
});

test("keeps the frame a trailing carriage return points at", () => {
	const rendered = renderTool(
		"bash",
		{ command: "progress" },
		{ content: [{ type: "text", text: "0%\r100%\r" }], isError: false },
	);

	// A trailing \r moves the cursor without erasing: the frame stays visible.
	assert.match(rendered, /100%/);
	assert.doesNotMatch(rendered, /\b0%\b/, "overwritten frames must be gone entirely");
});

test("keeps CRLF line endings intact while collapsing frames", () => {
	const rendered = renderTool(
		"write",
		{ path: "crlf.txt", content: "line one\r\nline two" },
		{ content: [{ type: "text", text: "ok" }], isError: false },
	);

	assert.match(rendered, /line one/);
	assert.match(rendered, /line two/);
});

// Lines made only of \r (blank CRLF lines, e.g. "a\r\n\r\nb" from SSH/RouterOS
// output) used to spin collapseCarriageReturnFrames forever (#2636).
test("renders blank CRLF lines without hanging", () => {
	const rendered = renderTool(
		"bash",
		{ command: "ssh router print" },
		{ content: [{ type: "text", text: "Flags: R\r\n\r\n 0 R ether1\r\n\r\r\nend" }], isError: false },
	);

	assert.match(rendered, /Flags: R/);
	assert.match(rendered, /0 R ether1/);
	assert.match(rendered, /end/);
	assert.doesNotMatch(rendered, /\r/, "carriage returns must not reach the rendered output");
});

test("renders output that is only carriage returns without hanging", () => {
	const rendered = renderTool(
		"bash",
		{ command: "cr-only" },
		{ content: [{ type: "text", text: "\r" }], isError: false },
	);

	assert.doesNotMatch(rendered, /\r/);
});

// Read results reach the same collapse through getTextOutput(): a `curl -D -`
// header dump ends "\r\n\r\n" (#2743), so splitting on \n leaves a \r-only
// line, which used to spin collapseCarriageReturnFrames forever on the read
// path too.
test("renders a read result ending in a blank CRLF line without hanging", () => {
	const rendered = renderTool(
		"read",
		{ path: "headers.txt" },
		{
			content: [{ type: "text", text: "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\n\r\n" }],
			isError: false,
		},
	);

	assert.match(rendered, /HTTP\/1\.1 200 OK/);
	assert.match(rendered, /content-type: text\/html/);
	assert.doesNotMatch(rendered, /\r/, "carriage returns must not reach the rendered read output");
});

test("caps raw output fallback for tools without a custom result renderer", () => {
	const total = TOOL_TUI_EXPANDED_MAX_LINES + 40;
	const output = Array.from({ length: total }, (_, index) => `raw-${index + 1}`).join("\n");
	const rendered = renderTool(
		"mcp__demo__raw",
		{ ok: true },
		{ content: [{ type: "text", text: output }], isError: false },
		{},
	);

	assert.match(rendered, /raw-1\b/);
	assert.match(rendered, new RegExp(`raw-${total}\\b`));
	assert.doesNotMatch(rendered, /raw-30\b/, "fallback output must be capped like every other body");
	assert.match(rendered, /40 middle lines hidden from display/);
});

test("rebuilds incremental write highlighting when carriage returns stream in", () => {
	const component = new ToolExecutionComponent(
		"write",
		{ path: "progress.ts", content: "frame1" },
		{},
		undefined,
		{ requestRender() {} } as any,
	);
	component.setExpanded(true);
	component.updateArgs({ path: "progress.ts", content: "frame1\rframe2" });
	const rendered = stripAnsi(component.render(120).join("\n"));

	assert.match(rendered, /frame2/);
	assert.doesNotMatch(rendered, /frame1frame2/, "delta normalization must match a fresh full normalization");
});

test("windows 51-line output just over the cap", () => {
	const total = TOOL_TUI_EXPANDED_MAX_LINES + 1;
	const output = Array.from({ length: total }, (_, index) => `edge-${index + 1}`).join("\n");
	const rendered = renderTool(
		"bash",
		{ command: "echo" },
		{ content: [{ type: "text", text: output }], isError: false },
	);

	assert.match(rendered, /edge-1\b/);
	assert.match(rendered, new RegExp(`edge-${total}\\b`));
	assert.doesNotMatch(rendered, /edge-26\b/, "the single middle line must be elided");
	assert.match(rendered, /1 middle lines? hidden from display/);
});

test("renders small expanded outputs unchanged", () => {
	const output = Array.from({ length: 10 }, (_, index) => `sline-${index + 1}`).join("\n");
	const rendered = renderTool(
		"bash",
		{ command: "echo" },
		{ content: [{ type: "text", text: output }], isError: false },
	);

	for (let index = 1; index <= 10; index++) {
		assert.match(rendered, new RegExp(`sline-${index}\\b`));
	}
	assert.doesNotMatch(rendered, /hidden from display/);
});

test("collapsed write body keeps the total-lines hint", () => {
	const content = Array.from({ length: 15 }, (_, index) => `cline-${index + 1}`).join("\n");
	const rendered = renderToolCollapsed(
		"write",
		{ path: "w.txt", content },
		{ content: [{ type: "text", text: "boom" }], isError: true },
	);

	assert.match(rendered, /cline-10\b/);
	assert.doesNotMatch(rendered, /cline-11\b/);
	assert.match(rendered, /\(5 more lines, 15 total, ctrl\+o to expand\)/);
	assert.match(rendered, /boom/);
});

	test("renders compact edit rows with target metadata", () => {
		const rendered = renderToolCollapsed(
			"edit",
			{ path: "src/Inspector.tsx" },
			{
				content: [{ type: "text", text: "Updated src/Inspector.tsx" }],
				isError: false,
				details: {
					target: {
						kind: "file",
						action: "edit",
						inputPath: "src/Inspector.tsx",
						resolvedPath: "/tmp/project/src/Inspector.tsx",
						line: 42,
					},
				},
			},
		);

		assert.match(rendered, /EDIT/);
		assert.match(rendered, /src\/Inspector\.tsx:42/);
		assert.doesNotMatch(rendered, /Updated src\/Inspector\.tsx/);
	});

	test("renders running edit rows with title and target on the top line", () => {
		const rendered = renderToolCollapsed("edit", { path: "src/Inspector.tsx" });

		const labelMatches = rendered.match(/EDIT/g) ?? [];
		assert.equal(labelMatches.length, 1, `expected tool name only in the card title:\n${rendered}`);
		assert.match(rendered, /src\/Inspector\.tsx/);
		assert.match(rendered, /EDIT src\/Inspector\.tsx/);
		assert.match(rendered, /running · \d+(ms|s)/);
	});

	test("renders compact write rows with target metadata", () => {
		const rendered = renderToolCollapsed(
			"write",
			{ path: "src/output.ts", content: "ok" },
			{
				content: [{ type: "text", text: "Successfully wrote 2 bytes to src/output.ts" }],
				isError: false,
				details: {
					target: {
						kind: "file",
						action: "write",
						inputPath: "src/output.ts",
						resolvedPath: "/tmp/project/src/output.ts",
					},
				},
			},
		);

		assert.match(rendered, /WRITE/);
		assert.match(rendered, /src\/output\.ts/);
		assert.doesNotMatch(rendered, /Successfully wrote/);
	});

	test("omits default cwd placeholders for collapsed search tools", () => {
		const rendered = renderToolCollapsed(
			"Grep",
			{},
			{ content: [{ type: "text", text: "hidden body output" }], isError: false },
		);

		assert.match(rendered, /GREP/);
		assert.doesNotMatch(rendered, /^│\.\s+│/m, `expected no placeholder cwd body:\n${rendered}`);
		assert.match(rendered, /output hidden/);
		assert.doesNotMatch(rendered, /hidden body output/);
		assert.doesNotMatch(rendered, /^│\s+output hidden/m, `expected compact footer text on the top row:\n${rendered}`);
	});

	test("keeps meaningful collapsed search targets", () => {
		const rendered = renderToolCollapsed(
			"Grep",
			{ pattern: "Project Initialized", path: "src/resources/extensions/gsd", glob: "*.ts" },
			{ content: [{ type: "text", text: "hidden body output" }], isError: false },
		);

		assert.match(rendered, /Project Initialized in src\/resources\/extensions\/gsd \(\*\.ts\)/);
		assert.doesNotMatch(rendered, /hidden body output/);
	});

	test("renders compact bash rows with command preview", () => {
		const rendered = renderToolCollapsed(
			"bash",
			{ command: "npm run typecheck -- --watch false" },
			{ content: [{ type: "text", text: "ok" }], isError: false, details: { cwd: "/tmp/project" } },
		);

		assert.match(rendered, /\$ npm run typecheck -- --watch false/);
		assert.doesNotMatch(rendered, /├/, "collapsed command cards should not include internal divider lines");
		assert.doesNotMatch(rendered, /\bok\b/);
	});

	test("uses available row width for compact bash command text", () => {
		const rendered = renderToolCollapsed(
			"bash",
			{
				command:
					'grep -n "expanded\\|toolOutputExpanded\\|setExpanded\\|defaultExpanded" /tmp/project/src/tool-execution.ts',
			},
			{ content: [{ type: "text", text: "ok" }], isError: false, details: { cwd: "/tmp/project" } },
			undefined,
			200,
		);

		assert.match(rendered, /defaultExpanded/);
	});

	test("keeps failed tools expanded and error visible", () => {
		const rendered = renderToolCollapsed(
			"edit",
			{ path: "src/Inspector.tsx" },
			{
				content: [{ type: "text", text: "Could not find target text" }],
				isError: true,
				details: {
					target: {
						kind: "file",
						action: "edit",
						inputPath: "src/Inspector.tsx",
						resolvedPath: "/tmp/project/src/Inspector.tsx",
					},
				},
			},
		);

		assert.match(rendered, /Could not find target text/);
		assert.match(rendered, /edit/);
	});

	test("renders phase-based summaries for rolled-up tool executions", () => {
		const phases: ToolExecutionPhase[] = [
			{ label: "Setup / shell", count: 6, durationMs: 12 },
			{
				label: "Context reads",
				count: 4,
				durationMs: 6,
				actionLabel: "read",
				targets: ["/tmp/project/src/a.ts", "/tmp/project/src/b.ts"],
			},
			{
				label: "File changes",
				count: 3,
				durationMs: 5,
				actionLabel: "edit",
				targets: ["/tmp/project/src/Inspector.tsx:42", "/tmp/project/src/CompareView.tsx:8"],
			},
			{ label: "Requirement writes", count: 4, durationMs: 4 },
			{ label: "Memory lookups", count: 4, durationMs: 4 },
			{ label: "Finalization", count: 1, durationMs: 1 },
		];
		const rendered = stripAnsi(new ToolPhaseSummaryComponent(phases).render(120).join("\n"));

		assert.match(rendered, /Setup \/ shell 6 actions\s+success · 12ms/);
		assert.match(rendered, /Context reads · 2 files\s+success · 6ms/);
		assert.match(rendered, /src\/a\.ts/);
		assert.match(rendered, /File changes · 2 files, 3 edits\s+success · 5ms/);
		assert.match(rendered, /src\/Inspector\.tsx:42/);
		assert.match(rendered, /Requirement writes 4 actions\s+success · 4ms/);
		assert.match(rendered, /Memory lookups 4 actions\s+success · 4ms/);
		assert.match(rendered, /Finalization 1 action\s+success · 1ms/);
	});

	test("passes failed result status to custom result renderers", () => {
		const rendered = renderTool(
			"gsd_requirement_save",
			{ id: "R001" },
			{ content: [{ type: "text", text: "saved" }], isError: true },
			{
				label: "Save Requirement",
				renderResult(result: { isError?: boolean }) {
					return {
						render: () => [result.isError ? "custom saw error" : "custom saw success"],
						invalidate() {},
					};
				},
			},
		);

		assert.match(rendered, /failed/);
		assert.match(rendered, /custom saw error/);
		assert.doesNotMatch(rendered, /custom saw success/);
	});

	test("renders capitalized Claude Code Bash tool names with bash output instead of generic args JSON", () => {
		const rendered = renderTool(
			"Bash",
			{ command: "pwd" },
			{ content: [{ type: "text", text: "/tmp/gsd-pr-fix" }], isError: false },
		);

		assert.match(rendered, /\$ pwd/);
		assert.match(rendered, /\/tmp\/gsd-pr-fix/);
		assert.doesNotMatch(rendered, /^\{\s*\}$/m);
	});

	test("renders capitalized Claude Code Read tool names with read output", () => {
		const rendered = renderTool(
			"Read",
			{ path: "/tmp/demo.txt" },
			{ content: [{ type: "text", text: "hello\nworld" }], isError: false },
		);

		assert.match(rendered, /read .*demo\.txt/);
		assert.match(rendered, /hello/);
		assert.match(rendered, /world/);
	});

	test("generic fallback strips mcp__<server>__ prefix and shows server·tool title", () => {
		const rendered = renderTool(
			"mcp__context7__resolve_library_id",
			{ name: "react" },
			{ content: [{ type: "text", text: "react@18.3.1" }], isError: false },
		);

		assert.match(rendered, /CONTEXT7\u00b7RESOLVE_LIBRARY_ID/);
		assert.doesNotMatch(rendered, /mcp__/);
		assert.match(rendered, /name="react"/);
		assert.match(rendered, /react@18\.3\.1/);
	});

	test("generic fallback renders compact key=value args for primitive args", () => {
		const rendered = renderTool(
			"some_unknown_tool",
			{ count: 3, enabled: true, label: "hello" },
		);

		assert.match(rendered, /SOME UNKNOWN TOOL/);
		assert.match(rendered, /count=3/);
		assert.match(rendered, /enabled=true/);
		assert.match(rendered, /label="hello"/);
		assert.doesNotMatch(rendered, /^\{$/m);
	});

	test("frame header prefers toolDefinition.label over raw tool name", () => {
		const rendered = renderToolCollapsed(
			"gsd_slice_complete",
			{ sliceId: "S03" },
			undefined,
			{ label: "Complete Slice" },
		);

		assert.match(rendered, /COMPLETE SLICE/);
		assert.doesNotMatch(rendered, /Tool Complete Slice/);
		assert.doesNotMatch(rendered, /gsd_slice_complete/);
	});

	test("frame header strips gsd_ prefix and title-cases when no label is registered", () => {
		const rendered = renderToolCollapsed("gsd_requirement_update", { id: "R005" });

		assert.match(rendered, /REQUIREMENT UPDATE/);
		assert.doesNotMatch(rendered, /Tool Requirement Update/);
		assert.doesNotMatch(rendered, /gsd_requirement_update/);
	});

	test("collapsed generic running tools hide primitive args", () => {
		const longPath = "/Users/alice/.gsd/projects/4dce7b775013/worktrees/slice-S03-some-long-path-that-exceeds-limit";
		const rendered = renderToolCollapsed("gsd_slice_complete", {
			sliceId: "S03",
			milestoneId: "M001",
			worktree: longPath,
		});

		assert.match(rendered, /SLICE COMPLETE/);
		assert.match(rendered, /running · \d+(ms|s)/);
		assert.doesNotMatch(rendered, /sliceId="S03"/);
		assert.doesNotMatch(rendered, /milestoneId="M001"/);
		assert.doesNotMatch(rendered, /worktree=/);
		assert.doesNotMatch(rendered, /"sliceId":\s*"S03"/);
	});

	test("formatCompactArgs shows full string values when expanded", () => {
		const longPath = "/Users/alice/.gsd/projects/4dce7b775013/worktrees/slice-S03-some-long-path-that-exceeds-limit";
		const rendered = renderTool("gsd_slice_complete", {
			sliceId: "S03",
			worktree: longPath,
		});

		assert.match(rendered, new RegExp(longPath.replace(/\//g, "\\/")));
		assert.doesNotMatch(rendered, /…/);
	});

	test("generic fallback collapses successful output rows until expanded", () => {
		const longOutput = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join("\n");
		const rendered = renderToolCollapsed(
			"mcp__demo__do_thing",
			{ ok: true },
			{ content: [{ type: "text", text: longOutput }], isError: false },
		);

		assert.match(rendered, /DEMO\u00b7DO_THING/);
		assert.match(rendered, /success · \d+(ms|s)/);
		assert.doesNotMatch(rendered, /line 1\b/);
		assert.doesNotMatch(rendered, /\(15 more lines/);
	});

	test("generic fallback falls back to truncated JSON for complex args", () => {
		const rendered = renderTool(
			"mcp__demo__nested",
			{ payload: { nested: { deeply: ["a", "b", "c"] } }, name: "x" },
		);

		assert.match(rendered, /DEMO\u00b7NESTED/);
		// Multi-line JSON dump for the complex payload
		assert.match(rendered, /"payload"/);
		assert.match(rendered, /"nested"/);
	});
});

// Regression coverage for inline image (Kitty/Ghostty protocol) rendering inside
// a tool card. The original bug ran collapseBlankLines() + trimOuterBlankLines()
// over the card body, which crushed the (rows-1) blank padding lines an image
// emits to reserve its height — framing a 24-row image as ~1 row so the terminal
// painted the full image over the chat and footer below it.
describe("ToolExecutionComponent inline image (Kitty) rendering", () => {
	// Force the Kitty image protocol and a representative cell size for the whole
	// block; restore the module-global capabilities/cell-size after each case so
	// these tests never leak terminal state into the rest of the suite.
	beforeEach(() => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 8, heightPx: 20 });
	});
	afterEach(() => {
		resetCapabilitiesCache();
		setCellDimensions({ widthPx: 9, heightPx: 18 });
	});

	// Render a `read` tool result that carries one inline PNG and return the RAW
	// card lines (not stripAnsi — image lines carry graphics escapes we assert on).
	function renderImageToolRaw(widthPx: number, heightPx: number, termWidth = 120): string[] {
		const component = new ToolExecutionComponent(
			"read",
			{ file_path: "/tmp/tall.png" },
			{ showImages: true },
			undefined as any,
			{ requestRender() {} } as any,
		);
		component.setExpanded(true);
		component.updateResult({
			content: [
				{ type: "text", text: "Read image file [image/png]" },
				{ type: "image", data: tinyPngBase64(widthPx, heightPx), mimeType: "image/png" } as any,
			],
			isError: false,
		});
		return component.render(termWidth);
	}

	test("reserves the image's full row height inside the card (no overflow)", () => {
		const lines = renderImageToolRaw(800, 2400); // very tall image (1:3)

		const seqIdx = lines.findIndex((l) => isImageLine(l));
		assert.ok(seqIdx >= 0, "card must contain the inline image sequence");

		// The card must keep many blank padding rows after the sequence so content
		// below the image is not overpainted. The original regression collapsed
		// them to ~1, framing a tall image as a single row. We don't pin the exact
		// row count (it depends on cell-size/maxHeight math); a tall image must
		// reserve far more than the broken ~1 row.
		const bottomBorderIdx = lines.length - 1;
		const blankRowsAfterSeq = lines
			.slice(seqIdx + 1, bottomBorderIdx)
			.filter((l) => l.trim().length === 0).length;
		assert.ok(
			blankRowsAfterSeq >= 10,
			`a tall image must reserve its height as blank padding rows; only ${blankRowsAfterSeq} were kept ` +
				`(regression: padding rows were collapsed/trimmed → image overflows the card)`,
		);
	});

	test("passes the image sequence through verbatim, left-aligned under the card text", () => {
		const lines = renderImageToolRaw(800, 2400);
		const seqLine = lines.find((l) => isImageLine(l));
		assert.ok(seqLine, "image sequence line should be present");

		// The raw Kitty sequence must be intact (no padRight/truncate corruption)…
		const afterIndent = seqLine.replace(/^ +/, "");
		assert.ok(afterIndent.startsWith("\x1b_G"), "Kitty sequence must survive verbatim after the indent");

		// …and the image is offset to sit under the card text (indent + 3 spaces),
		// not hugging column 0.
		const leadingSpaces = seqLine.match(/^ */)?.[0].length ?? 0;
		assert.ok(leadingSpaces >= 4, `image row should be indented under the card text, got ${leadingSpaces} spaces`);
	});

	test("non-image tool output still collapses blank rows (fix is image-scoped)", () => {
		// A generic (expanded) tool's text output flows through collapseBlankLines.
		// The image-preservation branch must NOT disable that for ordinary text —
		// a run of consecutive blank lines should still collapse.
		const rendered = renderTool(
			"mcp__demo__blanks",
			{ ok: true },
			{ content: [{ type: "text", text: "first\n\n\n\n\nsecond" }], isError: false },
		);
		assert.match(rendered, /first/);
		assert.match(rendered, /second/);
		assert.doesNotMatch(
			rendered,
			/first[\s\S]*?\n\s*\n\s*\n\s*\nsecond/,
			"plain text should still have consecutive blank rows collapsed",
		);
	});
});
