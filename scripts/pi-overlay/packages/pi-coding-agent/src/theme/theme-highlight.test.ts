// Project/App: gsd-pi
// File Purpose: Tests for safe terminal syntax highlighting fallback.

import test from "node:test";
import assert from "node:assert/strict";
import stripAnsi from "strip-ansi";

import { highlightCode, initTheme } from "./theme.js";

initTheme("dark", false);

test("highlightCode applies lightweight syntax colors when native highlighting is disabled", () => {
	const [line] = highlightCode("const answer = 42 // meaning", "typescript");

	assert.ok(line.includes("\x1b["), "expected ANSI color output");
	assert.equal(stripAnsi(line), "const answer = 42 // meaning");
});

test("highlightCode keeps plain text unstyled when no language is known", () => {
	const [line] = highlightCode("const answer = 42");

	assert.equal(line, "const answer = 42");
});

// The lightweight highlighter classifies identifier / number characters with
// charCode comparisons (formerly per-char RegExp.test). These guard that the
// charCode classes stay byte-identical in observable behaviour: every character
// must survive untouched (the highlighter only adds ANSI, never alters content),
// and token types must still be coloured distinctly.

test("highlightCode preserves content exactly across a mixed corpus", () => {
	const corpus = [
		"export async function f(x) { return x + 1; } // trailing comment",
		"const n = 3.14_15; let hex = 255; var s = 'a\\'b'; # hash comment",
		"if (a === b && c !== d) { throw new Error(`templated`); }",
		"\u8b58\u5225\u5b50 mixed with ascii_ident and \u6570\u5b57 42 and emoji \ud83d\ude80 end",
		"\tindented\twith\ttabs   and   trailing spaces   ",
		"_underscore $dollar a1b2 0_9 done",
	];
	for (const line of corpus) {
		const out = highlightCode(line, "typescript").join("\n");
		assert.equal(stripAnsi(out), line, `content must be preserved verbatim for: ${JSON.stringify(line)}`);
	}
});

test("highlightCode colours numbers, strings and comments but leaves bare identifiers plain", () => {
	const colourful = (src: string) => {
		const [line] = highlightCode(src, "typescript");
		assert.ok(line.includes("\x1b["), `expected ANSI colouring for: ${src}`);
		assert.equal(stripAnsi(line), src, `content preserved for: ${src}`);
	};
	colourful("x = 42");
	colourful('s = "hello"');
	colourful("v = 3.14_15");
	colourful("a // line comment");
	colourful("b # hash comment");

	// A line of bare identifiers and spaces has no keywords/numbers/strings/comments,
	// so the highlighter adds no ANSI at all.
	const [plain] = highlightCode("foo bar baz qux", "typescript");
	assert.equal(plain, "foo bar baz qux", "bare identifiers must stay unstyled");
});
