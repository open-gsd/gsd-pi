import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { handleBacklog } from "../commands-backlog.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeTmpBase(): string {
  const base = join(tmpdir(), `gsd-backlog-test-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* */ }
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

test("backlog list shows parsed items with status and notes", async (t) => {
  const base = makeTmpBase();
  enterBacklogDir(t, base);
  t.after(() => cleanup(base));
  writeBacklog(base, [
    "# Backlog",
    "",
    "- [ ] 999.1 — OAuth support (added 2026-03-23)",
    "- [x] 999.2 — Rate limiting (promoted 2026-03-24)",
    "- [ ] 999.3 — Dark mode",
    "",
  ].join("\n"));

  const notifications = await runBacklog("");

  const listing = notifications.join("\n");
  assert.ok(listing.includes("  ○ 999.1 — OAuth support (added 2026-03-23)"));
  assert.ok(listing.includes("  ✓ 999.2 — Rate limiting (promoted 2026-03-24)"));
  assert.ok(listing.includes("  ○ 999.3 — Dark mode"));
  assert.ok(listing.includes("2 pending, 1 promoted/done"));
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
  writeBacklog(base, [...fixture, ""].join("\n"));

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
  writeBacklog(base, [
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
  writeBacklog(base, before);
  const beforeLines = before.split("\n");

  await runBacklog("promote 999.1");

  const afterLines = readBacklog(base).split("\n");
  assert.equal(afterLines.length, beforeLines.length);
  assert.match(afterLines[2], /^- \[x\] 999\.1 — OAuth support \(promoted \d{4}-\d{2}-\d{2}\)$/);
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
  writeBacklog(base, [
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
  writeBacklog(base, before);

  const notifications = await runBacklog("remove 999.9");

  assert.equal(readBacklog(base), before);
  assert.match(notifications.join("\n"), /not found/);
});

test("backlog remove stops before a non-indented hyphen-dash entry and its notes", async (t) => {
  const base = makeTmpBase();
  enterBacklogDir(t, base);
  t.after(() => cleanup(base));
  const hyphenLine = "- [ ] 999.2 - Legacy hyphen entry";
  writeBacklog(base, [
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
  writeBacklog(base, [
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
  writeBacklog(base, [
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
