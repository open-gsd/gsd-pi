// Project/App: gsd-pi
// File Purpose: Tests for the collapsible GSD status widget.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import stripAnsi from "strip-ansi";

import { initTheme } from "@gsd/pi-coding-agent/theme/theme.js";
import { GsdStatusWidget } from "./gsd-status-widget.js";

initTheme("dark", false);

describe("GsdStatusWidget", () => {
	test("renders nothing when idle in auto chat mode", () => {
		const widget = new GsdStatusWidget(() => ({
			override: "auto",
			activeToolCount: 0,
			cwd: "/tmp/project",
			manuallyExpanded: false,
		}));
		assert.deepEqual(widget.render(100), []);
	});

	test("renders a single collapsed line during workflow", () => {
		const widget = new GsdStatusWidget(() => ({
			override: "auto",
			activeToolCount: 1,
			gsdPhase: "Executing T03 renderer polish",
			cwd: "/tmp/project",
			manuallyExpanded: false,
		}));
		const plain = widget.render(100).map((line) => stripAnsi(line)).join("\n");
		assert.match(plain, /GSD AUTO/);
		assert.match(plain, /Executing T03/);
		assert.match(plain, /1 running/);
		assert.doesNotMatch(plain, /╭/);
	});

	test("shows compact blocked indicator on error without repeating the message", () => {
		const widget = new GsdStatusWidget(() => ({
			override: "auto",
			activeToolCount: 0,
			lastError: "Recovery signal",
			cwd: "/tmp/project",
			manuallyExpanded: false,
		}));
		const plain = widget.render(100).map((line) => stripAnsi(line)).join("\n");
		assert.match(plain, /Recovery/);
		assert.match(plain, /blocked/);
		assert.doesNotMatch(plain, /Recovery signal/);
	});

	test("shows animated badge while the agent turn is streaming", () => {
		const widget = new GsdStatusWidget(() => ({
			override: "auto",
			activeToolCount: 0,
			cwd: "/tmp/project",
			manuallyExpanded: false,
			isStreaming: true,
			gsdProgress: {
				phase: "Executing T03 renderer polish",
				modeTag: "AUTO",
				elapsed: "1m 02s",
				widgetMode: "small",
			},
		}));
		const plain = widget.render(100).map((line) => stripAnsi(line)).join("\n");
		assert.match(plain, /GSD AUTO/);
		assert.match(plain, /Executing T03/);
		assert.doesNotMatch(plain, /● GSD AUTO/);
	});

	test("renders progress-driven strip lines when gsdProgress is set", () => {
		const widget = new GsdStatusWidget(() => ({
			override: "auto",
			activeToolCount: 1,
			cwd: "/tmp/project",
			manuallyExpanded: true,
			gsdProgress: {
				phase: "Executing T03 renderer polish",
				modeTag: "AUTO",
				taskProgress: { done: 8, total: 14 },
				sliceLabel: "S02",
				taskLabel: "T03",
				unitLabel: "M001/S02/T03",
				elapsed: "14m",
				eta: "~6m left",
				path: "/tmp/project",
				widgetMode: "small",
			},
		}));
		const plain = widget.render(120).map((line) => stripAnsi(line)).join("\n");
		assert.match(plain, /tasks .* 8\/14/);
		assert.match(plain, /●/);
		assert.match(plain, /○/);
		assert.doesNotMatch(plain, /█/);
		assert.match(plain, /14m/);
		assert.doesNotMatch(plain, /╭/);
	});

	test("renders slice and task step dots when sliceProgress is set", () => {
		const widget = new GsdStatusWidget(() => ({
			override: "auto",
			activeToolCount: 0,
			cwd: "/tmp/project",
			manuallyExpanded: true,
			gsdProgress: {
				phase: "running UAT S01",
				modeTag: "AUTO",
				sliceProgress: { done: 2, total: 6 },
				taskProgress: { done: 3, total: 3 },
				sliceLabel: "S01",
				elapsed: "6m 12s",
				widgetMode: "small",
			},
		}));
		const lines = widget.render(120).map((line) => stripAnsi(line));
		const plain = lines.join("\n");
		assert.match(plain, /slices .* 2\/6/);
		assert.match(plain, /tasks .* 3\/3/);
		assert.doesNotMatch(plain, /█/);
		const head = lines[0] ?? "";
		assert.ok(head.trimEnd().endsWith("S01"), "slice/task progress should sit on the far right of the header line");
	});

	test("renders the dispatched model ahead of timing in the head line", () => {
		const widget = new GsdStatusWidget(() => ({
			override: "auto",
			activeToolCount: 1,
			cwd: "/tmp/project",
			manuallyExpanded: false,
			gsdProgress: {
				phase: "Executing T03 renderer polish",
				modeTag: "AUTO",
				elapsed: "14m",
				eta: "~6m left",
				model: "openai/gpt-5.3-codex",
				widgetMode: "small",
			},
		}));
		const lines = widget.render(120).map((line) => stripAnsi(line));
		const plain = lines.join("\n");
		assert.match(plain, /openai\/gpt-5\.3-codex/);
		const head = lines[0] ?? "";
		const modelIdx = head.indexOf("openai/gpt-5.3-codex");
		const elapsedIdx = head.indexOf("14m");
		assert.ok(modelIdx !== -1 && elapsedIdx !== -1 && modelIdx < elapsedIdx, "model segment should precede timing segments");
		assert.match(head, /openai\/gpt-5\.3-codex · 14m · ~6m left/);
	});

	test("keeps the same height with and without healthSummary when expanded (#2333)", () => {
		const baseState = {
			override: "auto",
			activeToolCount: 0,
			cwd: "/tmp/project",
			manuallyExpanded: true,
			gsdProgress: {
				phase: "Executing T03 renderer polish",
				modeTag: "AUTO" as const,
				widgetMode: "full" as const,
			},
		};
		const withHealth = new GsdStatusWidget(() => ({
			...baseState,
			gsdProgress: { ...baseState.gsdProgress, healthSummary: "Health: all checks passing" },
		}));
		const withoutHealth = new GsdStatusWidget(() => ({ ...baseState }));

		const withLines = withHealth.render(120).map((line) => stripAnsi(line));
		const withoutLines = withoutHealth.render(120).map((line) => stripAnsi(line));

		assert.equal(withLines.length, withoutLines.length, "healthSummary flip must not change widget height");
		assert.match(withLines.join("\n"), /Health: all checks passing/);
		// The placeholder row is visually blank — no invented text.
		assert.equal((withoutLines[1] ?? "").trim(), "");
		assert.match(withoutLines.join("\n"), /ctrl\+shift\+d/, "workflow line still renders after the blank row");
	});

	test("small mode stays single-line regardless of healthSummary", () => {
		const widget = new GsdStatusWidget(() => ({
			override: "auto",
			activeToolCount: 0,
			cwd: "/tmp/project",
			manuallyExpanded: true,
			gsdProgress: {
				phase: "Executing T03 renderer polish",
				modeTag: "AUTO" as const,
				healthSummary: "Health: all checks passing",
				widgetMode: "small",
			},
		}));
		const plain = widget.render(120).map((line) => stripAnsi(line)).join("\n");
		assert.doesNotMatch(plain, /Health: all checks passing/);
		assert.equal(widget.render(120).length, 1);
	});

	test("head line has no model segment artifacts when none is dispatched", () => {
		const widget = new GsdStatusWidget(() => ({
			override: "auto",
			activeToolCount: 1,
			cwd: "/tmp/project",
			manuallyExpanded: false,
			gsdProgress: {
				phase: "Executing T03 renderer polish",
				modeTag: "AUTO",
				elapsed: "14m",
				eta: "~6m left",
				widgetMode: "small",
			},
		}));
		const plain = widget.render(120).map((line) => stripAnsi(line)).join("\n");
		assert.match(plain, /14m · ~6m left/);
		assert.doesNotMatch(plain, /·\s*·/, "no empty separator artifacts from a missing model");
		assert.doesNotMatch(plain, /·\s*14m/, "head-right should not start with an empty model segment");
	});

	test("annotates the dispatched model with the dynamic-routing tier (#2395)", () => {
		for (const dynamicRoutingTier of ["light", "standard", "heavy"] as const) {
			const widget = new GsdStatusWidget(() => ({
				override: "auto",
				activeToolCount: 1,
				cwd: "/tmp/project",
				manuallyExpanded: false,
				gsdProgress: {
					phase: "EXECUTE T03",
					modeTag: "AUTO",
					elapsed: "1m18s",
					model: "github-copilot/gpt-5.6-sol",
					dynamicRoutingTier,
					widgetMode: "small",
				},
			}));
			const head = stripAnsi(widget.render(120)[0] ?? "");
			assert.match(
				head,
				new RegExp(`github-copilot/gpt-5\\.6-sol \\(dynamic/${dynamicRoutingTier}\\)`),
				`tier ${dynamicRoutingTier} should render with the historical attribution label`,
			);
			assert.match(head, /\(dynamic\/[a-z]+\) · 1m18s/, "annotation precedes timing segments");
		}
	});

	test("omits the tier annotation when dynamicRoutingTier is undefined", () => {
		const widget = new GsdStatusWidget(() => ({
			override: "auto",
			activeToolCount: 1,
			cwd: "/tmp/project",
			manuallyExpanded: false,
			gsdProgress: {
				phase: "EXECUTE T03",
				modeTag: "AUTO",
				elapsed: "14m",
				model: "github-copilot/gpt-5.6-sol",
				widgetMode: "small",
			},
		}));
		const plain = widget.render(120).map((line) => stripAnsi(line)).join("\n");
		assert.match(plain, /github-copilot\/gpt-5\.6-sol · 14m/);
		assert.doesNotMatch(plain, /dynamic|dyn\//, "no tier annotation without a classification");
		assert.doesNotMatch(plain, /·\s*·/, "no dangling separator artifacts");
	});

	test("does not render a bare tier annotation without a model", () => {
		const widget = new GsdStatusWidget(() => ({
			override: "auto",
			activeToolCount: 1,
			cwd: "/tmp/project",
			manuallyExpanded: false,
			gsdProgress: {
				phase: "EXECUTE T03",
				modeTag: "AUTO",
				elapsed: "14m",
				dynamicRoutingTier: "heavy",
				widgetMode: "small",
			},
		}));
		const plain = widget.render(120).map((line) => stripAnsi(line)).join("\n");
		assert.doesNotMatch(plain, /dynamic|dyn\//, "tier is attached to the model segment only");
		assert.doesNotMatch(plain, /·\s*·/, "no dangling separator artifacts");
	});

	test("compacts the tier annotation before dropping it at constrained widths", () => {
		for (const [dynamicRoutingTier, initial] of [
			["light", "L"],
			["standard", "S"],
			["heavy", "H"],
		] as const) {
			const widget = new GsdStatusWidget(() => ({
				override: "auto",
				activeToolCount: 1,
				cwd: "/tmp/project",
				manuallyExpanded: false,
				gsdProgress: {
					phase: "EXECUTE T03",
					modeTag: "AUTO",
					model: "github-copilot/gpt-5.6-sol",
					dynamicRoutingTier,
					widgetMode: "small",
				},
			}));
			const head = stripAnsi(widget.render(60)[0] ?? "");
			assert.match(head, new RegExp(`\\(dyn/${initial}\\)`), `compact initial for ${dynamicRoutingTier}`);
			assert.doesNotMatch(head, new RegExp(`dynamic/${dynamicRoutingTier}`), "full form should have been compacted");
			for (const line of widget.render(60).map((line) => stripAnsi(line))) {
				assert.ok(line.length <= 60, `line exceeds width 60: ${line.length}`);
			}
		}
	});

	test("tier annotation is either complete or absent across boundary widths", () => {
		const widget = new GsdStatusWidget(() => ({
			override: "auto",
			activeToolCount: 1,
			cwd: "/tmp/project",
			manuallyExpanded: false,
			gsdProgress: {
				phase: "EXECUTE T03",
				modeTag: "AUTO",
				model: "github-copilot/gpt-5.6-sol",
				dynamicRoutingTier: "heavy",
				widgetMode: "small",
			},
		}));
		for (let width = 40; width <= 80; width++) {
			const head = stripAnsi(widget.render(width)[0] ?? "");
			const full = head.includes("(dynamic/heavy)");
			const compact = /\(dyn\/H\)/.test(head);
			assert.ok(
				(full ? 1 : 0) + (compact ? 1 : 0) <= 1,
				`width ${width}: only one annotation form expected — "${head}"`,
			);
			assert.doesNotMatch(
				head,
				/\((?:dyn|dynamic)[^)]*$/,
				`width ${width}: annotation must not be cut in half — "${head}"`,
			);
			assert.ok(head.length <= width, `width ${width}: head exceeds width — "${head}"`);
		}
	});

	test("keeps every rendered line within the terminal width with tier annotation", () => {
		const widget = new GsdStatusWidget(() => ({
			override: "auto",
			activeToolCount: 2,
			cwd: "/tmp/project",
			manuallyExpanded: true,
			gsdProgress: {
				phase: "Executing T03 renderer polish",
				modeTag: "AUTO",
				taskProgress: { done: 8, total: 14 },
				sliceProgress: { done: 2, total: 6 },
				unitLabel: "M001/S02/T03",
				elapsed: "1m18s",
				eta: "~6m left",
				model: "github-copilot/gpt-5.6-sol",
				dynamicRoutingTier: "standard",
				healthSummary: "Health: all checks passing",
				path: "/tmp/project",
				widgetMode: "full",
			},
		}));
		for (const width of [40, 60, 80, 120]) {
			const lines = widget.render(width).map((line) => stripAnsi(line));
			assert.ok(lines.length > 0);
			for (const line of lines) {
				assert.ok(line.length <= width, `line exceeds width ${width}: ${line.length} "${line}"`);
			}
		}
	});
});
