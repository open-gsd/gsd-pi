export { main } from "./main.js";
export { parseArgs, type Args, printHelp } from "./cli/args.js";
export { InteractiveMode, type InteractiveModeOptions } from "./modes/interactive/interactive-mode.js";
export { type PrintModeOptions, runPrintMode } from "./modes/print-mode.js";
export { runRpcMode } from "./modes/rpc/rpc-mode.js";
export {
	type ModelInfo,
	RpcClient,
	type RpcClientOptions,
	type RpcEventListener,
} from "./modes/rpc/rpc-client.js";
export type {
	RpcCommand,
	RpcInitResult,
	RpcProtocolVersion,
	RpcResponse,
	RpcSessionState,
	RpcV2Event,
} from "./modes/rpc/rpc-types.js";
export { attachJsonlLineReader, serializeJsonLine } from "./modes/rpc/jsonl.js";
export {
	ArminComponent,
	AssistantMessageComponent,
	appKey,
	appKeyHint,
	BashExecutionComponent,
	BorderedLoader,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	CustomEditor,
	CustomMessageComponent,
	DynamicBorder,
	ExtensionEditorComponent,
	ExtensionInputComponent,
	ExtensionSelectorComponent,
	editorKey,
	FooterComponent,
	keyHint,
	LoginDialogComponent,
	ModelSelectorComponent,
	OAuthSelectorComponent,
	ProviderManagerComponent,
	type RenderDiffOptions,
	rawKeyHint,
	renderDiff,
	SessionSelectorComponent,
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
	ShowImagesSelectorComponent,
	SkillInvocationMessageComponent,
	ThemeSelectorComponent,
	ThinkingSelectorComponent,
	ToolExecutionComponent,
	type ToolExecutionOptions,
	TreeSelectorComponent,
	truncateToVisualLines,
	UserMessageComponent,
	UserMessageSelectorComponent,
	type VisualTruncateResult,
} from "./modes/interactive/components/index.js";
export {
	getLanguageFromPath,
	getMarkdownTheme,
	getSelectListTheme,
	getSettingsListTheme,
	highlightCode,
	initTheme,
	Theme,
	type ThemeColor,
	stopThemeWatcher,
} from "@gsd/pi-coding-agent/theme/theme.js";

// Native attention overview (#2932). Read-only: no mutation, approval or RPC authority.
export { AttentionOverlayController, type AttentionReader, type AttentionState } from "./modes/interactive/attention-overlay.js";
export { AttentionOverlayComponent, OVERLAY_MAX_HEIGHT_FRACTION, type AttentionKeybindings } from "./modes/interactive/attention-overlay-component.js";
export { createAttentionReader, type ReadSeam, type ReadRows, type AttentionSnapshotRead } from "./modes/interactive/attention-reader.js";
