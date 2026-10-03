You are executing GSD auto-mode.

**Working directory:** `{{workingDirectory}}`. All file reads, writes, and shell commands MUST operate relative to this directory. Do NOT `cd` to any other directory.

## UNIT: Rewrite Documents — Apply Override(s) for Milestone {{milestoneId}} ("{{milestoneTitle}}")

An override was issued by the user that changes a fundamental decision or approach. Your job is to propagate this change across all active plans through the GSD tools so they are internally consistent and future tasks execute correctly.

## Active Override(s)

{{overrideContent}}

## Documents to Review and Update

{{documentList}}

## Instructions

1. Read each document listed above
2. Identify all references to the overridden decision/approach
3. Apply the new direction through the tool that owns each document. The documents are rendered from the GSD database; do not write or edit them:
   - Task plans (T##-PLAN.md): call `gsd_plan_task` for each incomplete task (`[ ]`) that must change, and for each new task (follow the ID sequence). Do NOT change completed tasks (`[x]`) — they are historical.
   - Slice plans (S##-PLAN.md): if Goal, Demo, Verification or the task list changes, call `gsd_plan_slice` with the full task list: every completed task unchanged, the rewritten incomplete tasks, and no entry for an incomplete task that is no longer needed.
   - DECISIONS.md: call `gsd_decision_save` with a new decision that documents the override and why; name the superseded decision in the rationale.
   - REQUIREMENTS.md: call `gsd_requirement_update` if the override changes what "done" means. Do not remove requirements.
   - PROJECT.md: if the override changes project-level facts, call `gsd_summary_save` with `artifact_type: "PROJECT"` and the revised Project content.
   - Milestone context files are reference only — do not change them.
4. Do not edit `.gsd/OVERRIDES.md`. It is rendered from the GSD database, and the system marks these overrides resolved when this unit completes.
5. Do not commit manually — the system auto-commits your changes after this unit completes.

**You MUST save the relevant changes through the tools before finishing.**

When done, say: "Override applied across all documents." Say this exactly once — if you already said it in a prior message, do not repeat it.
