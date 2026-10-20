// Project/App: gsd-pi
// File Purpose: Load the actual debug module; duplicate imported bindings fail before the assertions.
import assert from "node:assert/strict";
import test from "node:test";
import { parseDebugCommand } from "../commands-debug.ts";

test("debug module loads with one runtime auto-state binding and preserves pure command routing", () => {
  assert.deepEqual(parseDebugCommand("list"), { type: "list" });
  assert.deepEqual(parseDebugCommand("status integration-smoke"), { type: "status", slug: "integration-smoke" });
});
