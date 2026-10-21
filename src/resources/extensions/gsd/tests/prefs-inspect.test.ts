// gsd-pi + prefs-inspect.test.ts - Read-only effective-preferences inspection (#2397).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  formatInspectDetail,
  formatInspectLines,
  formatPreferenceValue,
  inspectPreferences,
} from "../prefs-inspect.ts";
import { handlePrefsInspect } from "../commands-prefs-wizard.ts";
import { clearGSDPreferencesCache } from "../preferences.ts";
import { KNOWN_PREFERENCE_KEYS as KNOWN_KEYS } from "../preferences-types.ts";

/** Isolate GSD_HOME (global) and cwd (project) into temp dirs for one test. */
function isolate(t: test.TestContext): { home: string; project: string } {
  const home = mkdtempSync(join(tmpdir(), "gsd-prefs-inspect-home-"));
  const project = mkdtempSync(join(tmpdir(), "gsd-prefs-inspect-project-"));
  const originalHome = process.env.GSD_HOME;
  const originalCwd = process.cwd();
  mkdirSync(join(project, ".gsd"), { recursive: true });
  process.env.GSD_HOME = home;
  process.chdir(project);
  clearGSDPreferencesCache();
  t.after(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    clearGSDPreferencesCache();
  });
  return { home, project };
}

function writeGlobal(lines: string): void {
  writeFileSync(join(process.env.GSD_HOME!, "PREFERENCES.md"), `---\n${lines}\n---\n`, "utf-8");
}

function writeProject(lines: string): void {
  writeFileSync(join(process.cwd(), ".gsd", "PREFERENCES.md"), `---\n${lines}\n---\n`, "utf-8");
}

test("project values override global with provenance per key", (t) => {
  const { project } = isolate(t);
  writeGlobal("mode: solo\nbudget_ceiling: 10");
  writeProject("mode: team");
  clearGSDPreferencesCache();

  const inspection = inspectPreferences(project);
  const mode = inspection.entries.find((e) => e.key === "mode");
  const budget = inspection.entries.find((e) => e.key === "budget_ceiling");
  assert.ok(mode && budget);

  assert.equal(mode.source, "project");
  assert.equal(mode.value, "team");
  assert.equal(mode.projectValue, "team");
  assert.equal(mode.globalValue, "solo");
  assert.equal(budget.source, "global");
  assert.equal(budget.value, 10);
  assert.equal(budget.projectValue, undefined);

  assert.equal(inspection.files.find((f) => f.scope === "global")?.present, true);
  assert.equal(inspection.files.find((f) => f.scope === "project")?.present, true);

  const detail = formatInspectDetail(inspection, mode);
  assert.match(detail, /effective source: project/);
  assert.match(detail, /global \(.*\): "solo"/);
});

test("keys absent from both files read as unset with no invented default", (t) => {
  const { project } = isolate(t);
  clearGSDPreferencesCache();

  const inspection = inspectPreferences(project);
  const verification = inspection.entries.find((e) => e.key === "verification_max_retries");
  assert.ok(verification);
  assert.equal(verification.source, "unset");
  assert.equal(verification.value, undefined);
  assert.equal(inspection.files.find((f) => f.scope === "project")?.present, false);

  const lines = formatInspectLines(inspection);
  assert.ok(lines.some((l) => l.startsWith("verification_max_retries · — · unset")));
});

test("unknown keys in a file are surfaced by name with their diagnostic", (t) => {
  const { project } = isolate(t);
  writeProject("mode: solo\ntotally_made_up_key: true");
  clearGSDPreferencesCache();

  const inspection = inspectPreferences(project);
  // The loader drops unknown keys from its output (values ignored), so they
  // cannot appear as entries — they are named in unknownKeys instead.
  assert.equal(inspection.entries.find((e) => e.key === "totally_made_up_key"), undefined);
  assert.deepEqual(inspection.unknownKeys, [{ key: "totally_made_up_key", scope: "project" }]);
  assert.ok(inspection.diagnostics.some((d) => d.message.includes('"totally_made_up_key"')));
  assert.ok(
    inspection.entries.every((e) => KNOWN_KEYS.has(e.key)),
    "entries must stay within KNOWN_PREFERENCE_KEYS",
  );
});

test("formatPreferenceValue truncates long values and renders undefined as em dash", (t) => {
  assert.equal(formatPreferenceValue(undefined), "—");
  assert.equal(formatPreferenceValue({ a: 1 }), '{"a":1}');
  const long = formatPreferenceValue("x".repeat(200), 20);
  assert.equal(long.length, 20);
  assert.match(long, /…$/);
});

test("handlePrefsInspect lists values, drills into a key, and closes on cancel", (t) => {
  const { project } = isolate(t);
  writeGlobal("mode: solo");
  writeProject("budget_ceiling: 7.5");
  clearGSDPreferencesCache();

  const notifications: Array<{ message: string; type?: string }> = [];
  let selects = 0;
  const ctx = {
    ui: {
      notify(message: string, type?: "info" | "warning" | "error" | "success") {
        notifications.push({ message, type });
      },
      async select(_title: string, options: string[]): Promise<string> {
        selects += 1;
        if (selects === 1) {
          const line = options.find((o) => o.startsWith("budget_ceiling"));
          assert.ok(line, "budget_ceiling should appear in the inspect list");
          return line;
        }
        return "";
      },
    },
  };

  return handlePrefsInspect(ctx as never).then(() => {
    assert.equal(selects, 2);
    // Header notification + one per-key detail.
    const header = notifications[0]!.message;
    assert.match(header, /effective values · source/);
    assert.doesNotMatch(header, /missing:/);
    const detail = notifications.find((n) => n.message.includes("budget_ceiling"));
    assert.ok(detail, "expected a per-key detail notification");
    assert.match(detail!.message, /effective source: project/);
    assert.match(detail!.message, /project \(.*\): 7\.5/);
  });
});
