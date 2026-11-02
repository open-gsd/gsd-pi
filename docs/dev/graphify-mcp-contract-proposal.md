# Native Graphify Context Across TUI and MCP: C02 Proposal

**Status:** Proposal for maintainer review under [#2953](https://github.com/open-gsd/gsd-pi/issues/2953), C02. No runtime contract or implementation is accepted by this document.

## Direction

The operator's direction is to keep GSD's native `/gsd graphify` workflow, make VS Code an important first-class integration, and define a host-neutral MCP surface that other MCP-capable platforms can adopt. GSD's own TUI should retain its native route. A platform without MCP support would need its own adapter.

The `graphifyy==0.9.97` report in [#3041](https://github.com/open-gsd/gsd-pi/pull/3041) concerns an optional third-party Graphify-Labs provider. It is not a prerequisite for native Graphify or for the proposed MCP contract. The known-answer fixture in [#3039](https://github.com/open-gsd/gsd-pi/pull/3039) is a test oracle, not provider-accuracy or client-adoption evidence.

## Current Contract Boundaries

The following source references are pinned to upstream `main` at `f2756216ccf6bbe9af2fc677f5eafef986727e4e`:

- [`bootstrap/system-context.ts`](https://github.com/open-gsd/gsd-pi/blob/f2756216ccf6bbe9af2fc677f5eafef986727e4e/src/resources/extensions/gsd/bootstrap/system-context.ts#L373-L454) assembles native system context, including bounded `CODEBASE.md` content. It can also refresh that map before dispatch ([lines 407–414](https://github.com/open-gsd/gsd-pi/blob/f2756216ccf6bbe9af2fc677f5eafef986727e4e/src/resources/extensions/gsd/bootstrap/system-context.ts#L407-L414)); it is not inherently a read-only export API.
- [`provider-payload-policy.ts`](https://github.com/open-gsd/gsd-pi/blob/f2756216ccf6bbe9af2fc677f5eafef986727e4e/src/resources/extensions/gsd/provider-payload-policy.ts#L131-L140) injects active-unit source observations into native auto-mode provider payloads. Neither path is an external-client context API.
- [`commands-gsd-core.ts`](https://github.com/open-gsd/gsd-pi/blob/f2756216ccf6bbe9af2fc677f5eafef986727e4e/src/resources/extensions/gsd/commands-gsd-core.ts#L421-L430) dispatches `/gsd graphify`; [`prompts/graphify.md`](https://github.com/open-gsd/gsd-pi/blob/f2756216ccf6bbe9af2fc677f5eafef986727e4e/src/resources/extensions/gsd/prompts/graphify.md#L9-L27) describes the native workflow and its `.gsd/knowledge` artifacts. This is not yet a typed, versioned source-provider contract.
- MCP [`gsd_execute`](https://github.com/open-gsd/gsd-pi/blob/f2756216ccf6bbe9af2fc677f5eafef986727e4e/packages/mcp-server/src/server.ts#L1253-L1282) returns a startup receipt (`sessionId`, started status, and connection-lifetime guidance). Separate [`gsd_result`](https://github.com/open-gsd/gsd-pi/blob/f2756216ccf6bbe9af2fc677f5eafef986727e4e/packages/mcp-server/src/server.ts#L1312-L1328) calls expose managed-session status/events. Neither returns an assembled Graphify source-context object; do not overload execution metadata or incidental event text as a context-export API.
- Native [`gsd_graph`](https://github.com/open-gsd/gsd-pi/blob/f2756216ccf6bbe9af2fc677f5eafef986727e4e/src/resources/extensions/gsd/bootstrap/memory-tools.ts#L122-L128) exposes memory relationships. The MCP workflow graph in [`server.ts`](https://github.com/open-gsd/gsd-pi/blob/f2756216ccf6bbe9af2fc677f5eafef986727e4e/packages/mcp-server/src/server.ts#L1729-L1753) operates on `.gsd/graphs/graph.json`. Neither establishes Graphify source-call evidence.

The current Graphify command also has a write-safety concern: [`handleGraphify()`](https://github.com/open-gsd/gsd-pi/blob/f2756216ccf6bbe9af2fc677f5eafef986727e4e/src/resources/extensions/gsd/commands-gsd-core.ts#L420-L427) creates `.gsd/knowledge` before query/status dispatch. A prompt instruction to avoid writes is not a substitute for a read-only provider boundary. Any future read query must be side-effect-free, including when the index is absent.

## Proposed Provider and MCP Surface

**Proposal:** define one GSD-owned native source-context provider and reuse it from the TUI and an optional MCP tool. Keep the provider independent of VS Code. Do not require Graphify-Labs or another external package.

The MCP API should be a separate, bounded read operation (provisional name: `gsd_source_context`). Do not add source context to `gsd_execute` session metadata or depend on incidental event text. Final tool name and schema remain subject to maintainer review.

Workspace authorization must be distinct from execution-session state. Before reads are enabled, the MCP server must hold a host-owned, explicitly authorized binding to exactly one canonical workspace/worktree; a `gsd_execute` session is not required for deterministic context reads. The exact host-side bind mechanism is proposed for maintainer review, but a tool request must never supply its own authoritative filesystem root. Reject absent, ambiguous, or mismatched bindings without reading. Canonicalize the bound root and every resolved source path, and reject symlink escapes. Separate worktrees require separate bindings; do not fall back to process CWD or ambient filesystem access.

A versioned response should make evidence and limitations explicit. At minimum it should distinguish:

- result state: ready, partial, stale, not indexed, unsupported, or error;
- provider/index version and the source snapshot identity available to the provider;
- whether the snapshot is dirty, incomplete, or of unknown freshness;
- evidence facts with repository-relative source anchors and line ranges;
- unresolved targets and coverage limitations;
- truncation/output-budget status and actionable warnings.

Unknown provenance must remain unknown; it must not be reported as fresh. A missing or stale index must not be represented as an empty result or “no callers.” Raw source excerpts are out of scope by default; any excerpt mode requires explicit consent, redaction rules, and a separate output budget.

## Trust, Privacy, and Read-Only Requirements

Before runtime exposure, maintainers should accept these minimum safeguards:

1. Establish an explicit host-owned workspace/worktree binding independent of `gsd_execute`; require one canonical root, reject missing/ambiguous bindings, forbid client-supplied root overrides, and reject symlink escapes.
2. Make query/status calls strictly read-only. Do not build, refresh, create directories, or mutate graph artifacts during a read. Index creation remains an explicit operation with its own approval and status.
3. Define eligible source roots and exclusions before exposure. Exclude secrets, credentials, private assets, generated indexes, and ignored paths by default; apply the policy to graph facts, labels, anchors, warnings, and provider diagnostics, not only optional excerpts. Specify how dirty, untracked, deleted, unsupported, stale, and incomplete coverage is reported.
4. Treat repository paths, symbols, graph labels, source-derived text, and provider messages as untrusted data, never as instructions or authorization. They must not trigger tools, widen the bound scope, or authorize additional reads.
5. Return repository-relative anchors; do not expose absolute paths or source contents by default. Any optional excerpt mode requires explicit consent, redaction rules, and a separate output budget.
6. Do not log raw source text or query contents. Bound result size, traversal, and duration; honor cancellation and sanitize errors.
7. Reject missing, stale, partial, unsupported, or filtered coverage explicitly. Never silently represent unavailable facts as “no callers” or claim a complete graph.
8. Preserve equivalent facts and error distinctions through the native TUI route and MCP result; do not imply that one client has broader authority than another.

## Host Integration

- **GSD TUI:** retain `/gsd graphify` as the native interaction and route it through the shared provider if maintainers accept that design.
- **VS Code:** first-class client acceptance matters. A VS Code adapter should be thin and call the shared MCP contract rather than own a separate graph implementation.
- **Other MCP hosts and TUIs:** may integrate through the same protocol contract. A successful VS Code test proves only that client path; claim broader interoperability only for clients actually tested.
- **Non-MCP platforms:** need a platform-specific adapter and are not covered by the MCP contract alone.

## Acceptance Strategy

Use the #3039 known-answer fixture. Contract and provider tests should verify that both expected direct `formatLabel` calls are returned, the import-only reference is not promoted to a call, and dynamic dispatch remains unresolved. Cover the fixture's dirty, untracked, deleted, configuration-change, and other declared boundaries without representing missing coverage as a negative fact.

The test sequence should be:

1. **Native provider/TUI:** compare normalized facts to the known-answer oracle; prove query/status do not write, including the absent-index case; distinguish stale and partial results. Prove missing/ambiguous workspace bindings and cross-worktree/symlink escapes are rejected, and excluded sensitive files or instruction-like graph text cannot leak or widen authority.
2. **MCP protocol:** exercise stdio initialization, tool discovery, and tool invocation. Validate the versioned schema, authorized workspace binding, source anchors, exclusion policy, bounded output, cancellation, errors, and parity with the native result. This deterministic read must not require model inference or a `gsd_execute` session.
3. **VS Code:** verify an actual client discovers and consumes the fixture facts and anchors, not merely that configuration or tool registration exists. Test the native extension route separately if it uses a distinct path.
4. **Broader claims:** add at least one unrelated MCP client before claiming cross-platform compatibility; name and version every client tested.

These are proposed acceptance checks, not completed proof. The #3039 integrity tests alone do not prove provider accuracy, protocol delivery, or client consumption.

## Decisions Requested

Maintainers should record the following before a runtime integration PR:

1. **Placement:** retain R0 if native TUI and host source-read routes meet the need; evaluate an opt-in R1 host-neutral MCP companion if the VS Code pilot shows a material gap; choose R2 core execution changes only if the existing seam cannot satisfy the accepted contract.
2. **Binding:** accept the host-owned workspace/worktree authority rule,
   independent of whether a `gsd_execute` session is active, and define the
   source snapshot identity available to the provider.
3. **Privacy/consent:** decide whether source-context calls require project-level and/or per-request opt-in, and approve path redaction, logging, and excerpt policy.
4. **Coverage:** define how dirty, untracked, ignored, generated, deleted, stale, and unsupported source is represented.
5. **Compatibility:** accept the versioning and client-test bar before claiming broad platform support.

**Recommendation:** use native GSD Graphify as the provider, keep the current TUI route intact, and prefer an optional host-neutral MCP companion before changing `gsd_execute`. Keep Graphify-Labs optional. Do not start runtime exposure until the decisions above are accepted; the operator has authorized preparing the extension PR once that gate is met.
