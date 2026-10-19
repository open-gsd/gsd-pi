// Test fixture: emulates a subagent child that reports provider usage per turn
// (#2821). Spawned as the "subagent child" (via GSD_BIN_PATH). Emits two
// assistant `message_end` events whose usage accumulates (0.01 then +0.02
// cost), then exits with the status named by FIXTURE_EXIT_CODE so callers can
// exercise failed-children-keep-their-usage. With FIXTURE_FAIL_ONCE_DIR set,
// the first invocation writes a marker there and exits 1 after reporting, and
// later invocations succeed — driving the parallel auto-retry path.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const exitCode = Number(process.env.FIXTURE_EXIT_CODE || 0);
const failOnceDir = process.env.FIXTURE_FAIL_ONCE_DIR;
let effectiveExitCode = exitCode;
if (failOnceDir) {
	const marker = path.join(failOnceDir, "failed-once");
	if (!fs.existsSync(marker)) {
		fs.writeFileSync(marker, "1");
		effectiveExitCode = 1;
	} else {
		effectiveExitCode = 0;
	}
}

const turn = (text, costTotal, turnTokens) => JSON.stringify({
	type: "message_end",
	message: {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: { total: costTotal }, totalTokens: turnTokens },
		model: "test-model",
		stopReason: "stop",
	},
});

process.stdout.write(`${turn("working", 0.01, 165)}\n`);
setTimeout(() => {
	process.stdout.write(`${turn("final answer", 0.02, 330)}\n`);
	setTimeout(() => process.exit(effectiveExitCode), 50);
}, 50);
