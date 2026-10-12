import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const webRoot = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(webRoot, '..')

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  outputFileTracingRoot: repoRoot,
  experimental: {
    // Next 16 defaults to its detached TypeScript CLI path, which can return a
    // truncated --showConfig payload on this host. TypeScript 5.7 provides the
    // compiler API, so keep the build deterministic by using that supported path.
    useTypeScriptCli: false,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  serverExternalPackages: [
    '@gsd/native',
    '@gsd/pi-ai',
    '@gsd/pi-agent-core',
    '@gsd/pi-coding-agent',
    '@gsd/agent-core',
    'koffi',
    'node-pty',
    'proper-lockfile',
  ],
  // NodeNext-style .js extension imports in src/ must resolve to .ts source.
  // Turbopack doesn't support extensionAlias, so builds use --webpack flag.
  webpack: (config, { isServer }) => {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    // Webpack swallows `node:module` imports because it treats `module` as an
    // internal concept.  We need createRequire to survive into the server
    // bundle so node-pty (a native addon) can be loaded at runtime.
    if (isServer) {
      config.externals = config.externals || [];
      // Next.js already makes externals an array of functions/regexps — append
      // a simple object entry so `require("node:module")` passes through.
      config.externals.push({
        'node:module': 'commonjs node:module',
        'node:fs': 'commonjs node:fs',
        'node:os': 'commonjs node:os',
        'node:path': 'commonjs node:path',
        // @gsd/native is a native addon loaded via runtime require().
        // serverExternalPackages handles the top-level import, but webpack
        // still tries to resolve the bare specifier inside files traced from
        // src/ (outside web/). Explicitly externalize it.
        '@gsd/native': 'commonjs @gsd/native',
      });
      config.externals.push(({ request }, callback) => {
        if (
          typeof request === 'string' &&
          (
            request.startsWith('node:') ||
            request.startsWith('@gsd/native/') ||
            request === 'koffi' ||
            request.startsWith('koffi/') ||
            // workflow-mcp discovers optional CLI entrypoints via new URL(...);
            // those paths are runtime existence checks, not webpack bundle deps.
            /packages\/mcp-server\/(dist\/cli\.js|src\/cli\.ts)$/.test(request)
          )
        ) {
          return callback(null, `commonjs ${request}`);
        }
        callback();
      });
    }
    return config;
  },
}

export default nextConfig
