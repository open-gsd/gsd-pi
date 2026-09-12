# CONTEXT — open-gsd-openclaw

- Manifest: GSD's existing stdio MCP server, optional usage skill, explicit
  startup activation. No custom MCP tools or plugin-specific configuration.
- `src/discovery.ts`: event-only discovery from GSD's existing project registry
  and OpenClaw workspace/session directories. Filesystem/session events trigger
  reads; no timers or custom project registry.
- `src/sync.ts`: public GSD progress reads, native project registration, checked
  TaskFlow writes, and idempotent optional Workboard cards. One observation flow
  per canonical GSD state directory, waiting for external events. GSD phase
  completion finishes the flow. No fake detached task/runtime backing.
- `src/index.ts`: Gateway service lifecycle and public SDK wiring. Default
  agent/main-session operator ownership. Factual heartbeat context/events, no
  custom recovery instructions or scheduled prompts. The public authenticated
  Gateway client preserves operator authorization for native registry writes.
- Execution/recovery: GSD owns these. Neither filesystem observers nor durable
  flow records can detect an entirely silent hang. Native flow cancellation
  stops observation, not the external process; `gsd_cancel` stops GSD.

The package remains under integrations beside Hermes, built separately from
`build:core` and published by the existing release list. No engine changes.
The installed-host test verifies actual automatic synchronization, not manually
created records or model adherence to the skill. Preserve revision conflicts,
permission failures, cancellation, and optional Workboard behavior.
