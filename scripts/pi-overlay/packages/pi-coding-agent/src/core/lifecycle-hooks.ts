/** Extension-stable re-export — implementation lives in @gsd/agent-core. */
export {
	prepareLifecycleHooks,
	runLifecycleHooks,
	readManifestRuntimeDeps,
	collectRuntimeDependencies,
	verifyRuntimeDependencies,
	resolveLocalSourcePath,
	type PackageLifecycleHooksOptions,
} from "@gsd/agent-core/lifecycle-hooks.js";
