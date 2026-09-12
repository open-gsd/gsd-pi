// Project/App: gsd-pi
// File Purpose: formatMarkdownSelfHealNotification must surface quarantined
// pre-rebuild bytes, not just a bare "rebuilt N" message. Regression: the
// auto-rebuild self-heal path previously never mentioned that
// rebuildMarkdownProjectionsFromDb had already quarantined externally-edited
// (often richer, hand-authored) content before overwriting it with the DB's
// sparser rendered version -- a user could lose track of the original bytes
// with no visible pointer to where they went.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { formatMarkdownSelfHealNotification } from "../guided-flow.ts";

describe("formatMarkdownSelfHealNotification", () => {
  test("plain rebuild with nothing quarantined reports info with no quarantine note", () => {
    const { message, level } = formatMarkdownSelfHealNotification({
      rendered: 12,
      errors: [],
      quarantined: 0,
      quarantinedPaths: [],
    });
    assert.equal(level, "info");
    assert.match(message, /Self-heal: rebuilt markdown projections from the authoritative DB \(12 rendered\)\./);
    assert.doesNotMatch(message, /quarantine/i);
  });

  test("quarantined files escalate to warning and list their preserved paths", () => {
    const { message, level } = formatMarkdownSelfHealNotification({
      rendered: 90,
      errors: [],
      quarantined: 90,
      quarantinedPaths: [
        ".gsd/quarantine/projections/x/gsd/phases/01/01-01-PLAN.md",
        ".gsd/quarantine/projections/x/gsd/phases/02/02-01-PLAN.md",
      ],
    });
    assert.equal(level, "warning");
    assert.match(message, /90 file\(s\) had content that differed/);
    assert.match(message, /the pre-rebuild bytes were preserved, not discarded/);
    assert.match(message, /01-01-PLAN\.md/);
    assert.match(message, /02-01-PLAN\.md/);
    assert.match(message, /DB row may be sparser than what was quarantined/);
  });

  test("quarantined path list is capped and reports an overflow count", () => {
    const paths = Array.from({ length: 8 }, (_, i) => `.gsd/quarantine/projections/x/file-${i}.md`);
    const { message } = formatMarkdownSelfHealNotification({
      rendered: 8,
      errors: [],
      quarantined: 8,
      quarantinedPaths: paths,
    });
    assert.match(message, /file-0\.md/);
    assert.match(message, /file-4\.md/);
    assert.doesNotMatch(message, /file-5\.md/);
    assert.match(message, /…and 3 more/);
  });

  test("render errors also escalate to warning even with nothing quarantined", () => {
    const { message, level } = formatMarkdownSelfHealNotification({
      rendered: 5,
      errors: ["boom"],
      quarantined: 0,
      quarantinedPaths: [],
    });
    assert.equal(level, "warning");
    assert.match(message, /5 rendered, 1 error\(s\)/);
  });
});
