# GSD ↔ OpenClaw Integration — Working Context (2026-09-13)

Mission: own PR open-gsd/gsd-pi#2135 (feat/openclaw-integration @ 8d44d3a4, fork GoatInAHat/gsd-pi).
Checkout: /home/openclaw/.openclaw/projects/gsd-pi (clean, at PR head).

## Relocated corpus (this dir, mac-sessions/*.jsonl)
Mined from Bennett's MacBook Claude Desktop sessions via read-only node bridge; one JSONL per
session, lines {off, ts, type, text} (user+agent messages only). 8 files, ~770KB, 483 messages.
- gsd-pi-autoresearch: kickoff directive @ ~offset 30000 (the coordination constraints)
- openclaw-arch-redesign: Pask-design feature inventory (TaskFlow, Workboard, SecretRef, …)
- codex-project-context: vado-lab ops (tailscale, secretrefs directive); 18.3MB raw, 149 msgs kept
- toolfactory-clawhub, claude-runtime-compaction, openclaw-fork-deletion, repo-setup-gsd-init,
  openclaw-deploy-status: supporting context
Not transferable: Codex CLI sessions on the Mac (node lacks file/dir/codex.appServer commands).

## Standing directives (grounded)
- GSD + ToolFactory must coexist without confusing OpenClaw; both support as many OpenClaw
  features as useful. Design rule: defer to OpenClaw-native mechanisms, don't re-implement.
- Loop testing model (owner-updated 2026-09-13): zai/glm-5.3-flash (cheapest + most headroom);
  escalate to OpenAI pro (Codex sub, 99% of 168h left) if needed; never Copilot Premium.
- Secrets only via OpenClaw secret vault / secretrefs.

## PR 2135 state (verified 2026-09-13)
- versions 1.19.0 across package.json / openclaw.plugin.json / root ✓
- operator.admin scoped to exactly projects.register + workboard.cards.create|update ✓
- only log surface: constant-string warn (no host paths) ✓
- verify:fast ✓ ; review CHANGES_REQUESTED (jeremymcs): blockers = CI green on this design
  (fork-workflow approval, maintainer-side) + fresh re-review after reshape
- gsd-loop bot verdict stale (pre-reshape commit bd8ce89e)

## Gateway go-live (21:13:41Z restart, PID 797441)
- open-gsd-openclaw v1.19.0 loaded (18-plugin list) ✓; gsd MCP server registered ✓
- projects.list: exactly one gsd-pi row (registered) — no duplicates ✓
- Workboard: 0 cards; no managed flow yet
- onError: quiet ✓
- WHY no flow/card: gateway has NO GSD registry (~/.gsd/projects absent; checkout has no .gsd/).
  Discovery watches GSD's registry, not the OpenClaw projects table. ENOENT → silent by design.
  Ancestor watchers are armed: the first GSD-initialized project on this machine triggers sync
  without another restart. To exercise the full path: initialize GSD state for a gateway project
  (owner + GSD session decision per standing rule), or set GSD_STATE_DIR in mcp.servers.gsd.env.

## Coordination
- sessions_send blocked for this session (spawned-session SUBAGENT_TOOL_DENY_ALWAYS, hardcoded
  dist/agent-tools.policy). Workarounds: UI-created sessions send; this session publishes via
  Honcho/sessions_search. Upstream fix proposal drafted on request.
- Sessions: toolfactory=42af2337, prompt-standards=b20fe616, projects=a71d1b67 (dashboard keys).
  TF inter-session bodies arrive header-only here (known delivery race); read via sessions_history.
