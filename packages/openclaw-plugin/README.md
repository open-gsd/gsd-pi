# @opengsd/openclaw-plugin

[OpenClaw](https://docs.openclaw.ai) plugin for [GSD Pi](https://github.com/open-gsd/gsd-pi). Plugin id: `open-gsd-openclaw`.

Read a bound project's progress from any OpenClaw chat channel (Telegram, Discord, Slack, WhatsApp, WebChat, and the others OpenClaw supports). The `/gsd` command is handled by the OpenClaw Gateway before any model or agent runtime is selected, so it behaves identically on every first-party runtime and provider.

## Install

```bash
openclaw plugins install npm:@opengsd/openclaw-plugin --pin
openclaw config set plugins.entries.open-gsd-openclaw.config.defaultProject /absolute/path/to/project
openclaw plugins enable open-gsd-openclaw
openclaw gateway restart
```

From a gsd-pi source checkout, build the package and link it instead of installing it from npm:

```bash
pnpm --filter @opengsd/openclaw-plugin run build
openclaw plugins install --link /path/to/gsd-pi/packages/openclaw-plugin --force
```

Verify the running registration:

```bash
openclaw plugins inspect open-gsd-openclaw --runtime --json
```

The `gsd` CLI must be on the Gateway process PATH, or set `plugins.entries.open-gsd-openclaw.config.cliPath` to its absolute path.

## Commands

| Command | Behaviour |
| --- | --- |
| `/gsd status [path]` | Project snapshot: phase, active milestone/slice/task, counts, blockers, next action |
| `/gsd bind <absolute path>` | Bind this conversation to a GSD project |
| `/gsd unbind` | Remove the binding |
| `/gsd help` | Command list |

Project resolution order: explicit path argument, then the conversation binding, then `defaultProject`. Nothing is inferred from a working directory; with no match the command fails closed and says so.

Bindings are keyed by conversation route (channel, account, conversation, thread), so a native slash command and a typed `/gsd` in the same chat share one binding. They are stored under the plugin's state directory as `open-gsd-openclaw/bindings.json`.

## Authorization

`/gsd` declares `requiredScopes: ["operator.write"]`. OpenClaw enforces it: Gateway clients (the Control UI, the CLI) need that scope, and chat senders must be command owners. The plugin keeps no allowlist of its own.

Who counts as an owner follows OpenClaw's rules: `commands.ownerAllowFrom` when set, otherwise the channel's explicit `allowFrom` entries. A channel whose allowlist is empty or a wildcard has no owners, so set `commands.ownerAllowFrom` to use `/gsd` from such a channel:

```json5
{ commands: { ownerAllowFrom: ["telegram:123456789"] } }
```

## Configuration

```json5
{
  plugins: {
    entries: {
      "open-gsd-openclaw": {
        enabled: true,
        config: {
          cliPath: "/usr/local/bin/gsd", // optional; defaults to `gsd` on PATH
          defaultProject: "/home/me/code/myapp",
        },
      },
    },
  },
}
```

## Scheduling runs

OpenClaw automations run command payloads inside the Gateway with no model call, so a nightly `gsd headless auto` needs no plugin code:

```bash
openclaw automations create "0 2 * * *" \
  --name "Nightly GSD auto" \
  --command-argv '["gsd","headless","auto","--json"]' \
  --command-cwd /absolute/path/to/project \
  --timeout-seconds 7200 \
  --announce --channel telegram --to "<chat id>"
```

Raise `--timeout-seconds` to cover a milestone-length run; the default command timeout is ten minutes.

## Development

```bash
pnpm --filter @opengsd/openclaw-plugin run build
pnpm --filter @opengsd/openclaw-plugin test
```

Offline compatibility check against the OpenClaw plugin contract:

```bash
npm install --no-save --no-audit --no-fund @openclaw/plugin-inspector
./node_modules/.bin/plugin-inspector ci --plugin-root packages/openclaw-plugin --no-openclaw --runtime --mock-sdk --allow-execute
```

## License

MIT
