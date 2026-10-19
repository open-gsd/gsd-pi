# Parallel Slice Research

**Working directory:** `{{workingDirectory}}`. All file reads, writes, and shell commands MUST operate relative to this directory. Do NOT `cd` to any other directory.

You are dispatching parallel research agents for **{{sliceCount}} slices** in milestone **{{mid}} — {{midTitle}}**.

## Slices to Research

{{sliceList}}

## Mission

Dispatch ALL slices simultaneously using the `subagent` tool in **parallel mode**. Each subagent will independently research its slice and save its RESEARCH through `gsd_summary_save`.

**Tool call format:** Call `subagent` with `tasks: [...]` as a **native JSON array** — one object per slice. Do NOT JSON.stringify the array into a string; the tool validates that `tasks` is an array, and a serialized string will be rejected with "must be array".

**Critical:** Dispatch synchronously within this turn — every dispatch MUST set `run_in_background: false`. Do not background any dispatch: a backgrounded subagent finishes after your turn ends, so its RESEARCH file is never verified and the unit settles without its artifact. If only the native `Agent` tool is presented on this host, use it — still with `run_in_background: false` — one call per slice, all in the same message so they run in parallel. Your turn may NOT end until every slice's RESEARCH file is written (or has its `## BLOCKER` note).

## Execution Protocol

1. Call `subagent` with `tasks: [{ agent: "{{scoutAgentType}}", task: "<prompt>" }, ...]` containing one entry per slice below
2. Wait for ALL subagents to complete
3. Verify each slice's RESEARCH file was written (check `.gsd/milestones/{{mid}}/slices/<slice-id>/`)
4. If a subagent failed to write its RESEARCH file, retry it **once** individually
5. If it fails a second time, call `gsd_summary_save` for that slice (`artifact_type: "RESEARCH"`, its `slice_id`) with partial research that has a `## BLOCKER` section explaining the failure — do NOT retry again
6. Report which slices completed research and which (if any) needed a blocker note

**Important**: Each failed slice gets exactly one retry. After that, save the blocker and move on. Never retry the same slice more than once.

## Subagent Prompts

{{subagentPrompts}}
