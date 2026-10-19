// Test fixture: emulates the #2364 death scenario. Spawned as the "subagent
// child" (via GSD_BIN_PATH). It creates a grandchild that inherits (holds)
// this process's stdout pipe, then SIGKILLs itself — so the parent's `close`
// event stays pending until the grandchild exits while `exit` fires early.
"use strict";
const { spawn } = require("node:child_process");

const grandchildLifetimeMs = Number(process.env.FIXTURE_GRANDCHILD_LIFETIME_MS || 8000);
spawn(
	process.execPath,
	["-e", `setTimeout(() => {}, ${grandchildLifetimeMs})`],
	{ stdio: ["ignore", "inherit", "inherit"] },
).unref();

setTimeout(() => process.kill(process.pid, "SIGKILL"), 150);
