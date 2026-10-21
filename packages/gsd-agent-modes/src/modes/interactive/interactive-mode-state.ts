import type { ImageContent } from "@gsd/pi-ai";
import type { AgentSessionEvent } from "@gsd/agent-core";

import type { StreamingRenderState } from "./streaming-render-state.js";

export type { ExtensionUiSnapshot } from "@gsd/agent-core";
export { createEmptyExtensionUiSnapshot } from "@gsd/agent-core";

/**
 * Structural host passed into interactive controllers.
 * Uses `any` for TUI/session surfaces — same convention as InteractiveModeDelegateHost.
 */
export interface InteractiveModeStateHost {
	defaultEditor: any;
	editor: any;
	session: any;
	ui: any;
	footer: any;
	keybindings: any;
	statusContainer: any;
	chatContainer: any;
	pinnedMessageContainer: any;
	settingsManager: any;
	pendingTools: Map<string, any>;
	/**
	 * Active tool invocations keyed by toolCallId — dispatch/terminal tracking
	 * kept separate from pendingTools, which deliberately retains completed
	 * components for transcript reconstruction (#2925).
	 */
	activeToolInvocations: Set<string>;
	toolOutputExpanded: boolean;
	hideThinkingBlock: boolean;
	isBashMode: boolean;
	onInputCallback?: (text: string) => void;
	isInitialized: boolean;
	loadingAnimation?: any;
	activityLoader?: any;
	pendingWorkingMessage?: string | null;
	gsdProgressState?: { phase?: string; path?: string };
	clearBlockingError(): void;
	defaultWorkingMessage: string;
	streamingComponent?: any;
	streamingMessage?: any;
	retryEscapeHandler?: () => void;
	retryLoader?: any;
	autoCompactionLoader?: any;
	autoCompactionEscapeHandler?: () => void;
	compactionQueuedMessages: Array<{ text: string; mode: "steer" | "followUp" }>;
	extensionSelector?: any;
	extensionInput?: any;
	extensionEditor?: any;
	editorContainer: any;
	keybindingsManager?: any;
	pendingImages: ImageContent[];
	streamingRenderState: StreamingRenderState;
}

export type InteractiveModeEvent = AgentSessionEvent;
