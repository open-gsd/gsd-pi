/**
 * Regression — bootstrapped PREFERENCES.md must validate clean (#2986).
 *
 * `ensurePreferences()` writes the project preferences template used by the
 * headless bootstrap path (`bootstrapGsdProject` in guided-flow.ts). The
 * template previously wrote `skill_discovery: {}`, which `validatePreferences()`
 * rejects (`invalid skill_discovery value: [object Object]`), so every project
 * bootstrapped by `gsd headless new-milestone` logged a preferences error on
 * every later unit.
 *
 * This test drives the real template through the real validator — it asserts
 * the behaviour the contract requires (a freshly bootstrapped PREFERENCES.md
 * produces zero validation errors), not the spelling of one line.
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { parse } from 'yaml';

import { ensurePreferences } from '../gitignore.ts';
import { validatePreferences } from '../preferences-validation.ts';
import type { GSDPreferences } from '../preferences-types.ts';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-prefs-template-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function preferencesPath(name = 'PREFERENCES.md'): string {
  return path.join(dir, '.gsd', name);
}

function readBootstrappedFrontmatter(filePath: string): string {
  const content = fs.readFileSync(filePath, 'utf-8');
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  assert.ok(match, `bootstrapped file should have frontmatter. Got:\n${content}`);
  return match[1];
}

describe('ensurePreferences template validates clean (#2986)', () => {
  test('bootstrapped PREFERENCES.md produces zero validation errors', () => {
    assert.equal(ensurePreferences(dir), true, 'ensurePreferences should create the file');

    const parsed = parse(readBootstrappedFrontmatter(preferencesPath())) as GSDPreferences;

    const { errors, warnings } = validatePreferences(parsed);
    assert.deepEqual(
      errors,
      [],
      `bootstrapped template must validate clean. Errors: ${errors.join('; ')}`,
    );
    assert.deepEqual(warnings, [], 'bootstrapped template must not emit warnings either');

    // The key must stay nullish: runtime falls back to the documented default
    // ("suggest") and an explicit global setting still wins through the
    // nullish merge. Writing `auto` here would opt every project in.
    assert.ok(
      parsed.skill_discovery === null || parsed.skill_discovery === undefined,
      `template must leave skill_discovery unset, got: ${String(parsed.skill_discovery)}`,
    );
  });

  test('does not overwrite an existing uppercase PREFERENCES.md', () => {
    const filePath = preferencesPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '---\nversion: 1\nskill_discovery: off\n---\n');

    assert.equal(ensurePreferences(dir), false, 'existing file should suppress re-creation');
    assert.match(
      fs.readFileSync(filePath, 'utf-8'),
      /skill_discovery: off/,
      'existing content must survive the bootstrap call',
    );
  });

  test('does not overwrite a legacy lowercase preferences.md', () => {
    const legacyPath = preferencesPath('preferences.md');
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, '---\nversion: 1\nskill_discovery: off\n---\n');

    assert.equal(ensurePreferences(dir), false, 'legacy file should suppress re-creation');
    assert.match(
      fs.readFileSync(legacyPath, 'utf-8'),
      /skill_discovery: off/,
      // On case-insensitive filesystems the uppercase path IS the legacy file,
      // so "no duplicate" is guaranteed by construction there; content
      // preservation is the portable assertion.
      'legacy file must survive the bootstrap call unchanged',
    );
  });
});
