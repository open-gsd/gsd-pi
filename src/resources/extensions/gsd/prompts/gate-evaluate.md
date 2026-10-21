# Quality Gate Evaluation — Parallel Dispatch

**Working directory:** `{{workingDirectory}}`
**Milestone:** {{milestoneId}} — {{milestoneTitle}}
**Slice:** {{sliceId}} — {{sliceTitle}}

## Mission

You are evaluating **quality gates in parallel** for this slice. Each gate is an independent question that must be answered before task execution begins. Use the `subagent` tool to dispatch all gate evaluations simultaneously.

**Tool call format:** Call `subagent` with `tasks: [...]` as a **native JSON array** — one object per gate. Do NOT JSON.stringify the array into a string; the tool validates that `tasks` is an array, and a serialized string will be rejected with "must be array".

## Slice Plan Context

{{slicePlanContent}}

## Gates to Evaluate

{{gateCount}} gates require evaluation:

{{gateList}}

## Execution Protocol

1. **Dispatch all gates** using `subagent` in parallel mode. Call `subagent` with `tasks: [{ agent: "tester", task: "<prompt>" }, ...]` — one object per gate. Each subagent prompt is provided below.
   Pass `tasks` as a **JSON array**, not a string. Example shape:

   ```json
   {
     "tasks": [
       { "agent": "tester", "task": "<Q3 prompt from below>" },
       { "agent": "tester", "task": "<Q4 prompt from below>" }
     ]
   }
   ```

2. **Wait for all subagents** to complete.
3. **Verify each gate wrote its result** by checking that `gsd_save_gate_result` was called for each gate ID.
   - Call it **directly** — do **not** use `ToolSearch` (it is not available in GSD).
   - Inside Claude Code use the active MCP-scoped workflow name for `gsd_save_gate_result`; otherwise use `gsd_save_gate_result`.
   - Always pass all required fields (camelCase): `milestoneId`, `sliceId`, `gateId`, `verdict`, `rationale`, and `findings` (empty string if none). Never call with an empty `{}` object.
4. **Report the batch outcome** — which gates passed, which flagged concerns, and which were omitted as not applicable.

Gate agents may return `verdict: "omitted"` if the gate question is not applicable to this slice (e.g., no auth surface for Q3, no existing requirements touched for Q4). This is expected for simple slices.

## Subagent Prompts

{{subagentPrompts}}
