// GSD — validation unit tests

import test from 'node:test';
import assert from 'node:assert/strict';

import { isNonEmptyString, sanitizeTitle, validateStringArray } from '../validation.ts';

// ─── isNonEmptyString ────────────────────────────────────────────────────────

test('isNonEmptyString: "hello" returns true', () => {
  assert.equal(isNonEmptyString('hello'), true);
});

test('isNonEmptyString: " " (whitespace only) returns false', () => {
  assert.equal(isNonEmptyString(' '), false);
});

test('isNonEmptyString: "" (empty string) returns false', () => {
  assert.equal(isNonEmptyString(''), false);
});

test('isNonEmptyString: null returns false', () => {
  assert.equal(isNonEmptyString(null), false);
});

test('isNonEmptyString: undefined returns false', () => {
  assert.equal(isNonEmptyString(undefined), false);
});

test('isNonEmptyString: 42 (number) returns false', () => {
  assert.equal(isNonEmptyString(42), false);
});

// ─── validateStringArray ─────────────────────────────────────────────────────

test('validateStringArray: ["a", "b"] returns ["a", "b"]', () => {
  assert.deepEqual(validateStringArray(['a', 'b'], 'items'), ['a', 'b']);
});

test('validateStringArray: [] (empty array) returns []', () => {
  assert.deepEqual(validateStringArray([], 'items'), []);
});

test('validateStringArray: "not an array" throws with "must be an array"', () => {
  assert.throws(
    () => validateStringArray('not an array', 'items'),
    (err: Error) => {
      assert.ok(err.message.includes('must be an array'));
      return true;
    },
  );
});

test('validateStringArray: ["a", 42] throws with "must contain only non-empty strings"', () => {
  assert.throws(
    () => validateStringArray(['a', 42], 'items'),
    (err: Error) => {
      assert.ok(err.message.includes('must contain only non-empty strings'));
      return true;
    },
  );
});

test('validateStringArray: ["a", ""] throws with "must contain only non-empty strings"', () => {
  assert.throws(
    () => validateStringArray(['a', ''], 'items'),
    (err: Error) => {
      assert.ok(err.message.includes('must contain only non-empty strings'));
      return true;
    },
  );
});

// ─── sanitizeTitle (#2588) ───────────────────────────────────────────────────


test('sanitizeTitle: em dash with surrounding spaces becomes spaced hyphen', () => {
  assert.equal(sanitizeTitle('Control Plan — Time Zones'), 'Control Plan - Time Zones');
});

test('sanitizeTitle: em dash without spaces becomes spaced hyphen', () => {
  assert.equal(sanitizeTitle('Control Plan—Time Zones'), 'Control Plan - Time Zones');
});

test('sanitizeTitle: en dash becomes spaced hyphen', () => {
  assert.equal(sanitizeTitle('S01 – Setup'), 'S01 - Setup');
});

test('sanitizeTitle: forward slash becomes hyphen, spaces collapsed', () => {
  assert.equal(sanitizeTitle('Client/Server split'), 'Client-Server split');
  assert.equal(sanitizeTitle('Client / Server split'), 'Client-Server split');
});

test('sanitizeTitle: clean titles pass through unchanged', () => {
  assert.equal(sanitizeTitle('DB-backed planning'), 'DB-backed planning');
});
