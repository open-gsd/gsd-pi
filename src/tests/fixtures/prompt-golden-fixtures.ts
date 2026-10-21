// Project/App: gsd-pi
// File Purpose: Shared prompt fixture definitions for Phase 0 characterization and Phase 2 reduction targets.

export const promptGoldenUnits = [
  {
    unitType: "plan-slice",
    phase2StartChars: 19259,
    requiredMarkers: [
      "UNIT: Plan Slice S01",
      "Inlined Context",
      "gsd_plan_slice",
      "Baseline Slice",
    ],
  },
  {
    unitType: "execute-task",
    // Tool Surface guidance and related prompt additions have grown this prompt;
    // the baseline is adjusted so the gate still tracks shrinkage from the
    // original oversized prompts while allowing today's ~8586-char fixture.
    phase2StartChars: 14320,
    requiredMarkers: [
      "UNIT: Execute Task T01",
      "Inlined Task Plan",
      "Background process rule",
      "Verification Evidence",
      "blocker_discovered",
      "gsd_task_complete",
      "Implement baseline harness",
    ],
  },
  {
    unitType: "complete-slice",
    // Tool Surface guidance and subsequent feature additions (most recently,
    // explicit terminal-handoff stop rules for gsd_task_reopen/gsd_replan_slice
    // per issue #846) have grown this prompt; the baseline is adjusted so the
    // gate still tracks shrinkage from the original oversized prompts while
    // allowing today's ~9487-char fixture.
    // T025 re-baseline (15400 -> 15900): rendered fixture measured 9418 chars
    // at 04f3ba14e (the last adjustment — its "~9154" note was a short-tmp-path
    // Linux measurement; the gate was already over cap there) and 9454 chars at
    // HEAD c6935a65b. The +36-char net growth since is deliberate content
    // (DB-authoritative milestone lifecycle #1476, terminal-handoff stop-rule
    // tightening), mostly offset by #1475 prompt compression — not accidental
    // bloat.
    // Re-baseline (15900 -> 16000): the Tool Surface block now advertises the
    // exact allowed GSD lifecycle tool and subagent tokens derived from the
    // unit's tool contract, which removed the near-miss HARD BLOCKs that
    // stalled auto-mode runs. Measured 9487 chars here; floor(16000 * 0.6) =
    // 9600 restores roughly the headroom the #846 adjustment used, which
    // 15900's 9540 cap had shrunk to 53 chars.
    phase2StartChars: 16000,
    requiredMarkers: [
      "UNIT: Complete Slice S01",
      "Tool Surface",
      "Inlined Context",
      "gsd_slice_complete",
      "Slice Summary",
    ],
  },
] as const;

export type PromptGoldenUnitType = typeof promptGoldenUnits[number]["unitType"];
