# Parallel Slice Research

**Working directory:** `{{workingDirectory}}`. All file reads, writes, and shell commands MUST operate relative to this directory. Do NOT `cd` to any other directory.

You are dispatching parallel research agents for **{{sliceCount}} slices** in milestone **{{mid}} — {{midTitle}}**.

## Slices to Research

{{sliceList}}

## Mission

Dispatch ALL slices simultaneously using the `subagent` tool in **parallel mode**. Each subagent will independently research its slice and write a RESEARCH file.

**Tool call format:** Call `subagent` with `tasks: [...]` as a **native JSON array** — one object per slice. Do NOT JSON.stringify the array into a string; the tool validates that `tasks` is an array, and a serialized string will be rejected with "must be array".

## Execution Protocol

1. Call `subagent` with `tasks: [{ agent: "{{scoutAgentType}}", task: "<prompt>" }, ...]` containing one entry per slice below
2. Wait for ALL subagents to complete
3. Verify each slice's RESEARCH file was written (check `.gsd/milestones/{{mid}}/slices/<slice-id>/`)
4. If a subagent failed to write its RESEARCH file, retry it **once** individually
5. If it fails a second time, write a partial RESEARCH file for that slice with a `## BLOCKER` section explaining the failure — do NOT retry again
6. Report which slices completed research and which (if any) needed a blocker note

**Important**: Each failed slice gets exactly one retry. After that, write the blocker and move on. Never retry the same slice more than once.

## Subagent Prompts

{{subagentPrompts}}
