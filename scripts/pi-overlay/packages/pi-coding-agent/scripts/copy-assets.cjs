#!/usr/bin/env node
const { existsSync, mkdirSync, cpSync, copyFileSync, readdirSync } = require('fs');
const { join } = require('path');

/**
 * Recursive directory copy using copyFileSync — workaround for cpSync failures
 * on Windows paths containing non-ASCII characters (#1178).
 */
function safeCpSync(src, dest, options) {
  try {
    cpSync(src, dest, options);
  } catch {
    if (options && options.recursive) {
      copyDirRecursive(src, dest, options && options.filter);
    } else {
      copyFileSync(src, dest);
    }
  }
}

function copyDirRecursive(src, dest, filter) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (filter && !filter(srcPath)) continue;
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath, filter);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

function copyIfExists(src, dest, options) {
  if (!existsSync(src)) return;
  safeCpSync(src, dest, options);
}

// Theme assets (GSD seam: src/theme, not modes/interactive/theme)
const themeSrc = 'src/theme';
const themeDest = 'dist/theme';
if (existsSync(themeSrc)) {
  mkdirSync(themeDest, { recursive: true });
  safeCpSync(themeSrc, themeDest, {
    recursive: true,
    filter: (s) => !s.endsWith('.ts'),
  });
}

// Export HTML lives in @gsd/agent-core after ADR-010 seam
const exportHtmlSrc = 'src/core/export-html';
if (existsSync(exportHtmlSrc)) {
  mkdirSync('dist/core/export-html/vendor', { recursive: true });
  copyIfExists('src/core/export-html/template.html', 'dist/core/export-html/template.html');
  copyIfExists('src/core/export-html/template.css', 'dist/core/export-html/template.css');
  copyIfExists('src/core/export-html/template.js', 'dist/core/export-html/template.js');
  copyIfExists('src/core/export-html/vendor', 'dist/core/export-html/vendor', {
    recursive: true,
    filter: (s) => !s.endsWith('.ts'),
  });
}

// LSP defaults
mkdirSync('dist/core/lsp', { recursive: true });
copyIfExists('src/core/lsp/defaults.json', 'dist/core/lsp/defaults.json');
copyIfExists('src/core/lsp/lsp.md', 'dist/core/lsp/lsp.md');
