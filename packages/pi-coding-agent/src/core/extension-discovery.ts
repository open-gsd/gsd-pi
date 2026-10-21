import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

function isExtensionFile(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".js");
}

function readExtensionManifestId(extensionDir: string): string | undefined {
	try {
		const manifest = JSON.parse(readFileSync(join(extensionDir, "extension-manifest.json"), "utf-8")) as Record<
			string,
			unknown
		>;
		return typeof manifest.id === "string" &&
			typeof manifest.name === "string" &&
			typeof manifest.version === "string" &&
			typeof manifest.tier === "string"
			? manifest.id
			: undefined;
	} catch {
		return undefined;
	}
}

function readManifestIdFromEntry(entryPath: string, extensionsDir?: string): string | undefined {
	let currentDir = dirname(resolve(entryPath));
	if (!extensionsDir) return readExtensionManifestId(currentDir);

	const root = resolve(extensionsDir);
	while (currentDir === root || currentDir.startsWith(`${root}${sep}`)) {
		const id = readExtensionManifestId(currentDir);
		if (id !== undefined) return id;
		if (currentDir === root) break;
		currentDir = dirname(currentDir);
	}
	return undefined;
}

export function resolveExtensionEntries(dir: string): string[] {
	const packageJsonPath = join(dir, "package.json");
	if (existsSync(packageJsonPath)) {
		try {
			const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
			if (pkg?.pi && typeof pkg.pi === "object") {
				const declared = pkg.pi.extensions;
				if (!Array.isArray(declared) || declared.length === 0) return [];
				return declared
					.filter((entry: unknown): entry is string => typeof entry === "string")
					.map((entry: string) => resolve(dir, entry))
					.filter((entry: string) => existsSync(entry));
			}
		} catch {
			// Ignore malformed manifests and fall back to index.ts/index.js discovery.
		}
	}

	const indexTs = join(dir, "index.ts");
	if (existsSync(indexTs)) return [indexTs];
	const indexJs = join(dir, "index.js");
	return existsSync(indexJs) ? [indexJs] : [];
}

/** Discover extension entry points beneath one extensions directory. */
export function discoverExtensionEntryPaths(extensionsDir: string): string[] {
	if (!existsSync(extensionsDir)) return [];

	const discovered: string[] = [];
	for (const entry of readdirSync(extensionsDir, { withFileTypes: true })) {
		const entryPath = join(extensionsDir, entry.name);
		if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
			discovered.push(entryPath);
		} else if (entry.isDirectory() || entry.isSymbolicLink()) {
			discovered.push(...resolveExtensionEntries(entryPath));
		}
	}
	return discovered;
}

/**
 * Merge bundled and installed extension entries before the loader sees them.
 * Installed manifest IDs shadow bundled IDs (D-14); the loader stays dumb (D-15).
 */
export function mergeExtensionEntryPaths(
	bundledPaths: string[],
	installedExtensionsDir: string,
	bundledExtensionsDir?: string,
): string[] {
	if (!existsSync(installedExtensionsDir)) return bundledPaths;

	const installedById = new Map<string, string[]>();
	for (const entry of readdirSync(installedExtensionsDir, { withFileTypes: true })) {
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		const extensionDir = join(installedExtensionsDir, entry.name);
		const id = readExtensionManifestId(extensionDir);
		const paths = resolveExtensionEntries(extensionDir);
		if (id !== undefined && paths.length > 0) installedById.set(id, paths);
	}
	if (installedById.size === 0) return bundledPaths;

	const merged = bundledPaths.filter((path) => {
		const id = readManifestIdFromEntry(path, bundledExtensionsDir);
		return id === undefined || !installedById.has(id);
	});
	for (const paths of installedById.values()) merged.push(...paths);
	return merged;
}
