// Project/App: gsd-pi
// File Purpose: Resolve how workflow units should ask the user for input.

import { parseMcpToolName, toMcpToolName } from "./mcp-tool-name.js";

export type StructuredQuestionsFlag = "true" | "false";

export interface QuestionTransportOptions {
  activeTools: string[];
  authMode?: "apiKey" | "oauth" | "externalCli" | "none";
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}

export interface QuestionTransportResolution {
  structuredQuestionsAvailable: StructuredQuestionsFlag;
  questionToolAvailable: boolean;
  usesWorkflowMcp: boolean;
  reason: "question-tool-available" | "question-tool-missing" | "workflow-mcp-disabled";
}

export interface WorkflowQuestionToolSurfaceOptions {
  workflowServerName?: string;
  workflowExplicitlyBlocked?: boolean;
  workflowMcpTools: string[];
  exactWorkflowMcpTools: string[];
  env?: NodeJS.ProcessEnv;
}

export interface WorkflowQuestionToolSurfaceResolution extends QuestionTransportResolution {
  questionToolName?: string;
  workflowQuestionsEnabled: boolean;
  disallowedTools: string[];
}

function isWorkflowMcpServerName(serverName: string): boolean {
  const normalized = serverName.toLowerCase();
  return normalized === "gsd" || normalized.includes("workflow");
}

export function usesWorkflowMcpTransport(
  authMode: QuestionTransportOptions["authMode"],
  baseUrl: string | undefined,
): boolean {
  return authMode === "externalCli" && typeof baseUrl === "string" && baseUrl.startsWith("local://");
}

export function hasAskUserQuestionsTool(activeTools: string[]): boolean {
  return activeTools.some((toolName) => {
    if (toolName === "ask_user_questions") return true;
    const mcp = parseMcpToolName(toolName);
    if (!mcp) return false;
    if (mcp.toolName === "ask_user_questions") return true;
    return mcp.toolName === "*" && isWorkflowMcpServerName(mcp.serverName);
  });
}

function workflowMcpStructuredQuestionsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.GSD_WORKFLOW_MCP_STRUCTURED_QUESTIONS?.trim().toLowerCase();
  return value !== "0" && value !== "false" && value !== "off";
}

export function resolveQuestionTransport(
  options: QuestionTransportOptions,
): QuestionTransportResolution {
  const questionToolAvailable = hasAskUserQuestionsTool(options.activeTools);
  const usesWorkflowMcp = usesWorkflowMcpTransport(options.authMode, options.baseUrl);

  if (!questionToolAvailable) {
    return {
      structuredQuestionsAvailable: "false",
      questionToolAvailable,
      usesWorkflowMcp,
      reason: "question-tool-missing",
    };
  }

  if (options.authMode === "externalCli" && !workflowMcpStructuredQuestionsEnabled(options.env)) {
    return {
      structuredQuestionsAvailable: "false",
      questionToolAvailable,
      usesWorkflowMcp,
      reason: "workflow-mcp-disabled",
    };
  }

  return {
    structuredQuestionsAvailable: "true",
    questionToolAvailable,
    usesWorkflowMcp,
    reason: "question-tool-available",
  };
}

export function supportsStructuredQuestions(
  activeTools: string[],
  options: Omit<QuestionTransportOptions, "activeTools"> = {},
): boolean {
  return resolveQuestionTransport({
    ...options,
    activeTools,
  }).structuredQuestionsAvailable === "true";
}

/**
 * Appended to discuss prompts when the user configured
 * `discussion.question_mode: chat` (#2979). The template's
 * `structuredQuestionsAvailable: false` branch already asks for plain-text
 * questions; this note tells the model to stay on that path even though the
 * `ask_user_questions` tool remains on the surface (it must remain — the
 * workflow-MCP readiness check requires it, which is exactly what breaks when
 * the env var removes it). Empty for the default dialog mode.
 */
export function discussionChatPromptNote(
  questionMode: "dialog" | "chat",
  structuredQuestionsAvailable: string,
): string {
  if (questionMode !== "chat" || structuredQuestionsAvailable !== "false") return "";
  return [
    "## Chat-mode discussions",
    "",
    "This project runs discussions in plain chat (`discussion.question_mode: chat`).",
    "Ask your questions as numbered plain-text messages and end the turn; the user answers in the normal chat.",
    "Do NOT call `ask_user_questions` for these interviews — the tool stays available for other flows, but the user has asked for plain-chat discussions.",
    "The depth-verification gate still applies on the plain-text path: before writing the final artifact, ask for explicit confirmation in plain text and wait for it. No response, ambiguity, or a non-confirmation means re-ask — never write without it.",
  ].join("\n");
}

export function resolveWorkflowQuestionToolSurface(
  options: WorkflowQuestionToolSurfaceOptions,
): WorkflowQuestionToolSurfaceResolution {
  const questionToolName = options.workflowServerName && !options.workflowExplicitlyBlocked
    ? toMcpToolName(options.workflowServerName, "ask_user_questions")
    : undefined;
  const activeTools = [
    ...options.exactWorkflowMcpTools,
    ...options.workflowMcpTools,
    ...(questionToolName ? [questionToolName] : []),
  ];
  const transport = resolveQuestionTransport({
    activeTools,
    authMode: "externalCli",
    baseUrl: "local://claude-code",
    env: options.env,
  });
  const exactQuestionToolAllowed =
    !!questionToolName && options.exactWorkflowMcpTools.includes(questionToolName);
  const workflowQuestionsEnabled =
    transport.structuredQuestionsAvailable === "true" &&
    (options.workflowMcpTools.length > 0 || exactQuestionToolAllowed);
  const disallowedTools =
    options.workflowServerName && transport.questionToolAvailable && !workflowQuestionsEnabled
      ? [toMcpToolName(options.workflowServerName, "ask_user_questions")]
      : [];

  return {
    ...transport,
    questionToolName,
    workflowQuestionsEnabled,
    disallowedTools,
  };
}
