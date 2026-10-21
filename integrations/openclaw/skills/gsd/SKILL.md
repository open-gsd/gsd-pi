---
name: gsd
description: Use GSD Pi MCP tools for planning, execution, status, questions, and recovery in the selected project.
---

# GSD

Use GSD's MCP tools for structured delivery. Resolve the actual execution
checkout selected in OpenClaw, including a managed worktree when present.
Pass that absolute `projectDir` consistently; it must exist on the MCP server's
host. Do not substitute the source checkout for a selected worktree or remote
place.

Read `gsd_progress` or `gsd_query` for project state. Check `gsd_status` before
starting another run; worktrees of one repository can share GSD state.
Start authorized work with `gsd_execute`, inspect it with `gsd_status` and
`gsd_result`, answer authorized questions with `gsd_resolve_blocker`, and stop
execution with `gsd_cancel`. An ambiguous transport error is not evidence that
execution stopped. Use GSD's documented recovery tools and respect intentional
stops and required user input.

A returned session ID or completed agent turn is not proof the objective is
finished. Check GSD's results and the requested acceptance criteria.
Registration, TaskFlow, Workboard, and heartbeat status data are handled by
plugin code and require no agent bookkeeping. Those records describe workflow
progress; they do not supervise or restart the external GSD process.
