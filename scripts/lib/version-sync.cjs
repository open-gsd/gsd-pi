// Project/App: Open GSD
// File Purpose: Shared helpers for syncing and verifying release version surfaces.
const fs = require("node:fs");
const path = require("node:path");

const RELEASE_WORKSPACE_PACKAGE_DIRS = [
  "extensions/google-search",
  "packages/contracts",
  "packages/daemon",
  "packages/gsd-agent-core",
  "packages/gsd-agent-modes",
  "packages/mcp-server",
  "packages/native",
  "packages/openclaw-plugin",
  "packages/pi-agent-core",
  "packages/pi-ai",
  "packages/pi-coding-agent",
  "packages/pi-tui",
  "packages/rpc-client",
];

const PLATFORM_PACKAGE_DIRS = [
  "native/npm/darwin-arm64",
  "native/npm/darwin-x64",
  "native/npm/linux-arm64-gnu",
  "native/npm/linux-x64-gnu",
  "native/npm/win32-x64-msvc",
];

const INTERNAL_PACKAGE_NAMES = new Set([
  "@gsd/agent-core",
  "@gsd/agent-modes",
  "@opengsd/contracts",
  "@opengsd/daemon",
  "@opengsd/mcp-server",
  "@opengsd/openclaw-plugin",
  "@opengsd/rpc-client",
  "@gsd/native",
  "@gsd/pi-agent-core",
  "@gsd/pi-ai",
  "@gsd/pi-coding-agent",
  "@gsd/pi-tui",
]);

const NATIVE_CRATE_NAMES = new Set(["gsd-ast", "gsd-engine", "gsd-grep"]);

const HERMES_PYPROJECT_PATH = "integrations/hermes/pyproject.toml";
const HERMES_CLIENT_PATH = "integrations/hermes/open_gsd_hermes/gsd_client.py";
const STABLE_SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

/**
 * Prerelease publishes (dev AND next channels) reuse the stable
 * @opengsd/engine-* packages already on npm — the prerelease workflow does not
 * build or publish per-platform engines. Strip any prerelease suffix back to
 * the base X.Y.Z so optionalDependencies pin to a version that actually exists.
 */
function resolveEngineOptionalDependencyVersion(rootVersion) {
  const prereleaseMatch = rootVersion.match(/^(\d+\.\d+\.\d+)-(?:dev|next)\.[0-9a-f]+$/i);
  if (prereleaseMatch) {
    return prereleaseMatch[1];
  }
  return rootVersion;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function packagePath(root, packageDir) {
  return path.join(root, packageDir, "package.json");
}

function setPackageVersion(root, packageDir, version) {
  const filePath = packagePath(root, packageDir);
  if (!fs.existsSync(filePath)) return false;
  const pkg = readJson(filePath);
  let changed = false;
  if (pkg.version !== version) {
    pkg.version = version;
    changed = true;
  }
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    if (!pkg[field]) continue;
    for (const dep of Object.keys(pkg[field])) {
      if (INTERNAL_PACKAGE_NAMES.has(dep) && pkg[field][dep] !== "*" && pkg[field][dep] !== "workspace:*") {
        pkg[field][dep] = "workspace:*";
        changed = true;
      }
    }
  }
  if (changed) {
    writeJson(filePath, pkg);
  }
  return true;
}

function syncNativeCargoVersion(root, version) {
  const manifestPath = path.join(root, "native", "Cargo.toml");
  if (fs.existsSync(manifestPath)) {
    const manifest = fs.readFileSync(manifestPath, "utf8");
    const versionPattern = /(\[workspace\.package\][\s\S]*?\nversion = )"[^"]+"/;
    if (!versionPattern.test(manifest)) {
      throw new Error("Could not find native workspace package version in native/Cargo.toml");
    }
    const nextManifest = manifest.replace(
      versionPattern,
      `$1"${version}"`,
    );
    if (nextManifest !== manifest) {
      fs.writeFileSync(manifestPath, nextManifest);
    }
  }

  const lockPath = path.join(root, "native", "Cargo.lock");
  if (fs.existsSync(lockPath)) {
    const packages = fs.readFileSync(lockPath, "utf8").split(/\n(?=\[\[package\]\]\n)/);
    const nextPackages = packages.map((entry) => {
      const name = entry.match(/^name = "([^"]+)"/m)?.[1];
      if (!name || !NATIVE_CRATE_NAMES.has(name)) return entry;
      return entry.replace(/^version = "[^"]+"/m, `version = "${version}"`);
    });
    fs.writeFileSync(lockPath, nextPackages.join("\n"));
  }
}

function isStableReleaseVersion(version) {
  return STABLE_SEMVER_PATTERN.test(version);
}

function replaceRequired(content, pattern, replacement, filePath, description) {
  if (!pattern.test(content)) {
    throw new Error(`Could not find ${description} in ${filePath}`);
  }
  return content.replace(pattern, replacement);
}

function syncHermesVersion(root, version) {
  if (!isStableReleaseVersion(version)) return;

  const pyprojectPath = path.join(root, HERMES_PYPROJECT_PATH);
  if (fs.existsSync(pyprojectPath)) {
    const pyproject = fs.readFileSync(pyprojectPath, "utf8");
    const nextPyproject = replaceRequired(
      pyproject,
      /(^version = )"[^"]+"/m,
      `$1"${version}"`,
      HERMES_PYPROJECT_PATH,
      "open-gsd-hermes project version",
    );
    if (nextPyproject !== pyproject) {
      fs.writeFileSync(pyprojectPath, nextPyproject);
    }
  }

  const clientPath = path.join(root, HERMES_CLIENT_PATH);
  if (fs.existsSync(clientPath)) {
    const client = fs.readFileSync(clientPath, "utf8");
    const nextClient = replaceRequired(
      client,
      /("clientInfo": \{"name": "open-gsd-hermes", "version": )"[^"]+"/,
      `$1"${version}"`,
      HERMES_CLIENT_PATH,
      "open-gsd-hermes clientInfo version",
    );
    if (nextClient !== client) {
      fs.writeFileSync(clientPath, nextClient);
    }
  }
}

function readHermesVersion(content, pattern) {
  return content.match(pattern)?.[1];
}

function verifyHermesVersion(root, expectedVersion, issues) {
  if (!isStableReleaseVersion(expectedVersion)) return;

  const pyprojectPath = path.join(root, HERMES_PYPROJECT_PATH);
  if (fs.existsSync(pyprojectPath)) {
    const version = readHermesVersion(
      fs.readFileSync(pyprojectPath, "utf8"),
      /^version = "([^"]+)"/m,
    );
    if (version !== expectedVersion) {
      issues.push(`${HERMES_PYPROJECT_PATH} version is ${version ?? "missing"}, expected ${expectedVersion}`);
    }
  }

  const clientPath = path.join(root, HERMES_CLIENT_PATH);
  if (fs.existsSync(clientPath)) {
    const version = readHermesVersion(
      fs.readFileSync(clientPath, "utf8"),
      /"clientInfo": \{"name": "open-gsd-hermes", "version": "([^"]+)"/,
    );
    if (version !== expectedVersion) {
      issues.push(`${HERMES_CLIENT_PATH} clientInfo version is ${version ?? "missing"}, expected ${expectedVersion}`);
    }
  }
}

function syncVersionSurfaces(root, version, options = {}) {
  if (options.updateRoot !== false) {
    const rootPkgPath = path.join(root, "package.json");
    const rootPkg = readJson(rootPkgPath);
    rootPkg.version = version;
    writeJson(rootPkgPath, rootPkg);
  }

  for (const packageDir of RELEASE_WORKSPACE_PACKAGE_DIRS) {
    setPackageVersion(root, packageDir, version);
  }

  for (const packageDir of PLATFORM_PACKAGE_DIRS) {
    setPackageVersion(root, packageDir, version);
  }

  setPackageVersion(root, "pkg", version);
  syncNativeCargoVersion(root, version);
  syncHermesVersion(root, version);
}

function getNativeCargoVersion(root) {
  const manifestPath = path.join(root, "native", "Cargo.toml");
  if (!fs.existsSync(manifestPath)) return undefined;
  const manifest = fs.readFileSync(manifestPath, "utf8");
  return manifest.match(/\[workspace\.package\][\s\S]*?\nversion = "([^"]+)"/)?.[1];
}

function getNativeLockVersions(root) {
  const lockPath = path.join(root, "native", "Cargo.lock");
  if (!fs.existsSync(lockPath)) return new Map();
  const versions = new Map();
  for (const entry of fs.readFileSync(lockPath, "utf8").split(/\n(?=\[\[package\]\]\n)/)) {
    const name = entry.match(/^name = "([^"]+)"/m)?.[1];
    if (!name || !NATIVE_CRATE_NAMES.has(name)) continue;
    versions.set(name, entry.match(/^version = "([^"]+)"/m)?.[1]);
  }
  return versions;
}

function verifyPackage(root, packageDir, expectedVersion, issues) {
  const filePath = packagePath(root, packageDir);
  if (!fs.existsSync(filePath)) {
    issues.push(`${packageDir}/package.json is missing`);
    return;
  }

  const pkg = readJson(filePath);
  if (pkg.version !== expectedVersion) {
    issues.push(`${packageDir}/package.json version is ${pkg.version}, expected ${expectedVersion}`);
  }

  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    if (!pkg[field]) continue;
    for (const [dep, range] of Object.entries(pkg[field])) {
      if (INTERNAL_PACKAGE_NAMES.has(dep) && range !== "*" && range !== "workspace:*") {
        issues.push(`${packageDir}/package.json ${field}.${dep} is ${range}, expected workspace:*`);
      }
    }
  }
}

function verifyLockfile(root, expectedVersion, issues) {
  const lockPath = path.join(root, "pnpm-lock.yaml");
  if (!fs.existsSync(lockPath)) {
    issues.push("pnpm-lock.yaml is missing");
    return;
  }

  const lock = fs.readFileSync(lockPath, "utf8");
  if (!lock.includes("lockfileVersion:")) {
    issues.push("pnpm-lock.yaml is invalid or empty");
  }
}

function verifyVersionSync(root) {
  const expectedVersion = readJson(path.join(root, "package.json")).version;
  const issues = [];

  for (const packageDir of RELEASE_WORKSPACE_PACKAGE_DIRS) {
    verifyPackage(root, packageDir, expectedVersion, issues);
  }
  for (const packageDir of PLATFORM_PACKAGE_DIRS) {
    verifyPackage(root, packageDir, expectedVersion, issues);
  }
  verifyPackage(root, "pkg", expectedVersion, issues);
  verifyLockfile(root, expectedVersion, issues);

  const rootPkg = readJson(path.join(root, "package.json"));
  const expectedOptionalDepVersion = resolveEngineOptionalDependencyVersion(expectedVersion);
  for (const platformDir of PLATFORM_PACKAGE_DIRS) {
    const platform = platformDir.replace("native/npm/", "");
    const depName = `@opengsd/engine-${platform}`;
    const pinned = rootPkg.optionalDependencies?.[depName];
    if (pinned === undefined) {
      issues.push(`package.json optionalDependencies.${depName} is missing, expected ${expectedOptionalDepVersion}`);
    } else if (pinned !== expectedOptionalDepVersion) {
      issues.push(`package.json optionalDependencies.${depName} is ${pinned}, expected ${expectedOptionalDepVersion}`);
    }
  }

  const nativeCargoVersion = getNativeCargoVersion(root);
  if (nativeCargoVersion !== undefined && nativeCargoVersion !== expectedVersion) {
    issues.push(`native/Cargo.toml workspace package version is ${nativeCargoVersion}, expected ${expectedVersion}`);
  }
  for (const [name, version] of getNativeLockVersions(root)) {
    if (version !== expectedVersion) {
      issues.push(`native/Cargo.lock ${name} version is ${version}, expected ${expectedVersion}`);
    }
  }
  verifyHermesVersion(root, expectedVersion, issues);

  return issues;
}

module.exports = {
  INTERNAL_PACKAGE_NAMES,
  PLATFORM_PACKAGE_DIRS,
  RELEASE_WORKSPACE_PACKAGE_DIRS,
  resolveEngineOptionalDependencyVersion,
  syncVersionSurfaces,
  verifyVersionSync,
};
