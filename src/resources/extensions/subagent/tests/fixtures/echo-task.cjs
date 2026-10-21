// Test fixture: emulates a minimal subagent child in --mode json. Emits one
// assistant message_end whose text echoes the task it was given, so chain
// {previous} handoff and per-child output can be asserted without a model.
// Spawned as the "subagent child" (via GSD_BIN_PATH) with the launch args:
//   node echo-task.cjs --mode json -p --no-session Task: <task>
"use strict";
const taskArg = process.argv.find((a) => a.startsWith("Task: ")) ?? "Task: (none)";
const task = taskArg.slice("Task: ".length);
process.stdout.write(
	`${JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: `echo:${task}` }],
			stopReason: "stop",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
		},
	})}\n`,
);
