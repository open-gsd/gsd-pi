import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The module resolves the preferences path from homedir() at call time; on
// POSIX homedir() honors $HOME, so point it at a temp home before importing.
const tmpHome = mkdtempSync(join(tmpdir(), "gsd-pref-file-test-"));
const previousHome = process.env.HOME;
process.env.HOME = tmpHome;

const {
  getGlobalPreferencesPath,
  parsePreferencesFrontmatter,
  serializePreferencesFrontmatter,
  readGlobalPreferencesFile,
  writeGlobalPreferencesFile,
} = await import("../gsd-preferences-file.ts");

after(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
});

test("getGlobalPreferencesPath resolves under the caller's home", () => {
  assert.equal(getGlobalPreferencesPath(), join(tmpHome, ".gsd", "PREFERENCES.md"));
});

test("parse keeps body bytes after the frontmatter block", () => {
  const parsed = parsePreferencesFrontmatter("---\nrtk: true\n---\n\n# Notes\nfree text\n");
  assert.deepEqual(parsed.data, { rtk: true });
  assert.equal(parsed.body, "\n\n# Notes\nfree text\n");
  assert.equal(parsed.hasFrontmatter, true);

  const plain = parsePreferencesFrontmatter("no frontmatter here");
  assert.deepEqual(plain.data, {});
  assert.equal(plain.hasFrontmatter, false);
  assert.equal(plain.body, "no frontmatter here");
});

test("serialize round-trips through parse", () => {
  const content = serializePreferencesFrontmatter({ remote_questions: { channel: "slack" } }, "\nbody\n");
  const parsed = parsePreferencesFrontmatter(content);
  assert.deepEqual(parsed.data, { remote_questions: { channel: "slack" } });
  assert.equal(parsed.body, "\nbody\n");
});

test("read on a missing file answers empty data with a newline body", () => {
  rmSync(join(tmpHome, ".gsd"), { recursive: true, force: true });
  const read = readGlobalPreferencesFile();
  assert.deepEqual(read.data, {});
  assert.equal(read.body, "\n");
});

test("write creates the directory, replaces content, and leaves no temp files", () => {
  rmSync(join(tmpHome, ".gsd"), { recursive: true, force: true });
  writeGlobalPreferencesFile({ experimental: { rtk: true } }, "\n");
  const path = getGlobalPreferencesPath();
  assert.ok(existsSync(path));
  const parsed = parsePreferencesFrontmatter(readFileSync(path, "utf-8"));
  assert.deepEqual(parsed.data, { experimental: { rtk: true } });

  writeGlobalPreferencesFile({ experimental: { rtk: false } }, "\nkept body");
  const replaced = parsePreferencesFrontmatter(readFileSync(path, "utf-8"));
  assert.deepEqual(replaced.data, { experimental: { rtk: false } });
  assert.equal(replaced.body, "\nkept body");

  const leftovers = readdirSync(join(tmpHome, ".gsd")).filter((name) => name.includes(".tmp"));
  assert.deepEqual(leftovers, [], `temp files left behind: ${leftovers.join(", ")}`);
});

test("write preserves free-text body lines the routes do not own", () => {
  mkdirSync(join(tmpHome, ".gsd"), { recursive: true });
  writeFileSync(getGlobalPreferencesPath(), "---\nremote_questions:\n  channel: slack\n---\n# my notes\n", "utf-8");

  const { data, body } = readGlobalPreferencesFile();
  data.experimental = { rtk: true };
  writeGlobalPreferencesFile(data, body);

  const text = readFileSync(getGlobalPreferencesPath(), "utf-8");
  assert.match(text, /# my notes\n$/);
  assert.match(text, /rtk: true/);
});
