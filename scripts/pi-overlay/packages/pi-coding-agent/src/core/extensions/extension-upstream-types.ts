export type { Extension, ExtensionEvent, ExtensionHandler } from "./types.js";

export type GsdProgressWidgetMode = "min" | "small" | "full";

export interface GsdProgressState {
	phase: string;
	modeTag?: "AUTO" | "NEXT";
	taskProgress?: { done: number; total: number };
	sliceProgress?: { done: number; total: number };
	sliceLabel?: string;
	taskLabel?: string;
	unitLabel?: string;
	elapsed?: string;
	eta?: string;
	model?: string;
	dynamicRoutingTier?: "light" | "standard" | "heavy";
	healthSummary?: string;
	path?: string;
	widgetMode?: GsdProgressWidgetMode;
}
