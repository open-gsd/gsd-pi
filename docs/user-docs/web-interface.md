# Web Interface

> GSD includes a browser-based web interface for project management, real-time progress monitoring, and multi-project support.

## Quick Start

```bash
gsd --web
```

This starts a local web server and opens the GSD dashboard in your default browser.

### CLI Flags

```bash
gsd --web --host 0.0.0.0 --port 8080 --allowed-origins "https://example.com"
```

| Flag | Default | Description |
|------|---------|-------------|
| `--host` | `127.0.0.1` | Bind address for the web server |
| `--port` | `3000` | Port for the web server |
| `--allowed-origins` | (none) | Comma-separated list of allowed CORS origins |
| `--no-auth` | disabled | Disable the built-in bearer token gate |

`--no-auth` leaves the web interface unprotected unless another layer controls access.

**Unauthenticated LAN interlock.** `--no-auth` (or `GSD_WEB_NO_AUTH=1`) disables the built-in bearer token. On a non-loopback bind such as `--host 0.0.0.0`, that would expose terminal and file APIs to anyone who can reach the host. GSD therefore refuses startup unless `GSD_WEB_ALLOW_UNAUTHENTICATED_LAN=1` is also set. Loopback hosts (`127.0.0.1`, `localhost`, `::1`, other `127.x.x.x` addresses) are exempt — `--no-auth` works there without the override.

To deliberately run unauthenticated web mode on a LAN-facing host, set `GSD_WEB_ALLOW_UNAUTHENTICATED_LAN=1` in the same environment. `--no-auth` alone is not enough on a non-loopback bind.

```bash
# POSIX shell (bash, zsh)
GSD_WEB_ALLOW_UNAUTHENTICATED_LAN=1 gsd --web --host 0.0.0.0 --no-auth
```

```powershell
# PowerShell
$env:GSD_WEB_ALLOW_UNAUTHENTICATED_LAN="1"; gsd --web --host 0.0.0.0 --no-auth
```

```bat
REM CMD
set GSD_WEB_ALLOW_UNAUTHENTICATED_LAN=1
gsd --web --host 0.0.0.0 --no-auth
```

This exposes terminal and file APIs to any client that can reach the server unless trusted external access control is already in place. Use the override only behind authentication you control, such as a reverse proxy, VPN, or private network boundary.

## Features

- **Project management** — view milestones, slices, and tasks in a visual dashboard
- **Real-time progress** — server-sent events push status updates as auto-mode executes
- **Multi-project support** — manage multiple projects from a single browser tab via `?project=` URL parameter
- **Change project root** — switch project directories from the web UI without restarting the server
- **Onboarding flow** — API key setup and provider configuration through the browser
- **Model selection** — switch models and providers from the web UI

## Architecture

The web interface is built with Next.js and communicates with GSD through a local bridge service. Each project gets its own bridge instance and one `gsd --mode rpc` child process. Commands and events use newline-delimited JSON over the child process's standard input and output, providing isolation for concurrent local sessions.

Key components:
- `BridgeService` — owns the per-project RPC child, command routing, and SSE subscription
- `getProjectBridgeServiceForCwd()` — registry returning distinct instances per project path
- `resolveProjectCwd()` — reads `?project=` from request URL or falls back to `GSD_WEB_PROJECT_CWD`

## Configuration

The web server binds to `127.0.0.1:3000` by default. Use `--host`, `--port`, and `--allowed-origins` to override (see CLI Flags above).

The [configuration guide](configuration.md#environment-variables) is the
authoritative reference for web environment variables.

## Node v24 Compatibility

Node v24 introduced breaking changes to type stripping that caused `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` on web boot. This is fixed in a recent release. If you encounter this error, upgrade GSD.

## Auth Token Persistence

the web UI persists the auth token in `sessionStorage` so it survives page refreshes (#1877). Previously, refreshing the page required re-authentication.

## Platform Notes

- **Windows**: The web build is skipped on Windows due to Next.js webpack EPERM issues with system directories. The CLI remains fully functional.
- **macOS/Linux**: Full support.
