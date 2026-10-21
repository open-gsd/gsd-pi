# open-gsd-hermes

Hermes Agent plugin integrating [GSD Pi](https://github.com/open-gsd/gsd-pi) as the structured delivery engine.

## Install

If GSD Pi was installed from an npm package that includes this integration, use the
one-command installer:

```bash
gsd hermes install --project /absolute/path/to/your/project
hermes plugins list   # should show open-gsd-hermes enabled
```

The installer copies the bundled plugin into `$HERMES_HOME/plugins/open-gsd-hermes`,
installs the Python package into the Hermes environment when possible, creates a
starter `$HERMES_HOME/gsd.yaml` if one does not exist, and runs
`hermes plugins enable open-gsd-hermes`.

From a source checkout, the manual development path is still supported:

```bash
pip install -e integrations/hermes
hermes plugins enable open-gsd-hermes
```

## Configuration

`~/.hermes/gsd.yaml` — see [`docs/setup.md`](docs/setup.md) for Slack/Telegram gateway checklist.

Common `gsd:` keys include `cli_path`, `mcp_server_path`, `default_project`, `bindings`, and `mcp_read_timeout_seconds`. The MCP read timeout defaults to 60 seconds; tune it only when Hermes times out waiting for `gsd-mcp-server` responses that complete locally on slow projects or filesystems.

**Before gateway testing:**

```bash
bash integrations/hermes/scripts/preflight.sh
```

## Slash commands

- `/gsd bind <path>` — bind session to project
- `/gsd status` — show progress
- `/gsd auto` — start auto mode via MCP
- `/gsd new-milestone <spec>` — create a milestone from inline spec text
- `/gsd new-milestone --file <path>` — create a milestone from a readable spec file
- `/gsd cancel` — cancel running session
- `/gsd reply <text>` — resolve blocker

`/gsd new-milestone` is planning-only. It starts `gsd headless --supervised
new-milestone` as a Hermes-owned subprocess, returns an acknowledgement
immediately, and then sends chat notifications when planning blocks, fails,
is cancelled, or completes. Run `/gsd auto` after the completion notification
to execute the milestone.

`--file` paths are validated before the planning subprocess starts; relative
paths are resolved from the bound project. `/gsd new-milestone --auto` is
rejected because Hermes keeps milestone planning and auto execution as separate
commands. While milestone planning is active, `/gsd auto` is rejected until the
planning run completes or `/gsd cancel` terminates it.

If planning asks a supervised question, reply with `/gsd reply <text>`; Hermes
writes the answer to the milestone subprocess instead of the MCP auto-session
path. `/gsd cancel` terminates an active milestone planning subprocess and sends
a single cancellation notification.

## Requirements

- `gsd >=2.53,<3` (override `gsd_version_min` in `~/.hermes/gsd.yaml` per release train)
- `gsd-mcp-server` on PATH or configured in `gsd.yaml`
