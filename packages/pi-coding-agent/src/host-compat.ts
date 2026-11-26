/**
 * GSD host compatibility surface for the v1.6.1 pin.
 * Re-exports symbols the monorepo root and host packages import from the
 * package barrel that are not part of the trimmed upstream index.
 */

export { AuthStorage, readStoredCredential } from "./core/auth-storage.js";
export type {
	AuthCredential,
	ApiKeyCredential,
	AuthStorageBackend,
	OAuthCredential,
} from "./core/auth-storage.js";
export {
	type PackageCommand,
	type PackageCommandOptions,
	parsePackageCommand,
	runPackageCommand,
} from "./core/package-commands.js";
export { createBashTool } from "./core/tools/bash.js";
export { createEditTool } from "./core/tools/edit.js";
export { createReadTool } from "./core/tools/read.js";
export { createWriteTool } from "./core/tools/write.js";
export { getToolCompatibility } from "./core/tools/tool-compatibility-registry.js";
export { getLoadedSkills, loadSkills } from "./core/skills.js";
export { getSkillDirectories } from "./core/skill-directories.js";
export {
	getAllowedCommandPrefixes,
	setAllowedCommandPrefixes,
} from "./core/resolve-config-value.js";
export {
	getBeforeAgentStartContext,
	setBeforeAgentStartContext,
} from "./core/extensions/before-agent-start-context.js";
export {
	importExtensionModule,
	registerExtensionBundledModules,
} from "./core/extensions/loader.js";
export { HARD_DEADLINE_MS, SIGKILL_GRACE_MS, killProcessTree, sanitizeCommand } from "./utils/shell.js";
export type {
	BeforeCommitEventResult,
	BeforePrEventResult,
	BeforePushEventResult,
	BeforeVerifyEventResult,
	BudgetThresholdEventResult,
	VerifyFailure,
} from "./core/gsd-extension-types.js";
export type { AgentAbortOrigin } from "./core/gsd-seam-types.js";
export type { GsdProgressState } from "./core/extensions/extension-upstream-types.js";

export {
	discoverExtensionEntryPaths,
	mergeExtensionEntryPaths,
	resolveExtensionEntries,
} from "./core/extension-discovery.js";
