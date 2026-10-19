---
name: handoff
description: Prepare a clean cross-session handoff so the next agent can pick up where you left off. Saves a focused Work Checkpoint with `gsd_checkpoint_save` and ensures summary artifacts are current. Use when asked to "hand off", "prepare handoff", "pause work", "bookmark this", "I'll come back to this later", before running out of context budget, or ending a long session with unfinished work.
---

<objective>
Leave the project in a state where a fresh agent with no memory of this session can be productive within one minute. The deliverable is a Work Checkpoint saved with `gsd_checkpoint_save` plus up-to-date summary artifacts — not a chat recap.
</objective>

<context>
GSD already renders `STATE.md` (from the database, after every lifecycle tool call) and summary files (`M###-SUMMARY.md`, `S##-SUMMARY.md`, `T##-SUMMARY.md`). The gap is the *mid-task* handoff: you're partway through a task, context is getting long, and the next session shouldn't start by re-deriving your mental state.

The Work Checkpoint exists for exactly this. It is a database row. The next session of the task gets it as the "Resume State" section of its prompt, and `/gsd` offers "Resume" instead of "Execute" for a task that has one. `CONTINUE.md` in the slice directory is rendered from the row for people to read; it is never read back. Do not write `continue.md`, `CONTINUE.md` or `HANDOFF.md` yourself.

Invocation points:

- User says "pause", "hand off", "I'll come back later", "this is a good stopping point"
- Context usage nearing budget — better to hand off cleanly than truncate mid-thought
- Before a risky operation (dependency upgrade, major refactor) where you want a known-good checkpoint
- End of a long session, multi-day work
</context>

<core_principle>
**WRITE FOR A STRANGER.** The next reader is not you. They do not have this conversation. They have the project snapshot (`gsd_project_snapshot`), the checkpoint, the last summary, and the code. That has to be enough.

**CURRENT STATE ONLY.** The checkpoint says "pick up HERE." It is not a log of what you did; that goes in summaries. It is not a plan for future work; that lives in the plan files.

**NO SECRETS, NO STALE PATHS.** Do not inline env values, tokens, or paths that only exist in your working directory. Cite artifacts by relative path from the project root.
</core_principle>

<process>

## Step 1: Identify what's in flight

Answer briefly:

1. What task (`T##`) am I on? What's its current plan file?
2. What have I completed since the last summary?
3. What's the next concrete action? (Not a goal — an action: "Run X. If Y, do Z.")
4. What, if anything, is blocking or uncertain?

## Step 2: Update the summaries, not the handoff

Before saving the checkpoint:

- **Any task that's actually done?** Use `gsd_task_complete` (or the equivalent tool) to toggle state. Do NOT edit checkboxes by hand. This triggers `STATE.md` rebuild and `T##-SUMMARY.md` generation.
- **Any slice-level decisions worth preserving?** Save them with `gsd_decision_save`.
- **Any patterns or traps future agents should know about?** Record each one with `capture_thought`.

This shrinks what the checkpoint has to carry.

## Step 3: Save the checkpoint

Call `gsd_checkpoint_save` with the fields below. Keep it tight — one screenful max.

- `milestoneId`, `sliceId`, `taskId` — the unit in flight. Pass `taskId` when a task is in progress; without it the next session of the task does not get the checkpoint.
- `kind` — `handoff`.
- `confirmedContext` — the last action, with evidence, and why the next step follows.
  Example: "Ran `npm test` after editing `src/auth/session.ts`; 2 failures in `session.test.ts` — both complain about a missing `expiresAt` field in the mock fixture. The session refactor moved `expiresAt` from optional to required in `Session`; fixtures were never updated."
- `nextAction` — one concrete action the next agent should take.
  Example: "Update `fixtures/sessions.ts` to include `expiresAt: Date.now() + 3600_000` on every fixture, then re-run `npm test`."
- `unresolved` — open threads you noticed but deliberately didn't act on, and traps the next agent might stumble into.
  Example: "Validator in `src/auth/validator.ts` still accepts unbounded session lengths — file as a separate issue after T03 lands. Do NOT revert the `Session` interface change — it's required for T04. Do NOT run `npm run db:reset` in this branch; dev data is still needed for manual UAT."
- `evidence` — optional: commands, files and results that support the confirmed context. List modified, uncommitted files here.

## Step 4: Sanity check

Call `gsd_project_snapshot`, then read the checkpoint you saved + the most recent summary as if you were a fresh agent. Ask:

1. Do I know what to do next?
2. Do I know why?
3. Do I know what not to do?

If any answer is no, the handoff is incomplete. Save a new checkpoint; the newest one is the resume state.

## Step 5: Stop cleanly

- Do not leave in-flight `async_bash` or `bg_shell` jobs. Cancel or wait for them.
- Do not leave uncommitted changes without flagging them in the checkpoint — note which files are modified and why.
- Do not push mid-task commits to remote unless that was the plan — they create noise for reviewers.

</process>

<anti_patterns>

- **Chat-log handoffs.** "First I did X, then Y, then Z…" The next agent doesn't need the journey.
- **A checkpoint that summarizes the whole slice.** That's what `S##-SUMMARY.md` is for, at slice completion.
- **No `nextAction`.** A handoff without a concrete next action is a journal entry.
- **Implicit assumptions.** "Obviously the next thing is…" — write it down.
- **Leaving background processes running.** They'll be orphaned when the session ends.
- **Handoff without updating summaries.** The checkpoint should be thin because the summaries carry the weight.
- **Writing `continue.md` or `HANDOFF.md` by hand.** Nothing reads those files; only the checkpoint row selects the resume path.

</anti_patterns>

<success_criteria>

- [ ] `gsd_checkpoint_save` succeeded for the unit in flight.
- [ ] The `nextAction` is concrete and executable without this session's context.
- [ ] Completed tasks were marked done via `gsd_*` tools, not by hand-edited checkboxes.
- [ ] Anything notable that was learned is saved with `capture_thought` or `gsd_decision_save`.
- [ ] Background processes are not orphaned.
- [ ] A cold-read of the project snapshot + the checkpoint + latest summary would produce the right next action.

</success_criteria>
