// gsd-pi — Regression test for #2212 defect B (dismissal mechanism)
//
// When an auto-mode unit is abandoned while an ask_user_questions round is
// still pending, the hosting turn must be aborted. The dismissal path is the
// tool's abort signal: showInterviewRound registers an abort listener that
// finishes the round (done()), which unmounts the TUI dialog and restores
// transcript key bindings. This pins that mechanism: an abort while the round
// is pending resolves the dialog exactly once with an interrupted result.
//
// The wiring under test (unit-abandon → ctx.abort) is covered in
// gsd/tests/auto-orchestrator.test.ts.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@gsd/pi-tui";
import { showInterviewRound, type Question, type RoundResult } from "../interview-ui.js";

const ENTER = "\r";

describe("interview-ui abort dismissal (#2212)", () => {
	it("dismisses a pending round exactly once when the abort signal fires", async () => {
		const controller = new AbortController();
		const doneCalls: RoundResult[] = [];
		let widget: { handleInput(input: string): void } | undefined;

		const questions: Question[] = [
			{
				id: "route",
				header: "Route",
				question: "Which route?",
				options: [
					{ label: "Web App", description: "A web app" },
					{ label: "CLI Tool", description: "A CLI tool" },
				],
			},
		];

		const resultPromise = showInterviewRound(questions, { signal: controller.signal }, {
			ui: {
				custom: (factory: any) => new Promise<RoundResult>((resolve) => {
					const mockTui = { requestRender: () => {} };
					const mockTheme = {
						fg: (_c: string, t: string) => t,
						bold: (t: string) => t,
						dim: (t: string) => t,
						italic: (t: string) => t,
						strikethrough: (t: string) => t,
						accent: (t: string) => t,
						success: (t: string) => t,
						warning: (t: string) => t,
						error: (t: string) => t,
						info: (t: string) => t,
						muted: (t: string) => t,
						dimmed: (t: string) => t,
					};
					widget = factory(mockTui, mockTheme, new KeybindingsManager(TUI_KEYBINDINGS), (result: RoundResult) => {
						doneCalls.push(result);
						resolve(result);
					});
				}),
			},
		} as any);

		assert.ok(widget, "widget should be created synchronously");
		// Dialog is mounted and pending (no answer submitted yet).
		widget.handleInput(ENTER);

		controller.abort();

		const result = await resultPromise;
		assert.equal(doneCalls.length, 1, "abort while pending must finish the round exactly once (dialog unmounts)");
		assert.deepEqual(result, { endInterview: false, answers: {}, interrupted: true });
	});
});
