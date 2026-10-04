import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { importFileBacklogItems, loadBacklogItems, unimportedFileBacklogItems } from "../backlog.ts";
import { handleBacklog } from "../commands-backlog.ts";
import { checkEngineHealth } from "../doctor-engine-checks.ts";
import type { DoctorIssue } from "../doctor-types.ts";
import { _getAdapter, closeDatabase, getAllMilestones, isDbAvailable } from "../gsd-db.ts";
import { clearReservedMilestoneIds, getReservedMilestoneIds, reserveMilestoneId } from "../milestone-ids.ts";
import { invalidateStateCache } from "../state.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeTmpBase(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-backlog-test-")));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  if (isDbAvailable()) closeDatabase();
  invalidateStateCache();
  try { rmSync(base, { recursive: true, force: true }); } catch { /* */ }
}

function operations(type: string): number {
  const row = _getAdapter()!.prepare(
    "SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = :type",
  ).get({ ":type": type });
  return Number(row?.["count"]);
}

/** Write a BACKLOG.md from an older release and import its items, as `/gsd doctor --fix` does. */
async function seedBacklog(base: string, content: string): Promise<void> {
  writeBacklog(base, content);
  await runBacklog("");
  importFileBacklogItems(base, unimportedFileBacklogItems(base));
}

function backlogPath(base: string): string {
  return join(base, ".gsd", "BACKLOG.md");
}

function writeBacklog(base: string, content: string): void {
  writeFileSync(backlogPath(base), content, "utf-8");
}

function readBacklog(base: string): string {
  return readFileSync(backlogPath(base), "utf-8");
}

// ─── Tests ──────────────────────────────────────────────────────────────

test("backlog list shows database items with status and notes", async (t) => {
  const base = makeTmpBase();
  enterBacklogDir(t, base);
  t.after(() => cleanup(base));
  await seedBacklog(base, [
    "# Backlog",
    "",
    "- [ ] 999.1 — OAuth support (added 2026-03-23)",
    "- [x] 999.2 — Rate limiting (promoted 2026-03-24)",
    "- [ ] 999.3 — Dark mode",
    "",
  ].join("\n"));
  rmSync(backlogPath(base));

  const notifications = await runBacklog("");

  const listing = notifications.at(-1)!;
  assert.ok(listing.includes("  ○ 999.1 — OAuth support (added 2026-03-23)"));
  assert.ok(listing.includes("  ✓ 999.2 — Rate limiting (promoted 2026-03-24)"));
  assert.ok(listing.includes("  ○ 999.3 — Dark mode"));
  assert.ok(listing.includes("2 pending, 1 promoted/done"));
});

test("a BACKLOG.md item the database does not hold is not listed; doctor reports it and imports it on --fix", async (t) => {
  const base = makeTmpBase();
  enterBacklogDir(t, base);
  t.after(() => cleanup(base));
  const file = [
    "# Backlog",
    "",
    "- [ ] 999.1 — OAuth support (added 2026-03-23)",
    "  - needs provider config",
    "",
  ].join("\n");
  writeBacklog(base, file);

  const listing = (await runBacklog("")).join("\n");
  assert.match(listing, /Backlog is empty/);
  assert.match(listing, /1 item\(s\) in BACKLOG\.md are not in the database\. Run \/gsd doctor --fix/);
  assert.match((await runBacklog("promote 999.1")).join("\n"), /not found/);
  assert.deepEqual(getAllMilestones(), [], "a file item cannot be promoted");

  const backlogIssues = async (options: { repair?: boolean; importFileOverrides?: boolean }, fixes: string[] = []) => {
    const issues: DoctorIssue[] = [];
    await checkEngineHealth(base, issues, fixes, options);
    return issues.filter((issue) => issue.code === "backlog_file_item_unimported");
  };
  const issues = await backlogIssues({ repair: true });
  assert.deepEqual(issues.map((issue) => [issue.severity, issue.fixable]), [["warning", true]]);
  assert.match(issues[0]!.message, /BACKLOG\.md item 999\.1 \("OAuth support"\) is not in the database/);
  assert.equal(operations("backlog.import"), 0, "a repair the operator did not ask for imports nothing");

  const fixes: string[] = [];
  assert.deepEqual(await backlogIssues({ repair: true, importFileOverrides: true }, fixes), []);
  assert.match(fixes.join("\n"), /imported 1 row\(s\) from BACKLOG\.md: 999\.1/);
  assert.equal(operations("backlog.import"), 1);
  assert.deepEqual(loadBacklogItems(), [{ id: "999.1", title: "OAuth support", done: false, note: "added 2026-03-23" }]);
  assert.equal(readBacklog(base), file, "the import does not change the file");
});

test("backlog promote creates a queued milestone and works with BACKLOG.md deleted", async (t) => {
  const base = makeTmpBase();
  enterBacklogDir(t, base);
  t.after(() => cleanup(base));

  await runBacklog("add OAuth support");
  assert.equal(operations("backlog.add"), 1);
  rmSync(backlogPath(base));

  const notifications = await runBacklog("promote 999.1");

  assert.deepEqual(
    getAllMilestones().map((milestone) => [milestone.id, milestone.title, milestone.status]),
    [["M001", "OAuth support", "queued"]],
  );
  assert.equal(operations("milestone.register"), 1);
  assert.equal(operations("backlog.promote"), 1);
  assert.match(notifications.join("\n"), /queued as milestone M001/);
  assert.deepEqual(loadBacklogItems().map((item) => [item.id, item.done]), [["999.1", true]]);
  assert.match(readBacklog(base), /^- \[x\] 999\.1 — OAuth support \(promoted \d{4}-\d{2}-\d{2} as M001\)$/m);

  assert.match((await runBacklog("promote 999.1")).join("\n"), /already promoted/);
  assert.equal(getAllMilestones().length, 1, "a second promote registers no second milestone");
});

test("backlog promote allocates its own milestone id and leaves another flow's reservation", async (t) => {
  const base = makeTmpBase();
  enterBacklogDir(t, base);
  t.after(() => cleanup(base));
  t.after(clearReservedMilestoneIds);
  await runBacklog("add OAuth support");
  // A new-milestone discussion in this process showed M001 to the user and has not registered it yet.
  reserveMilestoneId("M001");

  const notifications = await runBacklog("promote 999.1");

  assert.deepEqual(getAllMilestones().map((milestone) => milestone.id), ["M002"]);
  assert.match(notifications.join("\n"), /queued as milestone M002/);
  assert.deepEqual([...getReservedMilestoneIds()], ["M001"], "the discussion keeps its id and the promoted id is not left reserved");
});

test("ticking a BACKLOG.md checkbox by hand does not promote the item", async (t) => {
  const base = makeTmpBase();
  enterBacklogDir(t, base);
  t.after(() => cleanup(base));
  await runBacklog("add OAuth support");
  writeBacklog(base, readBacklog(base).replace("- [ ] 999.1", "- [x] 999.1"));

  assert.deepEqual(loadBacklogItems().map((item) => item.done), [false]);
  assert.deepEqual(getAllMilestones(), []);
  await runBacklog("add Dark mode");
  assert.match(readBacklog(base), /^- \[ \] 999\.1 — OAuth support/m, "the next render restores the database state");
});

test("backlog list on a missing file reports empty", async (t) => {
  const base = makeTmpBase();
  enterBacklogDir(t, base);
  t.after(() => cleanup(base));
  assert.ok(!existsSync(backlogPath(base)));

  const notifications = await runBacklog("");

  assert.match(notifications.join("\n"), /Backlog is empty/);
});

// ─── Handler tests — lossless BACKLOG.md edits (issue #2446) ─────────────

function enterBacklogDir(t: { after: (fn: () => void) => void }, base: string): void {
  const originalCwd = process.cwd();
  t.after(() => process.chdir(originalCwd));
  process.chdir(base);
}

async function runBacklog(args: string): Promise<string[]> {
  const notifications: string[] = [];
  const ctx = {
    ui: { notify: (message: string) => notifications.push(message) },
  } as any;
  await handleBacklog(args, ctx, {} as any);
  return notifications;
}

test("backlog add preserves multi-line notes and appends new item", async (t) => {
  const base = makeTmpBase();
  enterBacklogDir(t, base);
  t.after(() => cleanup(base));
  const fixture = [
    "# Backlog",
    "",
    "- [ ] 999.1 — OAuth support (added 2026-03-23)",
    "  - needs provider config",
    "  - see issue #42",
    "    - nested detail",
    "",
    "- [ ] 999.2 — Rate limiting (added 2026-03-24)",
  ];
  await seedBacklog(base, [...fixture, ""].join("\n"));

  await runBacklog("add Dark mode");

  // Exact file content — every fixture line verbatim, new item inserted before the trailing newline
  const date = new Date().toISOString().slice(0, 10);
  const newItem = `- [ ] 999.3 — Dark mode (added ${date})`;
  assert.equal(readBacklog(base), [...fixture, newItem, ""].join("\n"));
});

test("backlog remove deletes only the target item and its continuation lines", async (t) => {
  const base = makeTmpBase();
  enterBacklogDir(t, base);
  t.after(() => cleanup(base));
  await seedBacklog(base, [
    "# Backlog",
    "",
    "Free text the user wrote.",
    "",
    "- [ ] 999.1 — OAuth support (added 2026-03-23)",
    "  - note one",
    "  - note two",
    "",
    "- [ ] 999.2 — Rate limiting (added 2026-03-24)",
    "  - keep these notes",
    "",
    "---",
    "",
  ].join("\n"));

  await runBacklog("remove 999.1");

  const after = readBacklog(base);
  assert.ok(!after.includes("OAuth support"));
  assert.ok(!after.includes("note one"));
  assert.ok(!after.includes("note two"));
  for (const line of [
    "Free text the user wrote.",
    "- [ ] 999.2 — Rate limiting (added 2026-03-24)",
    "  - keep these notes",
    "---",
  ]) {
    assert.ok(after.includes(line), `lost line: ${line}`);
  }
});

test("backlog promote flips only the target header line", async (t) => {
  const base = makeTmpBase();
  enterBacklogDir(t, base);
  t.after(() => cleanup(base));
  const before = [
    "# Backlog",
    "",
    "- [ ] 999.1 — OAuth support (added 2026-03-23)",
    "  - notes survive",
    "",
    "- [ ] 999.2 — Rate limiting (added 2026-03-24)",
    "",
  ].join("\n");
  await seedBacklog(base, before);
  const beforeLines = before.split("\n");

  await runBacklog("promote 999.1");

  const afterLines = readBacklog(base).split("\n");
  assert.equal(afterLines.length, beforeLines.length);
  assert.match(afterLines[2], /^- \[x\] 999\.1 — OAuth support \(promoted \d{4}-\d{2}-\d{2} as M001\)$/);
  for (let i = 0; i < beforeLines.length; i++) {
    if (i === 2) continue;
    assert.equal(afterLines[i], beforeLines[i], `line ${i} changed`);
  }
});

test("backlog keeps hyphen-dash header lines verbatim across add, promote, and remove", async (t) => {
  const base = makeTmpBase();
  enterBacklogDir(t, base);
  t.after(() => cleanup(base));
  const hyphenLine = "- [ ] 999.1 - Legacy entry with hyphen dash";
  await seedBacklog(base, [
    "# Backlog",
    "",
    hyphenLine,
    "",
    "- [ ] 999.2 — Rate limiting (added 2026-03-24)",
    "",
  ].join("\n"));

  await runBacklog("add Dark mode");
  assert.ok(readBacklog(base).includes(hyphenLine), "hyphen header lost on add");

  await runBacklog("promote 999.2");
  assert.ok(readBacklog(base).includes(hyphenLine), "hyphen header lost on promote");

  await runBacklog("remove 999.2");
  const after = readBacklog(base);
  assert.ok(after.includes(hyphenLine), "hyphen header lost on remove");
  assert.ok(!after.includes("Rate limiting"));
  assert.ok(after.includes("999.3 — Dark mode"));
});

test("backlog add on missing file creates header and item", async (t) => {
  const base = makeTmpBase();
  enterBacklogDir(t, base);
  t.after(() => cleanup(base));
  assert.ok(!existsSync(backlogPath(base)));

  await runBacklog("add Dark mode");

  const content = readBacklog(base);
  assert.ok(content.startsWith("# Backlog"));
  assert.match(content, /- \[ \] 999\.1 — Dark mode \(added \d{4}-\d{2}-\d{2}\)/);
});

test("backlog remove unknown id warns and leaves file untouched", async (t) => {
  const base = makeTmpBase();
  enterBacklogDir(t, base);
  t.after(() => cleanup(base));
  const before = [
    "# Backlog",
    "",
    "- [ ] 999.1 — OAuth support (added 2026-03-23)",
    "",
  ].join("\n");
  await seedBacklog(base, before);

  const notifications = await runBacklog("remove 999.9");

  assert.equal(readBacklog(base), before);
  assert.match(notifications.join("\n"), /not found/);
});

test("backlog remove stops before a non-indented hyphen-dash entry and its notes", async (t) => {
  const base = makeTmpBase();
  enterBacklogDir(t, base);
  t.after(() => cleanup(base));
  const hyphenLine = "- [ ] 999.2 - Legacy hyphen entry";
  await seedBacklog(base, [
    "# Backlog",
    "",
    "- [ ] 999.1 — OAuth support (added 2026-03-23)",
    "  - note one",
    hyphenLine,
    "  - keep these notes",
    "",
  ].join("\n"));

  await runBacklog("remove 999.1");

  const after = readBacklog(base);
  assert.ok(!after.includes("OAuth support"));
  assert.ok(!after.includes("note one"));
  assert.ok(after.includes(hyphenLine), "hyphen entry deleted as continuation");
  assert.ok(after.includes("  - keep these notes"), "hyphen entry notes deleted as continuation");
});

test("backlog remove of the last item keeps trailing separator and footer text", async (t) => {
  const base = makeTmpBase();
  enterBacklogDir(t, base);
  t.after(() => cleanup(base));
  await seedBacklog(base, [
    "# Backlog",
    "",
    "- [ ] 999.1 — OAuth support (added 2026-03-23)",
    "  - notes",
    "",
    "---",
    "Footer text written by the user.",
    "",
  ].join("\n"));

  await runBacklog("remove 999.1");

  const after = readBacklog(base);
  assert.ok(!after.includes("OAuth support"));
  assert.ok(!after.includes("  - notes"));
  assert.ok(after.includes("---"), "separator deleted as continuation");
  assert.ok(after.includes("Footer text written by the user."), "footer deleted as continuation");
  assert.ok(after.endsWith("\n"), "trailing newline lost");
});

test("backlog add does not reuse an id visible on a nonconforming line", async (t) => {
  const base = makeTmpBase();
  enterBacklogDir(t, base);
  t.after(() => cleanup(base));
  await seedBacklog(base, [
    "# Backlog",
    "",
    "- [ ] 999.1 - Legacy hyphen entry",
    "",
  ].join("\n"));

  await runBacklog("add Dark mode");

  const after = readBacklog(base);
  assert.match(after, /^- \[ \] 999\.2 — Dark mode \(added \d{4}-\d{2}-\d{2}\)$/m);
  assert.equal(after.split("999.1").length - 1, 1, "duplicate 999.1 written");
});
