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
});
