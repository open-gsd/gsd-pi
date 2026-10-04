/**
 * Runtime regression — closed-status omission for open-slice detection
 * (#4902).
 *
 * `findOpenSlices` (auto-dispatch.ts) reports the milestone slices that are
 * not in a closed or deferred status; validate-milestone and
 * complete-milestone dispatch stop on them. This tests the exported
 * predicates (`isClosedStatus`, `isInactiveStatus`) that the filter uses, so
 * any drift surfaces as a test failure here rather than a runtime miss.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { isClosedStatus, isInactiveStatus } from '../status-guards.ts';

describe('isClosedStatus — closed-status omission contract (#4902)', () => {
  test('returns true for every status findOpenSlices skips', () => {
    for (const s of ['complete', 'done', 'skipped']) {
      assert.equal(
        isClosedStatus(s),
        true,
        `${s} must count as a closed status`,
      );
    }
  });

  test('returns false for live in-flight statuses', () => {
    for (const s of ['pending', 'active', 'in-progress', 'planning', 'executing']) {
      assert.equal(
        isClosedStatus(s),
        false,
        `${s} is in-flight and MUST be reported as open`,
      );
    }
  });

  test('isInactiveStatus also covers deferred so it is not reported as open', () => {
    // Deferred slices never run; the active-slice selector and findOpenSlices
    // use isInactiveStatus to skip them. Pin the contract.
    assert.equal(isInactiveStatus('deferred'), true);
    assert.equal(isInactiveStatus('complete'), true);
    assert.equal(isInactiveStatus('pending'), false);
  });
});
