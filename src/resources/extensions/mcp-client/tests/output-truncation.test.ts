/**
 * Regression tests for #2967 — MCP output truncation must not reduce an
 * oversized single-line response to zero body bytes. Before the fix,
 * `truncateHead()`'s complete-line policy made `mcp_call` deliver only a
 * "[Output truncated: 0/1 lines (0B of ...)]" notice for such responses.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { formatMcpOutputText, utf8SafePrefix } from "../output-truncation.js";

const CAP = 50 * 1024; // DEFAULT_MAX_BYTES

test("below-cap single-line JSON passes through byte-identical", () => {
	const raw = JSON.stringify({ items: [{ id: 1, title: "ok" }] });
	const r = formatMcpOutputText(raw);
	assert.equal(r.text, raw);
	assert.equal(r.truncated, false);
	assert.equal(r.firstLineExceedsLimit, false);
	assert.equal(r.totalBytes, Buffer.byteLength(raw));
	assert.equal(r.outputBytes, r.totalBytes);
});

test("at-cap single line is delivered whole, untruncated", () => {
	const raw = "a".repeat(CAP);
	assert.equal(Buffer.byteLength(raw), CAP);
	const r = formatMcpOutputText(raw);
	assert.equal(r.text, raw);
	assert.equal(r.truncated, false);
	assert.equal(r.outputBytes, CAP);
});

test("above-cap single-line JSON delivers a nonzero labeled prefix, not zero bytes", () => {
	const raw = JSON.stringify({ items: [{ id: 1, body: "x".repeat(60 * 1024) }] });
	assert.ok(Buffer.byteLength(raw) > CAP);
	const r = formatMcpOutputText(raw);
	assert.equal(r.truncated, true);
	assert.equal(r.firstLineExceedsLimit, true);
	// Body bytes actually delivered: bounded, nonzero, smaller than the original.
	assert.ok(r.outputBytes > 0, "outputBytes must be nonzero");
	assert.ok(r.outputBytes <= CAP, "prefix must stay within the cap");
	assert.ok(r.outputBytes < r.totalBytes);
	// The prefix is the second line, right after the label line.
	const lines = r.text.split("\n");
	assert.equal(Buffer.byteLength(lines[1]), r.outputBytes);
	assert.ok(lines[1].startsWith('{"items":'), "prefix must start with the response body");
	// Clearly labeled as partial, not parseable complete JSON.
	assert.match(lines[0], /^\[Output truncated: 0\/1 lines/);
	assert.match(lines[0], /not parseable as complete JSON/);
	assert.match(lines[0], /partial prefix/);
});

test("just-over-cap single line keeps a 50.0KB prefix", () => {
	const raw = "a".repeat(CAP + 1);
	const r = formatMcpOutputText(raw);
	assert.equal(r.firstLineExceedsLimit, true);
	assert.equal(r.outputBytes, CAP);
	const label = r.text.split("\n")[0];
	assert.match(label, /single-line response of 50\.0KB exceeds the 50\.0KB cap/);
	assert.match(label, /showing the first 50\.0KB below as a partial prefix/);
	assert.equal(r.totalBytes, CAP + 1);
});

test("oversized first line of a multiline response also delivers a prefix", () => {
	const raw = "x".repeat(CAP + 10) + "\nsecond line\n" + "y".repeat(30 * 1024);
	const r = formatMcpOutputText(raw);
	assert.equal(r.truncated, true);
	assert.equal(r.firstLineExceedsLimit, true);
	assert.ok(r.outputBytes > 0 && r.outputBytes <= CAP);
	assert.ok(!r.text.includes("second line")); // only the prefix is delivered
	assert.match(r.text, /^\[Output truncated: 0\/3 lines/);
	// The label must not call the whole response a "single line": it reports
	// the first line's size and the response total separately.
	const label = r.text.split("\n")[0];
	assert.match(label, /first line of 50\.0KB \(response total 80\.0KB\) exceeds the 50\.0KB cap/);
});

test("multibyte Unicode prefix never splits a character", () => {
	// é (2B), 中 (3B), 🙂 (4B) — one giant single line over the cap. The 5-byte
	// ASCII header shifts the phase so the 51200-byte cut lands inside a
	// multi-byte character and the prefix must back off to the boundary.
	const raw = '{"":"' + "é中🙂".repeat(20 * 1024) + '"}';
	assert.ok(Buffer.byteLength(raw) > CAP);
	const r = formatMcpOutputText(raw);
	assert.equal(r.firstLineExceedsLimit, true);
	assert.ok(r.outputBytes > 0 && r.outputBytes < CAP); // strictly less: backoff happened
	assert.ok(!r.text.includes("\uFFFD"), "prefix must not contain replacement characters");
	assert.equal(Buffer.byteLength(utf8SafePrefix(raw, CAP)), r.outputBytes);
});

test("utf8SafePrefix: ASCII fills the cap exactly", () => {
	const s = "a".repeat(100);
	assert.equal(utf8SafePrefix(s, 40), "a".repeat(40));
	assert.equal(utf8SafePrefix(s, 100), s);
	assert.equal(utf8SafePrefix(s, 200), s);
});

test("utf8SafePrefix: backs off to a UTF-8 boundary", () => {
	const emoji = "🙂"; // 4 bytes
	const s = emoji.repeat(10); // 40 bytes
	// 41 and 42 land inside the second emoji; must back off to 40 bytes' worth.
	assert.equal(utf8SafePrefix(s, 41), emoji.repeat(10));
	assert.equal(utf8SafePrefix(s, 42), emoji.repeat(10));
	assert.equal(utf8SafePrefix(s, 39), emoji.repeat(9));
	assert.equal(Buffer.byteLength(utf8SafePrefix(s, 42)), 40);
});

test("utf8SafePrefix: every cut position inside 2/3/4-byte characters lands on a boundary", () => {
	const samples: Array<[string, string]> = [
		["é", "2-byte"], // 2 bytes
		["中", "3-byte"], // 3 bytes
		["🙂", "4-byte"], // 4 bytes
	];
	for (const [ch, name] of samples) {
		const charBytes = Buffer.byteLength(ch);
		const s = "abc" + ch.repeat(5);
		const total = Buffer.byteLength(s);
		for (let cap = 0; cap <= total + 2; cap++) {
			const p = utf8SafePrefix(s, cap);
			assert.ok(!p.includes("\uFFFD"), `${name} cap=${cap}: replacement char`);
			assert.ok(Buffer.byteLength(p) <= cap, `${name} cap=${cap}: over cap`);
			assert.ok(s.startsWith(p), `${name} cap=${cap}: not a prefix of input`);
			// Longest valid prefix: derive the expected cut independently.
			const expected =
				cap < 3
					? s.slice(0, cap)
					: "abc" + ch.repeat(Math.min(5, Math.floor((cap - 3) / charBytes)));
			assert.equal(p, expected, `${name} cap=${cap}: not the longest boundary-safe prefix`);
		}
	}
});

test("trailing newline at exactly the cap passes through untruncated", () => {
	const raw = "a".repeat(CAP - 1) + "\n";
	assert.equal(Buffer.byteLength(raw), CAP);
	const r = formatMcpOutputText(raw);
	assert.equal(r.text, raw);
	assert.equal(r.truncated, false);
});

test("first line of exactly the cap followed by a newline keeps the legacy path", () => {
	// 51200-byte first line is not > cap, so truncateHead keeps it complete
	// and truncates the (empty) remainder — not the prefix path.
	const raw = "a".repeat(CAP) + "\n";
	const r = formatMcpOutputText(raw);
	assert.equal(r.firstLineExceedsLimit, false);
	assert.equal(r.truncated, true);
	assert.equal(r.text, raw.slice(0, CAP) + "\n\n[Output truncated: 1/1 lines (50.0KB of 50.0KB)]");
});

test("multiline response below cap passes through byte-identical", () => {
	const raw = "line one\nline two\nline three";
	const r = formatMcpOutputText(raw);
	assert.equal(r.text, raw);
	assert.equal(r.truncated, false);
});

test("multiline response truncated by bytes keeps complete lines and the legacy notice", () => {
	// 600 lines x 100 bytes (+599 newlines) = 60599B > 50KiB: truncated by bytes.
	const line = "a".repeat(100);
	const raw = Array.from({ length: 600 }, () => line).join("\n");
	const r = formatMcpOutputText(raw);

	// Independently re-derive the greedy complete-line selection.
	const allLines = raw.split("\n");
	const kept: string[] = [];
	let bytes = 0;
	for (let i = 0; i < allLines.length; i++) {
		const lineBytes = 100 + (i > 0 ? 1 : 0);
		if (bytes + lineBytes > CAP) break;
		kept.push(line);
		bytes += lineBytes;
	}
	const expectedBody = kept.join("\n");
	const kb = (n: number) => (n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}KB`);

	assert.equal(r.truncated, true);
	assert.equal(r.firstLineExceedsLimit, false);
	assert.equal(r.text, expectedBody + `\n\n[Output truncated: ${kept.length}/600 lines (${kb(Buffer.byteLength(expectedBody))} of ${kb(Buffer.byteLength(raw))})]`);
	assert.equal(r.outputBytes, Buffer.byteLength(expectedBody));
});

test("multiline truncated by the line limit uses the legacy notice too", () => {
	// Many tiny lines: the 2000-line limit hits before the byte cap.
	const raw = Array.from({ length: 2500 }, (_, i) => `l${i}`).join("\n");
	const r = formatMcpOutputText(raw);
	assert.equal(r.truncated, true);
	assert.match(r.text, /\n\n\[Output truncated: 2000\/2500 lines \([0-9.]+KB of [0-9.]+KB\)\]$/);
});

test("custom notice label (mcp_discover uses 'Truncated')", () => {
	const raw = Array.from({ length: 2500 }, (_, i) => `l${i}`).join("\n");
	const r = formatMcpOutputText(raw, "Truncated");
	assert.match(r.text, /\n\n\[Truncated: 2000\/2500 lines /);

	const big = "x".repeat(CAP + 1);
	const p = formatMcpOutputText(big, "Truncated");
	assert.match(p.text, /^\[Truncated: 0\/1 lines/);
	assert.equal(p.outputBytes, CAP);
});
