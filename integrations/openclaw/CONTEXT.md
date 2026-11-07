# CONTEXT — open-gsd-openclaw

- Manifest: GSD's existing stdio MCP server, optional usage skill, explicit
  startup activation. No custom MCP tools or plugin-specific configuration.
- `src/discovery.ts`: event-only discovery from GSD's existing project registry
  and OpenClaw workspace/session directories. Filesystem/session events trigger
  reads; no timers or custom project registry.
- `src/sync.ts`: public GSD progress reads, native project registration, checked
  idempotent optional Workboard cards, and optimistic card-version checks. One
  observation card per canonical GSD state directory retains bounded progress
  and database provenance in a managed notes block. No Tasks/TaskFlow runtime
  APIs or fake execution backing. Without Workboard, observations are memory-only.
- `src/index.ts`: Gateway service lifecycle and public SDK wiring. Default
  agent/main-session operator ownership. Factual heartbeat context/events, no
  custom recovery instructions or scheduled prompts. The public authenticated
  Gateway client preserves operator authorization for native registry writes.
- Execution/recovery: GSD owns these. Neither filesystem observers nor durable
  cards can detect an entirely silent hang. Archiving a card stops its
  synchronization, not the external process; `gsd_cancel` stops GSD.

The package remains under integrations beside Hermes, built separately from
`build:core` and published by the existing release list. No engine changes.
The installed-host test verifies actual automatic synchronization, not manually
created records or model adherence to the skill. Preserve revision conflicts,
permission failures, archived records, and optional Workboard behavior.
