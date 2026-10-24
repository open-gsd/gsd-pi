# GSD integration/activation plan v2 - corrected per root 10:27

Status: PLAN FOR ROOT RECONCILIATION, no execution. Hold preserved: e525c3dc
source/staging and the live daemon untouched. Single deployment owner.

## Corrected facts (source-verified this pass, read-only)

- Ancestry: git merge-base e525c3dc c98ebe5c == e525c3dc with 3 commits between
  (741d7856, 3d99c855, c98ebe5c). NOT a direct parent - the check is
  merge-base equality, the advance is a 3-commit fast-forward.
- Actual project ID: gsd-pi (state DB /home/openclaw/.openclaw/state/openclaw.sqlite,
  projects table: id=gsd-pi, repo_root=/home/openclaw/.openclaw/projects/gsd-pi).
  No placeholder needed.
- The 13:14 root operation was a STATIC Control UI directory exchange; the web
  host is a separate in-process Next/PTY daemon whose handover is the portal
  service lifecycle below. The two are not interchangeable.

## Phase 1 - source integration (exact commands; after root final receipt)

cd /home/openclaw/.openclaw/projects/gsd-pi
git status --porcelain                # must be empty (hold intact)
git merge-base e525c3dc c98ebe5c      # must print e525c3dc...
git rev-list --count e525c3dc..c98ebe5c   # must print 3
git merge --ff-only c98ebe5c
git log --oneline -4                   # c98ebe5c, 3d99c855, 741d7856, e525c3dc

Verification is IDENTITY, not re-running the web suite (root: 109 targeted
child-isolated tests + real SDK/contract typechecks + 33 schema tests cover this
patch; production build skips full web type validation per existing config):
cd integrations/openclaw && npm run build   # tsc against real SDK, expect 0 errors
sha256sum dist/index.js dist/ui-methods.js dist/control-ui-embed.ts 2>/dev/null
# compare against root staging /home/openclaw/gsd-plugin-staging-20260919-c98ebe5c
# byte-identity of the emitted server dist; any mismatch -> stop, return to root.

## Phase 2 - web daemon handover (portal service lifecycle, source-verified)

The web host is spawned by GsdPortalService.launch (src/portals.ts):
production mode spawns `node <standalone server entry>` detached, with env
GSD_WEB_NO_AUTH=1, GSD_WEB_DAEMON_MODE=1, PUBLIC_URL=<portal.publicUrl>,
GSD_WEB_BASE_PATH, NODE_ENV=production. stop() aborts the run controller,
awaits startup, runs cleanup (child termination), and clears this.run. On any
child exit the service clears this.run itself, and the next start() relaunches
from the CURRENT staged build - the restart-free path.

Concrete sequence (root-coordinated; PTYs live in the daemon process):
1. Drain check: confirm no active GSD runs or open terminals on the daemon
   (admitted jobs are never killed; if busy, defer or get Bennett approval).
2. Stop: invoke the gsd-web-portal service stop path (root-coordinated service
   action) - the graceful stop() above, which terminates the child and clears
   the run handle; verify the web PID is gone.
3. Swap: publish root final web candidate into the web root location the
   launcher resolves (resolveWebLaunch), retaining the previous build as an
   explicitly named rollback directory (timestamped, never deleted).
4. Start: invoke the portal start path - launch() reserves the port, verifies
   via portal.list that no portal conflict exists, spawns the new standalone
   entry with the exact env above, and waits for readiness (180s timeout,
   250ms poll).
5. Verify: GET /boot and /api/preferences through the new daemon; base-path
   assets resolve; daemon project selection (launchCwd) unchanged; benign PTY
   smoke from root overlay present.
6. Rollback: stop(), swap the rollback directory back, start() again.

## Phase 3 - first Control UI registry admission (exact commands)

Publication order prevents partial reads: the registry consumes the plugin
through openclaw.plugin.json + dist under the LIVE load.paths entry
(/home/openclaw/.openclaw/projects/gsd-pi/integrations/openclaw). Publish
the staged candidate contents (dist/* including dist/control-ui/<hash>/) into
the live directory FIRST, and openclaw.plugin.json LAST as the final atomic
rename - a registry refresh before that moment still sees the previous
complete state.

Registry rebuild (the supported backend reload; root-coordinated):
openclaw plugins registry --refresh

Then verify: openclaw plugins control-ui list (or equivalent supported list)
shows the GSD entry with the staged bundle path; the workboard entry remains.
The 13:14-style static root is NOT touched by this step.

## Approved-project policy (actual values, no config written yet)

plugins.entries.open-gsd-openclaw.config.embeddedProjects = {
  adminOnly: true,
  projects: [ { projectId: "gsd-pi", canonicalRoot: "/home/openclaw/.openclaw/projects/gsd-pi" } ]
}

projectId gsd-pi verified against the live state DB (id column, repo_root
matches the realpath of the checkout). Written only at activation, after root
reconciles this plan. No other roots; adminOnly stays default-true.

## Held throughout
No integration, reload, restart, native action, grant, scope, or auth change
until root sends the final web candidate/receipt and reconciles this plan.
