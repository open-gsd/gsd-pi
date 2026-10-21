// GSD Extension — Stop Notice module tests
// Locks the emitter↔detector round-trip: every notice the formatters produce
// must be recognized by the classifiers the headless host uses for exit codes.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  formatStopNoticePrefix,
  formatVerdictRecordedNotice,
  formatVerdictRejectedNotice,
  isBlockedStopReason,
  markBlockedStopReason,
  stopNoticeDisplayReason,
  stopNoticeKind,
  isTerminalNotice,
  isPauseNotice,
  isBlockedNoticeMessage,
  isManualResolutionNotice,
  isInteractiveMenuUnavailableNotice,
  PAUSED_NOTICE_PREFIXES,
  TERMINAL_NOTICE_PREFIXES,
} from "../stop-notice.js";

describe("stop notice formatting", () => {
  test("plain stop has no reason suffix", () => {
    assert.equal(formatStopNoticePrefix(), "Auto-mode stopped");
    assert.equal(formatStopNoticePrefix(null), "Auto-mode stopped");
  });

  test("reason is appended after an em-dash", () => {
    assert.equal(formatStopNoticePrefix("user request"), "Auto-mode stopped — user request");
  });

  test("Blocked: marker switches the prefix and is stripped from display", () => {
    assert.equal(formatStopNoticePrefix("Blocked: validation gate"), "Auto-mode blocked — validation gate");
    assert.equal(stopNoticeKind("Blocked: x"), "blocked");
    assert.equal(stopNoticeKind("stop"), "stopped");
    assert.ok(isBlockedStopReason("blocked: lowercase too"));
    assert.equal(stopNoticeDisplayReason("Blocked:  spaced "), "spaced");
  });
});

describe("emitter↔detector round-trip", () => {
  test("formatted stop notices classify as terminal", () => {
    for (const reason of [undefined, "user request"]) {
      const message = formatStopNoticePrefix(reason).toLowerCase();
      assert.ok(isTerminalNotice(message), `not terminal: ${message}`);
    }
  });

  test("pause prefixes classify as pause and as blocked (operator intervention)", () => {
    for (const prefix of PAUSED_NOTICE_PREFIXES) {
      assert.ok(isPauseNotice(`${prefix}: provider error`));
      assert.ok(isBlockedNoticeMessage(`${prefix}: provider error`));
    }
  });

  test("idempotent-advance pauses are non-blocking", () => {
    assert.equal(isBlockedNoticeMessage("auto-mode paused (idempotent advance: unit already active)"), false);
  });

  test("manual-resolution notices classify as blocked", () => {
    const message = "merge conflict — resolve manually and re-run /gsd auto";
    assert.ok(isManualResolutionNotice(message));
    assert.ok(isBlockedNoticeMessage(message));
  });

  test("verdict notices classify as terminal with rejected notices blocked", () => {
    const recorded = formatVerdictRecordedNotice("Milestone M001 verdict: needs-attention -> pass").toLowerCase();
    const rejected = formatVerdictRejectedNotice("No milestone validation found for M001.").toLowerCase();

    assert.ok(isTerminalNotice(recorded));
    assert.equal(isBlockedNoticeMessage(recorded), false);

    assert.ok(isTerminalNotice(rejected));
    assert.ok(isBlockedNoticeMessage(rejected));
  });

  test("un-showable menu notices classify as blocked (#1294)", () => {
    // Emitted verbatim by notifyCommandMenuUnavailable (next-action-ui.ts / command-feedback.ts).
    const menuUnavailable =
      "gsd — m002: editorial hn menu could not be shown in this session.\nrun /gsd when ready.";
    assert.ok(isInteractiveMenuUnavailableNotice(menuUnavailable));
    assert.ok(isBlockedNoticeMessage(menuUnavailable));

    // Emitted by notifyPickerCommandNeedsInteractiveMenu (command-feedback.ts).
    const pickerGuidance = "/gsd did not start: milestone menu needs an interactive session";
    assert.ok(isInteractiveMenuUnavailableNotice(pickerGuidance));
    assert.ok(isBlockedNoticeMessage(pickerGuidance));

    // Unrelated notices are not swept up.
    assert.equal(isInteractiveMenuUnavailableNotice("auto-mode complete"), false);
  });

  test("terminal prefixes cover the known stop vocabulary", () => {
    for (const message of [
      "auto-mode stopped.",
      "auto-mode complete",
      "auto-mode idle",
      "no active milestone",
      "verdict recorded: milestone m001 verdict: needs-attention -> pass",
      "verdict rejected: unexpected argument: x",
    ]) {
      assert.ok(TERMINAL_NOTICE_PREFIXES.some((prefix) => message.startsWith(prefix)), message);
    }
  });
});

describe("blocked stop marking", () => {
  // Run 5 of the auto-mode acceptance harness stopped with
  // "state did not advance after finalized complete-slice M001/S02" and exited 0
  // — reporting success while the milestone was still open. The orchestrator had
  // classified it kind:"blocked", but the reason reached the headless host
  // unmarked, and the exit code is derived from the marker alone.
  const orchestratorReason = "state did not advance after finalized complete-slice M001/S02";

  test("an unmarked reason does not classify as blocked", () => {
    assert.equal(isBlockedStopReason(orchestratorReason), false);
    assert.equal(stopNoticeKind(orchestratorReason), "stopped");
  });

  test("marking makes it classify as blocked and survive the round-trip", () => {
    const marked = markBlockedStopReason(orchestratorReason);
    assert.equal(isBlockedStopReason(marked), true);
    assert.equal(stopNoticeKind(marked), "blocked");
    assert.equal(stopNoticeDisplayReason(marked), orchestratorReason);
    assert.equal(formatStopNoticePrefix(marked), `Auto-mode blocked — ${orchestratorReason}`);
  });

  test("marking is idempotent", () => {
    const once = markBlockedStopReason(orchestratorReason);
    assert.equal(markBlockedStopReason(once), once);
  });
});

describe("blocked stop notices reach the host as blocked+terminal", () => {
  // The full emitter→detector path for the run-5 stall: orchestrator marks the
  // reason, stopAuto formats the notice, the headless host classifies it.
  const notice = formatStopNoticePrefix(
    markBlockedStopReason("state did not advance after finalized complete-slice M001/S02"),
  ).toLowerCase();

  test("classifies as blocked (drives the blocked exit code, not 0)", () => {
    assert.ok(isBlockedNoticeMessage(notice), notice);
  });

  test("classifies as terminal (ends the run rather than hanging)", () => {
    assert.ok(isTerminalNotice(notice), notice);
  });

  test("a plain stop stays non-blocking", () => {
    const plain = formatStopNoticePrefix("all milestones complete").toLowerCase();
    assert.ok(isTerminalNotice(plain));
    assert.equal(isBlockedNoticeMessage(plain), false);
  });
});
