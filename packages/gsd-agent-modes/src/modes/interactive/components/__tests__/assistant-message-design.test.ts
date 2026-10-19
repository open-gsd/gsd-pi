// Project/App: gsd-pi
// File Purpose: Visual contract tests for the assistant message plain surface (Variant A).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import stripAnsi from "strip-ansi";
import type { AssistantMessage } from "@gsd/pi-ai";
import { visibleWidth } from "@gsd/pi-tui";

import { initTheme, getMarkdownTheme } from "@gsd/pi-coding-agent/theme/theme.js";
import { AssistantMessageComponent, formatAssistantModelMeta } from "../assistant-message.js";
import { formatTimestamp } from "../timestamp.js";
import { renderPlainSpeakerMessage } from "../transcript-design.js";

initTheme("dark", false);

describe("AssistantMessageComponent plain surface", () => {
	test("renders assistant content with corner opener and unboxed body", () => {
		const message = {
			id: "m1",
			role: "assistant",
			provider: "test",
			model: "gpt-test",
			timestamp: 1,
			content: [{ type: "text", text: "I will update the renderer and run verification." }],
		} as unknown as AssistantMessage;

		const component = new AssistantMessageComponent(message, true);
		const plain = component.render(80).map((line) => stripAnsi(line));
		const joined = plain.join("\n");

		assert.match(joined, /GSD/);
		assert.match(joined, /gpt-test/);
		assert.match(joined, /update the renderer/);
		assert.match(joined, /╭─ GSD/);
		assert.doesNotMatch(joined, /╯/);
		assert.doesNotMatch(joined, /[│┃]/);
	});

	test("renderPlainSpeakerMessage matches component layout", () => {
		const plain = renderPlainSpeakerMessage(["Hey there"], 80, {
			label: "GSD",
			meta: "gpt-test",
			tone: "assistant",
		})
			.map((line) => stripAnsi(line))
			.join("\n");
		assert.match(plain, /GSD/);
		assert.match(plain, /Hey there/);
		assert.match(plain, /╭─ GSD/);
		assert.doesNotMatch(plain, /╯/);
	});

	test("renders metadata for a zero timestamp", () => {
		const message = {
			id: "m1",
			role: "assistant",
			provider: "test",
			model: "gpt-test",
			timestamp: 0,
			content: [{ type: "text", text: "ok" }],
		} as unknown as AssistantMessage;

		const component = new AssistantMessageComponent(message, true);
		component.setShowMetadata(true);
		const plain = component.render(80).map((line) => stripAnsi(line)).join("\n");
		// Compute the expected local-timezone date for the Unix epoch using the same
		// local-time arithmetic as isoDate() so the assertion passes regardless of
		// the machine's timezone (UTC shows 1970-01-01, UTC-1 shows 1969-12-31, etc.).
		const d = new Date(0);
		const expectedDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
		assert.match(plain, new RegExp(expectedDate));
	});
});

describe("assistant header model provenance (ADR-049)", () => {
	function makeAssistant(overrides: Record<string, unknown> = {}): AssistantMessage {
		return {
			role: "assistant",
			provider: "test",
			model: "gpt-5.6-luna",
			timestamp: 0,
			content: [{ type: "text", text: "ok" }],
			...overrides,
		} as unknown as AssistantMessage;
	}

	function renderPlain(message: AssistantMessage, width = 80): string[] {
		return new AssistantMessageComponent(message, true).render(width).map((line) => stripAnsi(line));
	}

	function headerLines(lines: string[]): string[] {
		return lines.filter((line) => line.includes("╭─ GSD"));
	}

	test("direct/legacy message renders the requested model only", () => {
		const lines = renderPlain(makeAssistant());
		assert.equal(headerLines(lines).length, 1);
		const header = headerLines(lines)[0];
		assert.match(header, /╭─ GSD · gpt-5\.6-luna · /);
		assert.doesNotMatch(header, /←/);
		assert.doesNotMatch(header, /dynamic/);
		assert.equal(header.split("gpt-5.6-luna").length - 1, 1);
	});

	test("differing responseModel shows effective model first with the requested model retained", () => {
		const meta = formatAssistantModelMeta(
			makeAssistant({ model: "openrouter/auto", responseModel: "anthropic/claude-opus-4.7" }),
		);
		assert.equal(meta, "anthropic/claude-opus-4.7 ← openrouter/auto");
		const header = headerLines(
			renderPlain(makeAssistant({ model: "openrouter/auto", responseModel: "anthropic/claude-opus-4.7" })),
		)[0];
		assert.match(header, /anthropic\/claude-opus-4\.7 ← openrouter\/auto/);
	});

	test("equal, empty, and missing responseModel render one model with no dangling separator", () => {
		for (const responseModel of ["gpt-5.6-luna", "", "   ", undefined]) {
			const lines = renderPlain(makeAssistant({ responseModel }));
			const header = headerLines(lines)[0];
			assert.doesNotMatch(header, /←/, `responseModel=${String(responseModel)}`);
			assert.match(header, /gpt-5\.6-luna · /, `responseModel=${String(responseModel)}`);
		}
	});

	test("gsd-dynamic light, standard, and heavy tiers are all rendered", () => {
		for (const tier of ["light", "standard", "heavy"] as const) {
			const lines = renderPlain(
				makeAssistant({ modelRouting: { source: "gsd-dynamic", tier, modelDowngraded: false } }),
			);
			const header = headerLines(lines)[0];
			assert.match(header, new RegExp(`\\(dynamic/${tier}\\)`), `tier=${tier}`);
		}
	});

	test("tier is shown regardless of modelDowngraded", () => {
		for (const modelDowngraded of [false, true]) {
			const lines = renderPlain(
				makeAssistant({ modelRouting: { source: "gsd-dynamic", tier: "light", modelDowngraded } }),
			);
			assert.match(headerLines(lines)[0], /\(dynamic\/light\)/, `modelDowngraded=${String(modelDowngraded)}`);
		}
	});

	test("provider-side and GSD routing render together and stay distinct", () => {
		const lines = renderPlain(
			makeAssistant({
				model: "openrouter/auto",
				responseModel: "anthropic/claude-opus-4.7",
				modelRouting: { source: "gsd-dynamic", tier: "heavy", modelDowngraded: true },
			}),
		);
		const header = headerLines(lines)[0];
		assert.match(header, /anthropic\/claude-opus-4\.7 ← openrouter\/auto \(dynamic\/heavy\)/);
	});

	test("provenance appears exactly once and only on the metadata-bearing segment", () => {
		const message = makeAssistant({
			model: "openrouter/auto",
			responseModel: "anthropic/claude-opus-4.7",
			modelRouting: { source: "gsd-dynamic", tier: "standard", modelDowngraded: false },
			content: [
				{ type: "thinking", thinking: "thinking text" },
				{ type: "text", text: "visible answer" },
			],
		}) as AssistantMessage;

		const ranged = new AssistantMessageComponent(message, false, getMarkdownTheme(), "date-time-iso", {
			startIndex: 0,
			endIndex: 0,
		});
		const thinkingPlain = ranged.render(80).map((line) => stripAnsi(line)).join("\n");
		assert.doesNotMatch(thinkingPlain, /dynamic\/standard/);
		// Non-final segments show the requested model alone while streaming.
		assert.match(thinkingPlain, /╭─ GSD · openrouter\/auto\s*\n/);
		assert.doesNotMatch(thinkingPlain, /anthropic\/claude-opus-4\.7/);

		ranged.setShowMetadata(true);
		const finalPlain = ranged.render(80).map((line) => stripAnsi(line)).join("\n");
		assert.equal(finalPlain.split("dynamic/standard").length - 1, 1);
	});

	test("error and aborted messages keep their body behavior and still show provenance", () => {
		const errorMessage = makeAssistant({
			stopReason: "error",
			errorMessage: "provider exploded",
			modelRouting: { source: "gsd-dynamic", tier: "light", modelDowngraded: false },
		});
		const errorLines = renderPlain(errorMessage);
		assert.match(errorLines.join("\n"), /Error: provider exploded/);
		assert.match(headerLines(errorLines)[0], /\(dynamic\/light\)/);

		const abortLines = renderPlain(makeAssistant({ stopReason: "aborted" }));
		assert.match(abortLines.join("\n"), /Operation aborted/);
		assert.match(headerLines(abortLines)[0], /gpt-5\.6-luna · /);
	});

	test("narrow widths drop the requested alias and timestamp before the dynamic tier; wide widths keep everything", () => {
		const message = makeAssistant({
			model: "openrouter/auto",
			responseModel: "anthropic/claude-opus-4.7",
			modelRouting: { source: "gsd-dynamic", tier: "heavy", modelDowngraded: false },
		});

		for (const width of [30, 60, 120, 200]) {
			const lines = renderPlain(message, width);
			assert.equal(headerLines(lines).length, 1, `width=${width}`);
			for (const line of lines) {
				assert.ok(visibleWidth(line) <= width, `width=${width} line too wide: ${line}`);
			}
		}

		const narrow = headerLines(renderPlain(message, 60))[0];
		assert.match(narrow, /\(dynamic\/heavy\)/, "tier must survive a constrained width");
		assert.doesNotMatch(narrow, /openrouter\/auto/, "requested alias drops before the tier");

		const wide = headerLines(renderPlain(message, 200))[0];
		assert.match(wide, /anthropic\/claude-opus-4\.7 ← openrouter\/auto \(dynamic\/heavy\)/);
		assert.ok(wide.includes(formatTimestamp(0, "date-time-iso")));
	});
});
