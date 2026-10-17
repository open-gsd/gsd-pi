You are running the GSD **graphify** workflow — build, query, and inspect a lightweight project knowledge graph. The graph lives in `.gsd/knowledge/` and is grounded in CODEBASE.md and project memories.

## Action

{{action}}

## Process

The knowledge graph is a set of Markdown + a JSON edge index under `.gsd/knowledge/`:

- `nodes.md` — entities discovered in the codebase (modules, services, data models, external integrations), each with a stable id, type, file path, and one-line description.
- `edges.json` — relationships between nodes (`depends-on`, `calls`, `implements`, `produces`, `consumes`).

Parse the action:

- **build** (default when no action): Re-scan the codebase and CODEBASE.md, extract nodes and edges, and write/refresh `nodes.md` and `edges.json`. Prepare both files before writing either — if the build fails partway, keep the previous pair rather than leaving a partial graph. Preserve human-added annotations where possible. Stamp the build with the current HEAD commit, noting whether the working tree was dirty or had untracked sources at build time.
- **query <term>**: Look up nodes matching the term and print their direct relationships (one hop). Show the evidence (file path) for each edge.
- **status**: Print graph stats — node count by type, edge count by relationship, last build commit. Say if the graph is stale: HEAD moved since the last build, or `git status --porcelain` / `git diff --name-only <last build commit>` shows uncommitted or untracked changes to graph-relevant sources — CODEBASE.md, the file paths behind existing nodes, and newly added source files (they are not in the graph yet). If the graph does not record which sources it covered, or was built from a dirty tree, report freshness as unknown instead of declaring it current.
- **diff**: Compare the current codebase against the last build commit — HEAD movement plus uncommitted working-tree changes (`git diff --name-only <last build commit>`, `git status --porcelain`) — and report added/removed/changed nodes as a drift report.

Ground extraction in real code. Do not invent nodes. Edges are static source facts, not runtime evidence: an `import` alone is not a `calls` edge — `calls` requires an actual call site as evidence. When the codebase has no CODEBASE.md, suggest running `/gsd codebase generate` first.

## Success criteria

- Nodes and edges are backed by real file evidence.
- The graph lives under `.gsd/knowledge/`.
- Query/status/diff give accurate, evidence-backed answers.
- Stale graphs are detected and reported.
