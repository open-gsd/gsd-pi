import type { Agent } from "@gsd/pi-agent-core";
import { createInitialSystemMessage, toToolDeclaration } from "@gsd/pi-ai";

/** Update the agent transcript system prompt (state.systemPrompt is read-only in v1.6.1). */
export function setAgentSystemPrompt(agent: Agent, systemPrompt: string): void {
	const messages = agent.state.messages.slice();
	const tools = agent.state.tools.map((tool) => toToolDeclaration(tool));
	const systemMessage = createInitialSystemMessage(systemPrompt, tools);
	if (messages[0]?.role === "system") {
		if (systemMessage) {
			messages[0] = systemMessage;
		} else {
			messages.shift();
		}
	} else if (systemMessage) {
		messages.unshift(systemMessage);
	}
	agent.state.messages = messages;
}