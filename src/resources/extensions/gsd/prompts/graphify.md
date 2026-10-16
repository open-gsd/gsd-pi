You are running the GSD **graphify** workflow — build, query, and inspect a lightweight project knowledge graph. The graph lives in `.gsd/knowledge/` and is grounded in CODEBASE.md and project memories.

## Action

{{action}}

## Tool and scope preflight

This is an agent-run workflow, not a built-in deterministic graph engine or an installation of an external Graphify package.

- Read project instructions and any relevant graph skill first. If a documented project graph tool/adapter exists, use its supported actions, artifact schema, provenance, and annotation rules instead of manually reconstructing its output.
- Respect the current unit's permissions. A read-only caller must not install tools, rebuild, or rewrite graph files; report missing/stale data and use bounded source inspection or request a permitted refresh. Do not loop on failed builds.
- Declare the input scope and omissions. A truncated CODEBASE.md is not a complete inventory. State whether untracked files were included; absence from an index is not evidence that code does not exist.

## Process

The knowledge graph is a set of Markdown + a JSON edge index under `.gsd/knowledge/`:

- `nodes.md` — entities discovered in the codebase (modules, services, data models, external integrations), each with a stable id, type, file path, and one-line description.
- `edges.json` — relationships between nodes (`depends-on`, `calls`, `implements`, `produces`, `consumes`).

Parse the action:

- **build** (default when no action): Use the documented project tool when present; otherwise scan the declared source scope and CODEBASE.md and refresh `nodes.md` and `edges.json`. Preserve stable ids and human annotations. Record HEAD plus source-state evidence for the scanned inputs (for example, an input fingerprint and coverage record), not just the commit. Do not replace the previous valid graph after a failed or interrupted build.
- **query <term>**: Check freshness first; report stale/unknown provenance rather than presenting old relationships as current. Look up a narrowly scoped term and print a bounded set of direct relationships (one hop), with source paths and line/symbol anchors when available. State any output limit and, when known, the omitted count instead of dumping the entire graph.
- **status**: Print node counts by type, edge counts by relationship, build commit, input scope, and freshness. Check relevant source state as well as HEAD: edits, additions, or deletions can occur without a commit. Missing source-state evidence means freshness is unknown, not fresh.
- **diff**: Compare the recorded build revision and input state with current scoped sources, including uncommitted changes. Report added/removed/changed nodes with supporting paths; distinguish known node changes from prospective changes that require extraction.

Ground extraction in real code. Do not invent nodes. When the codebase has no CODEBASE.md, suggest running `/gsd codebase generate` first.

## Evidence and preservation

- Ground every node and edge in source evidence. Imports establish `depends-on`, not `calls`; a call edge needs call-site evidence, and inferred targets must be labeled as such. Static relationships are not proof of execution, authorization, deployment, or lifecycle completion.
- Preserve project-owned schemas and annotations. If markers or metadata are malformed, report the problem instead of silently overwriting human notes. Publish only after successful extraction and a final source-state check; keep the previous valid graph on failure.
- Keep credentials, private assets, and unrelated runtime artifacts outside graph inputs. Do not copy raw payloads or secrets into graph output.

## Success criteria

- Nodes and edges are backed by real file evidence.
- The graph lives under `.gsd/knowledge/`.
- Query/status/diff give accurate, evidence-backed answers.
- Stale or unknown provenance is reported even when HEAD has not changed.
- Existing project graph tooling, annotations, input boundaries, and read-only permissions are respected.
