// Project/App: gsd-pi
// File Purpose: The in-process knowledge graph build (.gsd/graphs/graph.json)
// for slice completion and `gsd graph build`.

import { readKnowledgeMarkdown } from "./knowledge-projection.js";
import { readProjectQueryFromDb, readRoadmapFromDb } from "./state/external-reads-from-db.js";

/**
 * Build the knowledge graph and write graph.json. ADR-046: the milestone,
 * slice, task, state and knowledge nodes come from database rows, as in the
 * MCP `gsd_graph` build. The .gsd/ projections are parsed only when the
 * project has no openable database, and `source` says so.
 */
export async function rebuildKnowledgeGraph(
  basePath: string,
): Promise<{ nodeCount: number; edgeCount: number; source: "database" | "projection" }> {
  // The database reads start before the first await, so a caller that does
  // not wait (slice completion) reads the database that is open at the call.
  const roadmap = readRoadmapFromDb(basePath);
  const database = roadmap === null ? undefined : {
    milestones: roadmap.milestones,
    knowledge: readKnowledgeMarkdown(basePath),
    state: (await readProjectQueryFromDb(basePath, ["state"]))?.state ?? "",
  };
  // The package name (not a relative path) resolves through
  // package.json#exports in development and in production.
  const { buildGraph, writeGraph, resolveGsdRoot } = await import("@opengsd/mcp-server");
  const graph = await buildGraph(basePath, database);
  await writeGraph(resolveGsdRoot(basePath), graph);
  return {
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    source: database ? "database" : "projection",
  };
}
