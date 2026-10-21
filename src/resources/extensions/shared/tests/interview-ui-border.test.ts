// gsd-pi — Shared interview UI dialog border contract

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@gsd/pi-tui";
import { initTheme } from "@gsd/pi-coding-agent";
import {
	showInterviewRound,
	showWrapUpScreen,
	type Question,
	type RoundResult,
	type WrapUpResult,
} from "../interview-ui.js";

const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ENTER = "\r";
const ESC = "\x1b";
const PAGE_DOWN = "\x1b[6~";
const PAGE_UP = "\x1b[5~";
const CTRL_U = "\x15";
const CTRL_D = "\x04";

/** KeybindingsManager with tui.select.pageUp/pageDown remapped to ctrl+u/ctrl+d. */
function remappedKb(): KeybindingsManager {
	return new KeybindingsManager(TUI_KEYBINDINGS, {
		"tui.select.pageUp": "ctrl+u",
		"tui.select.pageDown": "ctrl+d",
	});
}

before(() => { initTheme(); });

type RenderWidget = {
	render(width: number): string[];
	handleInput(input: string): void;
};

function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

function assertFullOuterBorder(lines: string[], width: number): void {
	assert.ok(lines.length >= 2, "dialog must include top and bottom borders");

	for (const [index, line] of lines.entries()) {
		assert.equal(visibleWidth(line), width, `line ${index} must fill dialog width`);
	}

	const top = stripAnsi(lines[0] ?? "");
	const bottom = stripAnsi(lines.at(-1) ?? "");
	assert.match(top, /^╭.*╮$/, `top border missing full corners: ${top}`);
	assert.match(bottom, /^╰.*╯$/, `bottom border missing full corners: ${bottom}`);

	for (let index = 1; index < lines.length - 1; index++) {
		const line = stripAnsi(lines[index] ?? "");
		assert.match(line, /^[│├]/, `line ${index} missing left border: ${line}`);
		assert.match(line, /[│┤]$/, `line ${index} missing right border: ${line}`);
	}
}

function mockTheme() {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		dim: (text: string) => text,
		italic: (text: string) => text,
		strikethrough: (text: string) => text,
		accent: (text: string) => text,
		success: (text: string) => text,
		warning: (text: string) => text,
		error: (text: string) => text,
		info: (text: string) => text,
		muted: (text: string) => text,
		dimmed: (text: string) => text,
	};
}

async function captureInterviewWidget(
	questions: Question[],
	kb: KeybindingsManager = new KeybindingsManager(TUI_KEYBINDINGS),
): Promise<RenderWidget> {
	let widget: RenderWidget | undefined;

	await showInterviewRound(questions, {}, {
		ui: {
			custom: (factory: any) => {
				widget = factory(
					{ requestRender: () => {} },
					mockTheme(),
					kb,
					(_result: RoundResult) => {},
				);
				return Promise.resolve({ endInterview: false, answers: {} });
			},
		},
	} as any);

	assert.ok(widget, "interview widget should be created");
	return widget;
}

async function captureWrapUpWidget(): Promise<RenderWidget> {
	let widget: RenderWidget | undefined;

	await showWrapUpScreen({
		headline: "Ready to wrap up?",
		progress: "4 questions answered",
		keepGoingLabel: "Keep going",
		satisfiedLabel: "I'm satisfied",
	}, {
		ui: {
			custom: (factory: any) => {
				widget = factory(
					{ requestRender: () => {} },
					mockTheme(),
					{},
					(_result: WrapUpResult) => {},
				);
				return Promise.resolve({ satisfied: false });
			},
		},
	} as any);

	assert.ok(widget, "wrap-up widget should be created");
	return widget;
}

describe("interview-ui dialog borders", () => {
	const questions: Question[] = [
		{
			id: "project_type",
			header: "Project Type",
			question: "What type of project?",
			options: [
				{ label: "Web App", description: "Frontend or full-stack" },
				{ label: "CLI Tool", description: "Command-line utility" },
			],
		},
	];

	it("renders the main question screen with a full border", async () => {
		const widget = await captureInterviewWidget(questions);
		assertFullOuterBorder(widget.render(80), 80);
	});

	it("renders the preview split screen with a full border", async () => {
		const widget = await captureInterviewWidget([{
			...questions[0],
			options: [
				{
					label: "Web App",
					description: "Frontend or full-stack",
					preview: "### Stack\n\nUse React with a typed API boundary.",
				},
			],
		}]);
		assertFullOuterBorder(widget.render(100), 100);
	});

	it("renders review and exit confirmation screens with full borders", async () => {
		const widget = await captureInterviewWidget(questions);

		widget.handleInput(ENTER);
		assertFullOuterBorder(widget.render(80), 80);

		const exitWidget = await captureInterviewWidget(questions);
		exitWidget.handleInput(ESC);
		assertFullOuterBorder(exitWidget.render(80), 80);
	});

	it("renders the wrap-up screen with a full border", async () => {
		const widget = await captureWrapUpWidget();
		assertFullOuterBorder(widget.render(80), 80);
	});

	it("makes an overflowing preview scrollable with PgUp/PgDn", async () => {
		const longPreview = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
		const widget = await captureInterviewWidget([{
			...questions[0],
			options: [
				{ label: "Web App", description: "Frontend or full-stack", preview: longPreview },
			],
		}]);

		// Initial render: content overflows, so a bottom "more" indicator and the
		// scroll hint are shown, and the border stays intact.
		const initial = stripAnsi(widget.render(100).join("\n"));
		assertFullOuterBorder(widget.render(100), 100);
		assert.match(initial, /▼ \d+ more/, "bottom scroll indicator should appear when preview overflows");
		assert.match(initial, /pageUp\/pageDown scroll preview/, "footer should hint at preview scrolling");
		assert.doesNotMatch(initial, /▲ \d+ more/, "top indicator should be absent before scrolling");

		// Scroll down: content below is now revealed and a top indicator appears.
		widget.handleInput(PAGE_DOWN);
		const scrolled = stripAnsi(widget.render(100).join("\n"));
		assertFullOuterBorder(widget.render(100), 100);
		assert.match(scrolled, /▲ \d+ more/, "top scroll indicator should appear after scrolling down");
		assert.ok(scrolled !== initial, "scrolling should change the rendered preview");

		// Scroll back up returns to the original view.
		widget.handleInput(PAGE_UP);
		const back = stripAnsi(widget.render(100).join("\n"));
		assert.doesNotMatch(back, /▲ \d+ more/, "top indicator should disappear after scrolling back to top");
	});

	it("makes overflowing side-by-side options scrollable with PgUp/PgDn", async () => {
		const overflowOptions = Array.from({ length: 8 }, (_, i) => ({
			label: `Overflow Option ${i + 1}`,
			description: `Detailed explanation for option ${i + 1} that is intentionally long enough to wrap in the options column and force vertical overflow.`,
			...(i === 0 ? { preview: "Short preview" } : {}),
		}));
		const widget = await captureInterviewWidget([{
			...questions[0],
			options: overflowOptions,
		}]);

		const initial = stripAnsi(widget.render(100).join("\n"));
		assertFullOuterBorder(widget.render(100), 100);
		assert.match(initial, /▼ \d+ more/, "bottom scroll indicator should appear when options overflow");
		assert.match(initial, /pageUp\/pageDown scroll options/, "footer should hint at options scrolling");
		assert.doesNotMatch(initial, /\+\d+ lines hidden/, "options overflow should not be a dead-end hidden-lines marker");
		assert.doesNotMatch(initial, /▲ \d+ more/, "top indicator should be absent before scrolling");

		widget.handleInput(PAGE_DOWN);
		const scrolled = stripAnsi(widget.render(100).join("\n"));
		assertFullOuterBorder(widget.render(100), 100);
		assert.match(scrolled, /▲ \d+ more/, "top scroll indicator should appear after scrolling down");
		assert.ok(scrolled !== initial, "scrolling should change the rendered options");

		widget.handleInput(PAGE_UP);
		const back = stripAnsi(widget.render(100).join("\n"));
		assert.doesNotMatch(back, /▲ \d+ more/, "top indicator should disappear after scrolling back to top");
	});

	it("scrolls with remapped tui.select.pageUp/pageDown bindings (#2885)", async () => {
		const longPreview = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
		const widget = await captureInterviewWidget([{
			...questions[0],
			options: [
				{ label: "Web App", description: "Frontend or full-stack", preview: longPreview },
			],
		}], remappedKb());

		const initial = stripAnsi(widget.render(100).join("\n"));

		// Remapped ctrl+d (not the raw pageDown key) scrolls the preview down.
		widget.handleInput(CTRL_D);
		const scrolled = stripAnsi(widget.render(100).join("\n"));
		assert.match(scrolled, /▲ \d+ more/, "remapped ctrl+d should scroll the preview down");
		assert.ok(scrolled !== initial, "remapped pageDown should change the rendered preview");

		// The raw pageDown key no longer matches once remapped away.
		widget.handleInput(PAGE_DOWN);
		const unchanged = stripAnsi(widget.render(100).join("\n"));
		assert.equal(unchanged, scrolled, "raw pageDown must not scroll after remapping to ctrl+d");

		// Remapped ctrl+u scrolls back up.
		widget.handleInput(CTRL_U);
		const back = stripAnsi(widget.render(100).join("\n"));
		assert.doesNotMatch(back, /▲ \d+ more/, "remapped ctrl+u should scroll back to the top");
	});

	it("scroll hints reflect the active page up/down bindings (#2885)", async () => {
		const longPreview = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
		const widget = await captureInterviewWidget([{
			...questions[0],
			options: [
				{ label: "Web App", description: "Frontend or full-stack", preview: longPreview },
			],
		}], remappedKb());

		const rendered = stripAnsi(widget.render(100).join("\n"));
		assert.match(rendered, /ctrl\+u\/ctrl\+d scroll preview/, "footer hint should show the remapped keys");
		assert.match(rendered, /▼ \d+ more · ctrl\+u\/ctrl\+d/, "scroll indicator should show the remapped keys");
		assert.doesNotMatch(rendered, /PgUp\/PgDn/, "hardcoded PgUp/PgDn hint must not appear");
	});
});
