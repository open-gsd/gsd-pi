import assert from "node:assert/strict";
import { test } from "node:test";

import { GSD_COMMAND_DESCRIPTION, getGsdArgumentCompletions, TOP_LEVEL_SUBCOMMANDS } from "../commands/catalog.ts";

test("blocker completion exposes read-only inspection and human clear-only resolution", () => {
  assert.ok(TOP_LEVEL_SUBCOMMANDS.some((command) => command.cmd === "blocker"));
  assert.match(GSD_COMMAND_DESCRIPTION, /\|blocker\|/);
  assert.deepEqual(
    getGsdArgumentCompletions("blocker ").map((completion) => completion.label),
    ["inspect", "resolve"],
  );
});

test("quick command completion surfaces every right-sizing flag", () => {
  const labels = getGsdArgumentCompletions("quick ").map((completion) => completion.label);

  assert.deepEqual(labels, ["--discuss", "--research", "--validate", "--full"]);
});

test("planner is not part of the /gsd command surface", () => {
  assert.doesNotMatch(GSD_COMMAND_DESCRIPTION, /\|planner(?:\||$)/);
  assert.equal(
    TOP_LEVEL_SUBCOMMANDS.some((command) => command.cmd === "planner"),
    false,
    "planner should not appear in top-level commands",
  );

  const completions = getGsdArgumentCompletions("pla");

  assert.equal(
    completions.some((completion) => completion.value === "planner"),
    false,
    "planner should not appear in top-level completions",
  );

  assert.deepEqual(
    getGsdArgumentCompletions("planner --"),
    [],
    "planner should not expose nested completions",
  );
});
