# GSD Embedded Transport Proposal - tokenless frame-bound operation adapter
2026-09-19, sole writer lane, design/testing authorized, activation requires contract review.

## Goal
Retain the existing Next app in the opaque sandboxed iframe and give it authenticated operations without tokens, cookies-in-frame, generic URL proxying, broader grants, or a UI rewrite - per Root contract review 06:53 CDT.

## Components
1. Control UI module - new, small. Shipped by the GSD plugin via defineControlUiPlugin - vendor API verified in dist plugins-authoring-command. On host.ui.registerPage for the GSD page the module:
   - mounts the existing Next iframe, opaque sandbox allow-scripts unchanged;
   - runs the existing platform cookie probe unchanged;
   - establishes a frame-bound postMessage channel: fresh channel nonce per mount handed to the frame; every inbound message validated for event.source identity with the mounted iframe contentWindow, correct nonce, and operation membership in the allowlist; channel torn down on unmount - lifetime-bound, no replay after frame removal.
2. Operation allowlist adapter - typed operations only, no URL passthrough. Initial picker-flow set:
   - preferences.get - read
   - projects.list - read, args root and detail
   - switchRoot - write, explicitly gated in the allowlist
   - terminal.stream - SSE: the module holds the first-party stream and forwards events over the channel
   Each operation maps to a server gateway method registered via api.registerGatewayMethod with operator or profile scopes - API shape verified in plugin types. The server method re-validates scope and arguments - defense in depth.
3. Web client shim - web/lib/embedded-transport.ts. In embedded mode - opaque origin detected - operation calls route through the postMessage channel; non-allowlisted calls fail closed client-side. Standalone and first-party modes unchanged - direct fetch, no behavior difference.

## Security properties
- Tokenless: no tokens, cookies or secrets enter the frame or URLs; the parent authenticated host context performs all server calls.
- Frame-bound and lifetime-bound: channel identity checks bind to the specific iframe element and die with it.
- Allowlist both ends: client gate plus server scope checks.
- EXPLICIT DESIGN CONSIDERATION, not silently approved: the Control UI module runs with the operator-authority session and native modules share operator authority with no per-plugin RPC allowlist - Root finding. Activation requires owner acknowledgment of that trust posture. The allowlist adapter is defense in depth, not a boundary against the module itself.

## Non-goals, per review
No generic URL proxy. No broader or POST-capable grants. No OPTIONS or WebSocket on the cookie path. No sandbox or allow-same-origin change. No full UI rewrite.

## Test plan
Unit: channel binding - source identity, nonce rejection, allowlist enforcement, teardown kills channel; operation mapping round-trip; server method scope validation; embedded-mode routing and fail-closed in the shim. Existing suites unchanged.

## Rollout
Source and testing proceed now under standing authorization. Activation only after this contract is reviewed. Deployment coordinated with actual in-flight web, MCP and background receipts. Client commits 5e37bd0c and 94360f81 remain correct and unstaged - they are the client half of whichever transport lands.

## Parent-side mandatory requirements per Root final review 07:03 CDT
- Fresh unpredictable per-frame nonce per mount; prior channel revoked when a new channel initializes - request ids restart at 1 per client, so stale channels must never accept or answer current ids.
- Operation-level argument validation at the parent AND server with authentication - args are unknown over the channel by design and only the authenticated parent/server sides may interpret them.
- No Gateway credentials of any kind cross the channel - tokenless by construction, enforced by review.

## Approved-project policy for fs/run operations - proposed configuration for root review

Boundary fact: the public SDK has no caller-aware project-ID-to-authorized-root resolver. This policy is plugin-owned, administrator-configured, and default-deny - it does not invent a core ACL.

Proposed configuration shape under plugins.entries.open-gsd-openclaw.config:

  embeddedProjects: {
    adminOnly: true,            // initially: operator.admin profile required
    projects: [                 // explicit approved list; empty denies all
      { projectId: <core projects.list id>, canonicalRoot: /home/openclaw/.openclaw/projects/gsd-pi }
    ]
  }

Rules:
- Default deny: any fs/run operation touching a root not on the approved list is refused.
- Mount-bound handles: the parent resolves projectId to canonicalRoot at dispatch, bound server-side to client.connId, authenticatedUserProfile.profileId, and connectionSignal; the frame only ever sees opaque project handles, never raw paths.
- Canonical containment: every operation revalidates the resolved path against the canonical root with realpath checks at operation time; symlink escape denies.
- Administrator-only initially, widened only by explicit root review.
- Arbitrary root browsing stays disabled: directories.list operates only within approved roots.
- Catalog source: the authenticated core projects.list provides the project catalog; its recent-filtering is NOT a per-profile ACL and is not treated as one. GSD inventory discovery and CLI credentials are not authorization for interactive frame work.
