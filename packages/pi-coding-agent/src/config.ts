import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

// =============================================================================
// Package Detection
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Detect if we're running as a Bun compiled binary.
 * Bun binaries have import.meta.url containing "$bunfs", "~BUN", or "%7EBUN" (Bun's virtual filesystem path)
 */
export const isBunBinary =
	import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");

/** Detect if Bun is the runtime (compiled binary or bun run) */
const isBunRuntime = !!process.versions.bun;

// =============================================================================
// Install Method Detection
// =============================================================================

type InstallMethod = "bun-binary" | "npm" | "pnpm" | "yarn" | "bun" | "unknown";

function detectInstallMethod(): InstallMethod {
	if (isBunBinary) {
		return "bun-binary";
	}

	const resolvedPath = `${__dirname}\0${process.execPath || ""}`.toLowerCase();

	if (resolvedPath.includes("/pnpm/") || resolvedPath.includes("/.pnpm/") || resolvedPath.includes("\\pnpm\\")) {
		return "pnpm";
	}
	if (resolvedPath.includes("/yarn/") || resolvedPath.includes("/.yarn/") || resolvedPath.includes("\\yarn\\")) {
		return "yarn";
	}
	if (isBunRuntime) {
		return "bun";
	}
	if (resolvedPath.includes("/npm/") || resolvedPath.includes("/node_modules/") || resolvedPath.includes("\\npm\\")) {
		return "npm";
	}

	return "unknown";
}

export function getUpdateInstruction(packageName: string): string {
	const method = detectInstallMethod();
	switch (method) {
		case "bun-binary":
			return `Download from: https://github.com/badlogic/pi-mono/releases/latest`;
		case "pnpm":
			return `Run: pnpm install -g ${packageName}`;
		case "yarn":
			return `Run: yarn global add ${packageName}`;
		case "bun":
			return `Run: bun install -g ${packageName}`;
		case "npm":
			return `Run: npm install -g ${packageName}`;
		default:
			return `Run: npm install -g ${packageName}`;
	}
}

// =============================================================================
// Package Asset Paths (shipped with executable)
// =============================================================================

/**
 * Get the base directory for resolving package assets (themes, package.json, README.md, CHANGELOG.md).
 * - For Bun binary: returns the directory containing the executable
 * - For Node.js (dist/): returns __dirname (the dist/ directory)
 * - For tsx (src/): returns parent directory (the package root)
 */
let _cachedPackageDir: string | undefined;

function getPackageDir(): string {
	if (_cachedPackageDir !== undefined) return _cachedPackageDir;

	// Allow override via environment variable (useful for Nix/Guix where store paths tokenize poorly)
	const envDir = process.env.PI_PACKAGE_DIR;
	if (envDir) {
		if (envDir === "~") return (_cachedPackageDir = homedir());
		if (envDir.startsWith("~/")) return (_cachedPackageDir = homedir() + envDir.slice(1));
		return (_cachedPackageDir = envDir);
	}

	if (isBunBinary) {
		// Bun binary: process.execPath points to the compiled executable
		return (_cachedPackageDir = dirname(process.execPath));
	}
	// Node.js: walk up from __dirname until we find package.json
	let dir = __dirname;
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) {
			return (_cachedPackageDir = dir);
		}
		dir = dirname(dir);
	}
	// Fallback (shouldn't happen)
	return (_cachedPackageDir = __dirname);
}

/**
 * Get the base directory for resolving bundled SDK documentation
 * (README.md, docs/, examples/).
 *
 * Unlike getPackageDir(), this intentionally IGNORES PI_PACKAGE_DIR.
 * PI_PACKAGE_DIR is a branding/config override (gsd-pi sets it to a
 * pkg/ shim directory containing only piConfig + theme assets, with no
 * README.md, docs/, or examples/ — see scripts/sync-pkg-version.cjs).
 * Resolving documentation through that override produces nonexistent
 * paths such as pkg/README.md (#2809). Documentation lives alongside
 * this module's own package.json, so walk up from __dirname exactly
 * like the non-override branch of getPackageDir().
 */
function getDocsPackageDir(): string {
	if (isBunBinary) {
		return dirname(process.execPath);
	}
	let dir = __dirname;
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) {
			return dir;
		}
		dir = dirname(dir);
	}
	return __dirname;
}

/**
 * Get path to built-in themes directory (shipped with package)
 * - For Bun binary: theme/ next to executable
 * - For Node.js (dist/): dist/modes/interactive/theme/
 * - For tsx (src/): src/modes/interactive/theme/
 */
export function getThemesDir(): string {
	if (isBunBinary) {
		return join(dirname(process.execPath), "theme");
	}
	// Theme is in modes/interactive/theme/ relative to src/ or dist/
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "theme");
}

/**
 * Get path to HTML export template directory (shipped with package)
 * - For Bun binary: export-html/ next to executable
 * - For Node.js (dist/): dist/core/export-html/
 * - For tsx (src/): src/core/export-html/
 */
export function getExportTemplateDir(): string {
	if (isBunBinary) {
		return join(dirname(process.execPath), "export-html");
	}
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "core", "export-html");
}

/** Get path to package.json */
function getPackageJsonPath(): string {
	return join(getPackageDir(), "package.json");
}

/** Get path to README.md (resolved independently of PI_PACKAGE_DIR branding — see #2809) */
export function getReadmePath(): string {
	return resolve(join(getDocsPackageDir(), "README.md"));
}

/** Get path to docs directory (resolved independently of PI_PACKAGE_DIR branding — see #2809) */
export function getDocsPath(): string {
	return resolve(join(getDocsPackageDir(), "docs"));
}

/** Get path to examples directory (resolved independently of PI_PACKAGE_DIR branding — see #2809) */
export function getExamplesPath(): string {
	return resolve(join(getDocsPackageDir(), "examples"));
}

/** Get path to CHANGELOG.md */
export function getChangelogPath(): string {
	return resolve(join(getPackageDir(), "CHANGELOG.md"));
}
