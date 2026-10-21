// Project/App: gsd-pi
// File Purpose: Unit tests for browser requirement and persisted evidence detection.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { formatTimelineEntries } from '../../browser-tools/core.ts';
import {
  browserTimelineHasNavigateAndAssert,
  hasBrowserRequiredText,
  hasPassedStructuredBrowserUatEvidenceText,
} from '../browser-evidence.ts';

test('structured browser UAT evidence requires an overall and check-level PASS', () => {
  const evidence = [
    '---',
    'uatType: browser-executable',
    'verdict: PASS',
    '---',
    '| Check | Mode | Result | Evidence | Notes |',
    '| SSE stats | browser | PASS | browser:.artifacts/browser/session/stats.json | persisted structured evidence |',
  ].join('\n');

  assert.equal(hasPassedStructuredBrowserUatEvidenceText(evidence), true);
  assert.equal(hasPassedStructuredBrowserUatEvidenceText(evidence.replace('browser | PASS', 'browser | FAIL')), false);
  assert.equal(hasPassedStructuredBrowserUatEvidenceText(evidence.replace('verdict: PASS', 'verdict: FAIL')), false);
});

test('persisted browser_batch timelines retain successful navigate and assert steps', () => {
  const persistedTimeline = formatTimelineEntries([{
    id: 1,
    tool: 'browser_batch',
    paramsSummary: 'steps=[3]',
    startedAt: 1,
    finishedAt: 2,
    status: 'success',
    beforeUrl: 'about:blank',
    afterUrl: 'http://127.0.0.1:58081/admin-api/log/stream/stats',
    batchSteps: [
      { action: 'navigate', ok: true },
      { action: 'assert', ok: true },
      { action: 'assert', ok: true },
    ],
  }]);
  assert.equal(browserTimelineHasNavigateAndAssert(persistedTimeline), true);
  assert.equal(browserTimelineHasNavigateAndAssert({
    tool: 'browser_batch',
    status: 'error',
    stepResults: [
      { action: 'navigate', ok: true },
      { action: 'assert', ok: false },
    ],
  }), false);
});

describe('hasBrowserRequiredText', () => {
  test('detects browser requirement in a plain test-cases section', () => {
    const text = [
      '## Test Cases',
      '',
      '1. Open index.html in a browser and navigate to /dashboard.',
      '',
    ].join('\n');
    assert.ok(hasBrowserRequiredText(text), 'plain browser step should be detected');
  });

  test('ignores browser mention under a top-level non-requirement heading', () => {
    const text = [
      '## Not Proven',
      '',
      '- Keyboard usability through a real browser.',
      '- Browser console cleanliness.',
      '',
    ].join('\n');
    assert.ok(!hasBrowserRequiredText(text), 'browser mention under "Not Proven" should be ignored');
  });

  test('sub-heading inside a non-requirement section does not re-enable detection', () => {
    // BUG (pre-fix): ### sub-heading under ## Not Proven resets inNonRequirementSection
    // to false, causing subsequent lines to be detected as browser requirements.
    const text = [
      '## Not Proven By This UAT',
      '',
      '- No live browser session was used.',
      '',
      '### Visual Checks',
      '',
      '- Browser visual polish deferred to next slice.',
      '- Keyboard interaction in a real browser is not proven here.',
      '',
    ].join('\n');
    assert.ok(
      !hasBrowserRequiredText(text),
      'sub-heading under a non-requirement section must not re-enable browser detection',
    );
  });

  test('requirement-level heading after non-requirement section re-enables detection', () => {
    const text = [
      '## Not Proven',
      '',
      '- Browser polish deferred.',
      '',
      '## Test Cases',
      '',
      '1. Launch browser and open localhost.',
      '',
    ].join('\n');
    assert.ok(
      hasBrowserRequiredText(text),
      'browser step under "Test Cases" (same depth as "Not Proven") must still be detected',
    );
  });

  test('deferred sub-heading inside a requirement section scopes exclusion to its own block', () => {
    const text = [
      '## Test Cases',
      '',
      '1. Open browser at localhost.',
      '',
      '### Deferred: keyboard check',
      '',
      '- Keyboard UAT deferred to next slice.',
      '',
      '### Step 2: Verify DOM',
      '',
      '1. Navigate to /dashboard in the browser.',
      '',
    ].join('\n');
    assert.ok(
      hasBrowserRequiredText(text),
      'browser step under "Step 2" sub-heading must be detected after a sibling "Deferred" sub-heading',
    );
  });

  test('deferred sub-heading at same depth as test cases does not escape to parent', () => {
    const text = [
      '## Test Cases',
      '',
      '### Deferred: responsive layout',
      '',
      '- Responsive layout check is deferred to S02.',
      '',
    ].join('\n');
    assert.ok(
      !hasBrowserRequiredText(text),
      'content under a "Deferred" sub-heading should be excluded from detection',
    );
  });

  test('detects browser requirement written only in a heading', () => {
    // Regression: the line-by-line scan previously skip-continued past headings,
    // missing browser obligations expressed only in heading text.
    const text = '## Open browser session at localhost\n';
    assert.ok(hasBrowserRequiredText(text), 'browser requirement in heading text must be detected');
  });

  test('heading that opens a non-requirement section is not itself detected as a requirement', () => {
    const text = '## Not Proven\n\n- Some note.\n';
    assert.ok(
      !hasBrowserRequiredText(text),
      'a non-requirement section heading should not trigger browser detection',
    );
  });

  test('returns false for empty text', () => {
    assert.ok(!hasBrowserRequiredText(''), 'empty string returns false');
  });

  test('notes-for-tester heading with sub-headings stays non-requirement', () => {
    const text = [
      '## Notes for Tester',
      '',
      '### Browser Setup',
      '',
      '- Run this spec without a browser; a DOM harness is sufficient.',
      '- Browser-based visual checks are deferred.',
      '',
      '### Follow-up Items',
      '',
      '- Track browser session evidence in S02.',
      '',
    ].join('\n');
    assert.ok(
      !hasBrowserRequiredText(text),
      'sub-headings under "Notes for Tester" should not re-enable browser detection',
    );
  });
});

describe('hasBrowserRequiredText — database snapshot wording', () => {
  // #2081 (#766 follow-up): bare `snapshot` classified database/backup snapshot
  // work (snapshot create, restore-check, export/import chains, Chinese text
  // containing `snapshot`) as browser-required, blocking gsd_validate_milestone
  // for CLI-only milestones. `snapshot` stays a bare positive signal —
  // hasBrowserRequiredText scans physical lines, so a context requirement missed
  // wrapped ("Take a rendered page\nsnapshot") and labeled ("Browser: take a
  // snapshot") lines — and a match is dropped only when a DB-CLI verb follows it
  // or a database-ish word shares its clause.
  test('database/backup snapshot phrasings are not browser requirements', () => {
    assert.ok(!hasBrowserRequiredText('snapshot create'), 'snapshot + DB-CLI verb must not escalate');
    assert.ok(!hasBrowserRequiredText('snapshot restore-check'), 'snapshot + DB-CLI verb must not escalate');
    assert.ok(!hasBrowserRequiredText('snapshot_operation'), 'identifier-shaped name must not escalate');
    assert.ok(!hasBrowserRequiredText('db snapshot'), 'database snapshot must not escalate');
    assert.ok(!hasBrowserRequiredText('backup snapshot'), 'backup snapshot must not escalate');
    assert.ok(
      !hasBrowserRequiredText('purge / snapshot / export / import / restore-check crash-injection chain'),
      'DB snapshot operation chain must not escalate',
    );
    assert.ok(
      !hasBrowserRequiredText('snapshot 与 export 的崩溃残留操作…'),
      'non-English DB crash phrasing must not escalate',
    );
    assert.ok(
      !hasBrowserRequiredText('Create a snapshot of each modified database page.'),
      'database-page snapshot must not escalate',
    );
    assert.ok(
      !hasBrowserRequiredText('Create a database snapshot, then render a CLI summary.'),
      'database snapshot with CLI render must not escalate',
    );
  });

  test('a genuine browser snapshot step is still a browser requirement', () => {
    assert.ok(
      hasBrowserRequiredText('snapshot the rendered page state in the browser.'),
      'browser snapshot step must escalate',
    );
    assert.ok(
      hasBrowserRequiredText('Take a page snapshot after the dialog opens.'),
      'page snapshot must escalate',
    );
    assert.ok(
      hasBrowserRequiredText('Compare the DOM snapshot against the render.'),
      'DOM snapshot must escalate',
    );
    assert.ok(
      hasBrowserRequiredText('Verify the settings flow renders, take a snapshot'),
      'trailing bare snapshot must escalate',
    );
    assert.ok(
      hasBrowserRequiredText('Check the accessibility snapshot after the dialog opens.'),
      'accessibility snapshot must escalate',
    );
    assert.ok(
      hasBrowserRequiredText('Save a visual snapshot of the layout.'),
      'visual snapshot must escalate',
    );
    assert.ok(
      hasBrowserRequiredText('Capture a viewport snapshot at each breakpoint.'),
      'viewport snapshot must escalate',
    );
    assert.ok(
      hasBrowserRequiredText('snapshot the homepage after login.'),
      'homepage snapshot must escalate',
    );
  });

  test('wrapped and labeled snapshot lines stay detected', () => {
    assert.ok(
      hasBrowserRequiredText(['Take a rendered page', 'snapshot of the dashboard.'].join('\n')),
      'snapshot on a wrapped line must escalate',
    );
    assert.ok(
      hasBrowserRequiredText('Browser: take a snapshot after login.'),
      'labeled snapshot line must escalate',
    );
  });

  test('other browser-observable phrasings stay detected', () => {
    assert.ok(hasBrowserRequiredText('take a screenshot of the page'), 'screenshot step must be detected');
    assert.ok(hasBrowserRequiredText('check the site in the browser'), 'in-browser check must be detected');
  });
});

describe('hasBrowserRequiredText — negated browser mentions', () => {
  // Acceptance run 7: a slice that writes two text files declared
  // "UAT mode: artifact-driven" and explained why. complete-slice rejected it with
  // "UAT requires browser verification". The rationale line read
  // "...no runtime behavior, server, UI, or browser interaction is involved" — the
  // negator sits several list items away from "browser", so the adjacency-based
  // negation guard missed it and `browser interaction` matched as a requirement.
  test('a negated list mentioning browser is not a browser requirement', () => {
    const text = [
      '## UAT Type',
      '',
      '- UAT mode: artifact-driven',
      '- Why this mode is sufficient: slice deliverables are static text files with exact',
      '  required content; no runtime behavior, server, UI, or browser interaction is involved.',
    ].join('\n');
    assert.ok(!hasBrowserRequiredText(text), 'negated browser mention must not escalate');
  });

  test('adjacent negations still pass', () => {
    assert.ok(!hasBrowserRequiredText('- No browser interaction is required.'));
    assert.ok(!hasBrowserRequiredText('- Verified without a browser session.'));
  });

  test('a real requirement in a later clause still counts', () => {
    // The negation guard is clause-bounded, so it must not swallow the sentence after it.
    const text = [
      '## Test Cases',
      '',
      '1. No seeded data is needed. Open the page at localhost:3000 and screenshot it.',
    ].join('\n');
    assert.ok(hasBrowserRequiredText(text), 'a genuine browser step must still be detected');
  });
});
