# Packaging & Distribution


### Creating a Pi Package

Add a `pi` manifest to `package.json`:

```json
{
  "name": "my-pi-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

### `pi.extensions` vs `extension-manifest.json`

Two separate mechanisms serve different purposes:

**`pi.extensions` in `package.json`** — tells the runtime which files to load as extensions. Required for packaged extensions (those with npm dependencies).

```json
{
  "name": "@gsd/extension-breakout",
  "type": "module",
  "pi": {
    "extensions": ["src/index.ts"]
  }
}
```

**`extension-manifest.json`** — declares capabilities for the registry. Does not specify the entry point.

Both files are needed for a packaged extension. They serve different registries: `package.json` → runtime loader, `extension-manifest.json` → capability registry.

**Convention directories (no `package.json` needed):** for single-file extensions without npm dependencies, drop `.ts` files directly in `~/.gsd/agent/extensions/` — the runtime auto-discovers them. `extension-manifest.json` is still recommended even then.

### Installing Packages

```bash
pi install npm:@foo/bar@1.0.0
pi install git:github.com/user/repo@v1
pi install ./local/path

# Try without installing:
pi -e npm:@foo/bar
```

### Convention Directories (no manifest needed)

If no `pi` manifest exists, pi auto-discovers:
- `extensions/` → `.ts` and `.js` files
- `skills/` → `SKILL.md` folders
- `prompts/` → `.md` files
- `themes/` → `.json` files

### Gallery Metadata

```json
{
  "pi": {
    "video": "https://example.com/demo.mp4",
    "image": "https://example.com/screenshot.png"
  }
}
```

### Dependencies

- List `@gsd/pi-ai`, `@gsd/pi-coding-agent`, `@gsd/pi-tui`, `@sinclair/typebox` in `peerDependencies` with `"*"` — they're bundled by pi.
- Other npm deps go in `dependencies`. Pi runs `npm install` on package installation.

---
