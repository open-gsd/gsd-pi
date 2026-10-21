You are running the GSD **graphify** workflow — build, query, and inspect a lightweight project knowledge graph. The graph lives in `.gsd/knowledge/` and is grounded in CODEBASE.md and project memories.

## Action

{{action}}

## Process

The knowledge graph is a set of Markdown + a JSON edge index under `.gsd/knowledge/`:
- `nodes.md` — entities discovered in the codebase (modules, services, data models, external integrations), each with a stable id, type, file path, and one-line description.
- `edges.json` — relationships between nodes (`depends-on`, `calls`, `implements`, `produces`, `consumes`).

Parse the action:

- **build** (default when no action): Re-scan the codebase and CODEBASE.md, extract nodes and edges, and write/refresh `nodes.md` and `edges.json`. Preserve human-added annotations where possible. Stamp the build with the current HEAD commit.
- **query <term>**: Look up nodes matching the term and print their direct relationships (one hop). Show the evidence (file path) for each edge.
- **status**: Print graph stats — node count by type, edge count by relationship, last build commit. Say if the graph is stale (HEAD moved since last build).
- **diff**: Compare the current codebase HEAD against the last build commit and report added/removed/changed nodes — a drift report.

Ground extraction in real code. Do not invent nodes. When the codebase has no CODEBASE.md, suggest running `/gsd codebase generate` first.

## Success criteria

- Nodes and edges are backed by real file evidence.
- The graph lives under `.gsd/knowledge/`.
- Query/status/diff give accurate, evidence-backed answers.
- Stale graphs are detected and reported.
