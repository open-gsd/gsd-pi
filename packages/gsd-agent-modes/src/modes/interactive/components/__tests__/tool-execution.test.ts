// Project/App: gsd-pi
// File Purpose: Tests for interactive terminal tool execution rendering.
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import stripAnsi from "strip-ansi";
import { isImageLine, resetCapabilitiesCache, setCapabilities, setCellDimensions } from "@gsd/pi-tui";
import { ToolExecutionComponent, ToolPhaseSummaryComponent, type ToolExecutionPhase } from "../tool-execution.js";
import { setRailAnimationEnabled } from "../transcript-design.js";
import { initTheme } from "@gsd/pi-coding-agent/theme/theme.js";
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

describe("ToolExecutionComponent", () => {
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
