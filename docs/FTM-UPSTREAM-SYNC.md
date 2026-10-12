# FTM upstream sync

Lightweight process for keeping the FirstTracks Materials fork of `gsd-pi`
current with stable upstream releases. This is intentionally less conservative
than the RaidNight cutover command sheet: merge the latest release, build the
web host, open a PR. No isolated cancel/slot acceptance matrix.

## Two surfaces (do not confuse them)

| Surface | Path | Role |
|---|---|---|
| Global CLI `gsd` | usually npm `@opengsd/gsd-pi` under nvm | Interactive / diagnostic CLI |
| RaidNight daemon | `dist/web/standalone/server.js` via `raidnight-gsd-staging.service` | Monitor / Quake execution |

Updating npm alone does **not** upgrade the daemon. Syncing this git fork and
running `scripts/ftm-deploy-local.sh` does.

## Weekly automation

GitHub Action: [`.github/workflows/ftm-sync-upstream.yml`](../.github/workflows/ftm-sync-upstream.yml)

- Schedule: Mondays 15:00 UTC, plus `workflow_dispatch`
- Runs [`scripts/ftm-sync-upstream.sh`](../scripts/ftm-sync-upstream.sh)
- Pin source: latest GitHub release tag on `open-gsd/gsd-pi`
- Gate: `pnpm@10.12.1` + `pnpm run build:web-host`
- Success: PR to `main` with auto-merge (merge commit)
- Conflict: PR titled for human resolution (conflict markers committed; no auto-resolve)

## Manual sync

```bash
cd /home/blasky/Projects/gsd-pi
scripts/ftm-sync-upstream.sh --dry-run    # show target tag
scripts/ftm-sync-upstream.sh              # merge, build, PR
scripts/ftm-sync-upstream.sh --no-pr      # local merge + build only
```

Requires `gh` authenticated against `FirstTracksMaterials/gsd-pi` for PR steps.

## Local daemon deploy

On the box that runs systemd:

```bash
scripts/ftm-deploy-local.sh
# or, if you accept interrupting a busy coding slot:
scripts/ftm-deploy-local.sh --force-restart
```

Defaults:

- Pulls `origin/main` ff-only
- Rebuilds `build:web-host`
- Probes `GSD_SLOT_PROBE_URL` (default `http://192.168.86.3:8082/slots`)
- Restarts `raidnight-gsd-staging.service` only when the slot is idle

Optional CLI alignment (not done by the deploy script):

```bash
npm install -g @opengsd/gsd-pi@1.22.0   # vanilla upstream CLI
# or link this checkout if you want FTM patches on PATH:
# pnpm link --global
```

## Conflict touchpoints

FTM-specific areas that often conflict with upstream:

- `src/runtime-control/**`
- `src/resources/extensions/gsd/bootstrap/register-hooks.ts`
- `packages/gsd-agent-core/**` (compaction / session hotfixes)
