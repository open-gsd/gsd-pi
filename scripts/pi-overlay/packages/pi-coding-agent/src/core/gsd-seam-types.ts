/**
 * Structural types shared across the pi-coding-agent ↔ @gsd/agent-core seam.
 * Kept in pi-coding-agent so extension types compile without importing GSD packages.
 */
import type { AgentMessage } from "@gsd/pi-agent-core";

/** Canonical union lives in @gsd/pi-agent-core (populated on `agent_end`). */
export type { AgentAbortOrigin } from "@gsd/pi-agent-core";
import type { AgentAbortOrigin } from "@gsd/pi-agent-core";

export interface BashResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
}

export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

export interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

export interface CompactionResult<T = unknown> {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details?: T;
}

export interface CompactionPreparation {
	firstKeptEntryId: string;
	messagesToSummarize: AgentMessage[];
	turnPrefixMessages: AgentMessage[];
	isSplitTurn: boolean;
	tokensBefore: number;
	previousSummary?: string;
	fileOps: FileOperations;
	settings: CompactionSettings;
}
