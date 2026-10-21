declare module "@opengsd/mcp-server" {
  export interface GraphNode {
    type: string;
    label: string;
    confidence: string;
    [key: string]: unknown;
  }

  export interface GraphEdge {
    [key: string]: unknown;
  }

  export interface KnowledgeGraph {
    nodes: GraphNode[];
    edges: GraphEdge[];
    [key: string]: unknown;
  }

  export interface GraphStatusResult {
    exists: boolean;
    nodeCount: number;
    edgeCount: number;
    stale: boolean;
    ageHours?: number;
    lastBuild?: string;
  }

  export interface GraphQueryResult {
    nodes: GraphNode[];
    edges: GraphEdge[];
  }

  export interface GraphDiffResult {
    nodes: {
      added: unknown[];
      removed: unknown[];
      changed: unknown[];
    };
    edges: {
      added: unknown[];
      removed: unknown[];
    };
  }

  export function resolveGsdRoot(projectDir: string): string;
  export function buildGraph(projectDir: string): Promise<KnowledgeGraph>;
  export function writeGraph(gsdRoot: string, graph: KnowledgeGraph): Promise<void>;
  export function graphStatus(projectDir: string): Promise<GraphStatusResult>;
  export function graphQuery(projectDir: string, term: string): Promise<GraphQueryResult>;
  export function graphDiff(projectDir: string): Promise<GraphDiffResult>;

  export interface GenericMcpToolDef {
    name: string;
    label: string;
    description: string;
    parameters: Record<string, unknown>;
    execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      onUpdate?: unknown,
    ): Promise<{
      content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
      details?: Record<string, unknown>;
      isError?: boolean;
    }>;
  }

  export const GSD_MODE_MCP_WORKFLOW_ADAPTER_TOOL_NAMES: readonly string[];
  export function createWorkflowMcpAdapterToolDefs(): Promise<GenericMcpToolDef[]>;
}
