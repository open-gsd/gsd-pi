# C03-A compatibility record: Graphify v0.9.97

## Scope and evidence posture

This is the read-only provider-side feasibility record requested by [C03 in #2956](https://github.com/open-gsd/gsd-pi/issues/2956), under the [#2953 Graphify umbrella](https://github.com/open-gsd/gsd-pi/issues/2953).

It records a candidate release and its published/source interfaces; it does not select an integration route, accept a runtime contract, or authorize implementation.

Evidence is limited to the exact public GitHub release/tag and PyPI metadata checked on 2026-10-29. No provider package was installed, no graph was extracted or queried, and no model/API was invoked. No credentials, private source, or customer data were used.

Therefore, this record contains no captured provider output or runtime-verified capability claim.

Context7 resolved `/graphify-labs/graphify`, but the retrieved snippets pointed to the repository's `v8` branch, not release `v0.9.97`.

Those snippets were used only to discover candidate documentation. The compatibility statements below are grounded in the pinned `v0.9.97` source and release metadata instead.

## Candidate version and package

| Item | Observed value | Evidence class |
| --- | --- | --- |
| Source tag | `v0.9.97` | GitHub release metadata |
| Source commit | `0a8cd4e1e342235fe53e881fb5d591bf0460071f` | Dereferenced annotated Git tag |
| Release date | 2026-10-27 18:15:39 UTC | GitHub release metadata |
| PyPI distribution | `graphifyy==0.9.97` | PyPI project JSON and tagged `pyproject.toml` |
| Python floor | `>=3.10` | Tagged package metadata |
| Console entry points | `graphify` and `graphify-mcp` | Tagged `pyproject.toml` |

The distribution name is **`graphifyy`** (double “y”); the CLI name is `graphify`. The package declares NetworkX, NumPy, RapidFuzz, PyYAML, and numerous Tree-sitter language packages as base dependencies.

MCP support is optional: the `mcp` extra adds MCP, Starlette, and AnyIO. This is a material dependency footprint, not a lightweight JSON-only library.

The README documents `uv tool install graphifyy` and a subsequent `graphify install` step. The latter registers assistant skills and writes project or user configuration.

Building or extracting a graph writes `graphify-out/graph.json` and related output. Neither installation nor extraction was run here.

## Interface and graph format

The tagged package declares `graphify-mcp` as an MCP server entry point. Its source registers graph tools including `query_graph`, `get_node`, `get_neighbors`, `get_community`, `god_nodes`, `graph_stats`, and `shortest_path`.

It also registers `list_prs`, `get_pr_impact`, and `triage_prs`. These latter tools use `gh` to retrieve PR metadata and files, so they perform external GitHub reads through ambient CLI authentication. They are not just local graph queries. Do not expose the full tool set by default without a separate C04 decision.

The MCP graph selector accepts an optional caller-supplied `project_path` and maps it to `<project_path>/<GRAPHIFY_OUT>/graph.json`.

This is a provider routing convenience, not an authorization or repository/worktree binding boundary. GSD would have to own and validate the trusted root and selected index identity under any future C02 contract.

The tagged exporter serializes a NetworkX node-link graph (`nodes` and `links`) and records `graph.schema_version` (currently `1`) and `graph.graphify_version`; when available, it also records `built_at_commit`.

The provider's `graph_stats` path compares the recorded commit to the current Git `HEAD` and can report that the graph may be stale. In the inspected MCP path, I found no dirty-working-tree check or per-file completeness contract. A matching commit therefore must not be interpreted as proof that uncommitted or untracked sources are represented.

The README claims extracted `calls`, `imports`, `inherits`, and `mixes_in` links across supported languages. The package also declares Tree-sitter TypeScript support.

These are version-pinned provider claims, not validation against the C07-A fixture. No v0.9.97 graph output was captured, so actual call/import precision, dynamic-reference behavior, false negatives, and output compatibility remain unverified.

## Data flow, privacy, and side effects

The release README describes code parsing as local Tree-sitter AST extraction without an LLM call. The security document says semantic extraction of documents/media may send content to a configured model/backend.

It also documents explicit outbound URL ingestion and an opt-in HTTP MCP transport. These are upstream disclosures, not network observations from this work.

The MCP stdio transport reads a graph file and local report/label sidecars. The graph query handler also calls `querylog.log_query`.

Logging is off by default. Ambient `GRAPHIFY_QUERY_LOG=<path>` or `GRAPHIFY_QUERY_LOG_ENABLE=1` enables append-only plaintext JSONL containing the query and corpus path. `GRAPHIFY_QUERY_LOG_RESPONSES=1` additionally stores the full response. The default enabled log path is `~/.cache/graphify-queries.log`, outside repository ignore and retention rules.

The inspected query path does not mutate `graph.json`, but an enabled query log is still a filesystem write. PR tools can make authenticated GitHub reads through `gh`; the package says it does not store API credentials, which does not remove that ambient identity boundary. HTTP transport is a separate network service and must not be enabled implicitly.

The following distinction is required for any future probe:

- **Read/query:** may load or reload the chosen graph; an inherited opt-in query-log environment can write plaintext query records; PR-specific tools can perform GitHub reads.
- **Install:** changes assistant configuration and installs a separate tool environment.
- **Extract/build/update:** writes graph output and may run other configured semantic or ingestion paths.

Only an explicitly scoped code-only probe could test the first provider claim. Do not infer its safety from `shell: false`, the stdio transport, or a read-only-looking tool name.

## License and distribution note

The tagged `pyproject.toml` declares Apache-2.0 and includes `LICENSE`, `LICENSE-MIT`, and `NOTICE`. `LICENSE` and `NOTICE` identify Apache-2.0. `NOTICE` explains that portions contributed under MIT before relicensing remain available under those terms, with the original text retained in `LICENSE-MIT`.

PyPI's 0.9.97 JSON reports `license_expression=Apache-2.0`; its legacy `info.license` field is null. The machine-readable SPDX expression therefore agrees with the tagged package metadata. This note does not audit transitive dependency licenses or replace a redistribution review. No dependency was vendored by this contribution.

## C03-A findings and unresolved questions

1. A versioned, optional MCP interface exists, with a separately versioned graph format. This establishes a candidate for feasibility review, not a selected route.
2. The graph records a build commit and the server can compare it with `HEAD`; dirty-tree state, untracked inputs, coverage completeness, and independent worktree/index identity were not established by the inspected query surface.
3. The MCP surface includes provider-specific PR operations that use ambient `gh` authentication. A future adapter must not blindly register all provider tools.
4. Provider documentation claims code-only local extraction; no execution or data-flow probe was performed to verify that claim for this release.
5. No captured v0.9.97 output was available to validate the C07-A expected calls/imports or the actual graph JSON envelope. The open [C07-A fixture PR #3039](https://github.com/open-gsd/gsd-pi/pull/3039) remains source-oracle evidence only.
6. No consumer gap, route, trusted configuration owner, or accepted C02 contract is decided here. R0/R1/R2 and any integration placement remain open.

A separately authorized, credential-free code-only probe against the public C07-A fixture would be required to confirm runtime output, parser semantics, freshness, coverage, filesystem effects, and process shutdown.

Until then, treat those as unknown. Do not install the package, invoke extraction, enable HTTP MCP, or implement an adapter as part of this phase-A record.

## Sources

- [Graphify v0.9.97 release](https://github.com/Graphify-Labs/graphify/releases/tag/v0.9.97)
- [Pinned v0.9.97 source tree](https://github.com/Graphify-Labs/graphify/tree/v0.9.97)
- [Tagged package metadata and optional MCP dependencies](https://github.com/Graphify-Labs/graphify/blob/v0.9.97/pyproject.toml)
- [Tagged graph exporter](https://github.com/Graphify-Labs/graphify/blob/v0.9.97/graphify/export.py)
- [Tagged MCP server and tool handlers](https://github.com/Graphify-Labs/graphify/blob/v0.9.97/graphify/serve.py)
- [Tagged MCP query logging](https://github.com/Graphify-Labs/graphify/blob/v0.9.97/graphify/querylog.py)
- [Tagged security policy](https://github.com/Graphify-Labs/graphify/blob/v0.9.97/SECURITY.md)
- [Tagged README](https://github.com/Graphify-Labs/graphify/blob/v0.9.97/README.md)
- [PyPI package metadata](https://pypi.org/project/graphifyy/0.9.97/)
- [C03 issue #2956](https://github.com/open-gsd/gsd-pi/issues/2956) and [umbrella #2953](https://github.com/open-gsd/gsd-pi/issues/2953)
