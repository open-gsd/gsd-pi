# RFC: Exact GSD Conversation Restore Through cmux

- **Status:** Design and implementation plan for maintainer review
- **Scope:** [Issue #3014](https://github.com/open-gsd/gsd-pi/issues/3014)
- **Implementation:** [PR #3093](https://github.com/open-gsd/gsd-pi/pull/3093), currently draft

## Goal and scope

After a cmux restart, restore the selected interactive GSD conversation by reopening its
exact native session file through the GSD launcher, with the original working directory and
supported session-storage configuration. A successful restore keeps the native session
identity; it must not substitute a newer session or silently create a replacement.

This RFC is limited to exact conversation restore in issue #3014. Vault registration and
lifecycle metadata are tracked separately in #3012 (closed by PR #3072). Checkpoint-to-
conversation branching is tracked separately in #3015. Neither is expanded by this work.

## Design gate and decisions

The issue's earlier design gate asked for a verified cmux launcher contract and an owner
choice between a GSD adapter and a generic hook. The owner selected a GSD-owned optional
adapter in the [#3014 owner comment dated 2026-11-03][owner-decision]. This RFC records that decision and the
currently published cmux contract; it does not claim the real restart acceptance test has
passed.

cmux documents `surface resume set`, `show`, and `clear` for custom resume commands. Its
CLI contract accepts either a shell command or literal arguments after `--`. Public
bindings remain inspectable/manual unless their command prefix is trusted; cmux owns that
trust decision. The **Resume Agent Sessions on Reopen** setting can keep restored terminals
idle. GSD must not approve a trusted prefix, enable automatic resume, spoof the stock `pi`
agent identity, or replace cmux's policy.

On 2026-11-06, the installed cmux CLI was `0.65.0 (108)` at `dda24fbd2`. Its local help
confirmed `surface resume set -- <argv...>` and the `--kind`, `--checkpoint-id`, `--source`,
`--cwd`, `--workspace`, and `--surface` flags. This verifies CLI availability on that
installed version, not an actual restart/restore round trip or automatic trust.

- [cmux session restore policy](https://cmux.com/docs/session-restore)
- [cmux CLI contract][cmux-cli-contract], inspected at source revision
  `2fc85bb...`.

[owner-decision]: https://github.com/open-gsd/gsd-pi/issues/3014#issuecomment-6605225220
[cmux-cli-contract]: https://github.com/manaflow-ai/cmux/blob/2fc85bb/docs/cli-contract.md

## Contract

1. `cmux.resume` is opt-in and defaults off. It is independent of the Vault preference.
2. The adapter binds the current native session file, native ID, and cwd to the current cmux
   surface. It invokes the configured GSD launcher, passing literal argv equivalent to
   `env GSD_HOME=<configured-home> <gsd-launcher> --resume-exact <session-file> <native-id>`.
   It does not construct a shell-interpolated command.
3. Exact open validates the file's session ID, cwd, supported version, and native entry
   structure before replacing the current session. Invalid or mismatched input fails closed
   before migration, repair, session replacement, or new session creation.
4. A binding can be cleared only when its owner and identity match the current GSD binding.
   Foreign commands and other sessions' bindings are preserved. Failed cleanup remains
   retryable; it must not suppress later cleanup attempts.
5. Interactive-parent ownership is preserved. Headless runs and child/subagent sessions must
   not replace the interactive parent's cmux binding.
6. If cmux, its socket, or the expected protocol is unavailable, the optional integration
   fails within its bounded timeout and ordinary GSD startup, turns, and session persistence
   continue.
7. Metadata contains no transcript text, auth-file contents, tokens, or raw environment
   dump. Any environment handling follows cmux's filtering and trust policy.

## Binding and ownership matrix

- **Resume off, Vault off:** publish neither a new resume binding nor Vault metadata. A fresh
  publisher may clear only a persisted GSD-owned binding whose session ID, file, cwd, command,
  and owner exactly match the current GSD session. Without a current identity, leave it alone.
- **Resume off, Vault on:** provide Vault lifecycle metadata only. Never allow an automatic
  resume binding. If the managed cmux Pi bridge is present, it remains the Vault owner.
- **Resume on, Vault off:** publish only the exact GSD resume binding; write no Vault metadata.
- **Both on, managed bridge absent:** the GSD bridge may provide both features. Balance the
  previous Vault `SessionStart` with `SessionEnd` when identity or ownership changes.
- **Managed bridge present:** it owns Vault metadata and presence. GSD may provide the resume
  binding, but suppress duplicate managed-Pi publication in both current-session and snapshot
  paths. A fresh/restarted publisher may adopt or clear only its exact GSD binding.
- **Foreign or changed binding:** never clear or adopt it, even when either preference is off.
  A failed guarded clear remains retryable and does not erase prior lifecycle ownership.

## Verification and acceptance

The issue's R-01 through R-10 criteria remain the acceptance contract:

- **R-01:** restore the selected file and original identity when multiple sessions share a cwd.
- **R-02:** preserve the GSD launcher and its supported startup/extensions; never substitute
  stock Pi.
- **R-03:** preserve default/custom `GSD_HOME` and explicit supported session locations without
  requiring `.pi` symlinks or migrations.
- **R-04:** pass paths with spaces, Unicode, and shell metacharacters literally, with the right
  cwd and no shell interpolation.
- **R-05:** make the binding follow new sessions and session switches under explicit ownership.
- **R-06:** report missing/corrupt files without replacing identity or mutating workflow state.
- **R-07:** bound failures from absent cmux, stale sockets, and timeouts while normal GSD use
  remains available.
- **R-08:** honor disabled resume and cmux command-trust policy; layout restore must not
  silently execute an unapproved command.
- **R-09:** keep child/subagent activity from replacing the interactive parent's binding.
- **R-10:** exclude transcript text, auth-file contents, tokens, and raw environment dumps.

R-11 requires a real round trip with a disposable GSD conversation in an explicitly approved,
isolated test environment. Record the exact GSD and cmux versions, then register a session
with a harmless, non-sensitive conversation marker. After an approved cmux restart, restore
and continue that conversation; verify the same native ID, session file, cwd, and marker, and
confirm the follow-up continues in that same conversation. Capture launcher/storage and
identity/cwd evidence without retaining transcript contents. Unit mocks and green CI are not
substitutes. Do not restart the shared cmux instance while other workstreams are active. If
testing automatic execution, the operator must approve the exact trusted prefix in cmux; GSD
must never grant it. If the isolated test would interrupt an existing session, obtain explicit
operator approval first. Leave R-11 pending until that evidence exists.

## Implementation plan

1. **Design checkpoint:** review this contract and plan against #3014, the published cmux
   policy/CLI contract, and the maintainer's adapter decision. Merge this docs-only PR only
   after independent review and its required checks pass.
2. **Exact-session validation:** reject duplicate entry IDs and parent cycles before open or
   migration, and validate each native message variant, including persisted `bashExecution`
   entries. Add regressions proving corrupt files fail without changing session state.
3. **Binding lifecycle:** discover and clear only an exact stale GSD-owned automatic binding
   when resume is disabled; do not latch cleanup state until a guarded clear succeeds. Keep
   cleanup retryable, suppress duplicate managed-Pi Vault publication where GSD owns the
   resume path, and balance old/new Vault lifecycle events on replacement and clear.
4. **Regression matrix:** test each review finding, foreign-binding preservation, same-session
   updates, session switches, disabled/untrusted resume, cmux absence/timeouts, and parent
   ownership. Run focused suites serially if parallel execution causes resource pressure.
5. **Current-source validation:** update implementation PR #3093 from the latest
   `upstream/main` without overwriting another worktree. Run relevant lint, type, and tests;
   then obtain CI evidence for the exact pushed head.
6. **Review disposition:** individually recheck and resolve only review threads whose fixes or
   technical dispositions are evidenced on that exact head. Do not treat bot text or stale-SHA
   CI as approval.
7. **Acceptance closeout:** complete R-11 in the approved isolated environment, verify all
   issue criteria and exact-head CI, then merge only the reviewed, passing implementation head.

## Completion boundary

The docs/design gate can close when this contract is reviewed and merged and the existing owner
choice is recorded. Issue #3014 itself is not complete until implementation defects are fixed,
each review finding has an evidence-backed disposition, all current-head CI and acceptance
criteria pass, and R-11 has real round-trip evidence. This RFC does not close #3012 or #3015.
