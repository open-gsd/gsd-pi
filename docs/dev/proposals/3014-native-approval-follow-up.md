# Exact cmux restore: native approval follow-up

Status: proposed follow-up to [#3014](https://github.com/open-gsd/gsd-pi/issues/3014). This document is a design and verification contract, not evidence that automatic restore is shipped or accepted.

## Required outcome

A disposable interactive GSD conversation must survive a literal workspace close and native History reopen. The approved restore command must start GSD automatically, open the exact existing session file, preserve its identity and original bytes, restore its working directory and supported storage configuration, and append a real continuation to the same conversation.

An explicit `cmux restore --surface` action is useful supplementary evidence. Neither that manual action nor invoking `gsd --resume-exact` directly satisfies the automatic-reopen acceptance check.

## Observed contract mismatch

The existing GSD bridge publishes `kind=gsd` with `source=agent-hook` through the public cmux CLI, without requesting an automatic grant. In cmux 0.65.0, that provenance selects the native-agent trust path. It does not consult ordinary signed-command approvals, and its automatic permission defaults to false. The context menu also treats it as agent-managed and hides ordinary command approval.

Preserving a restore record therefore does not prove that native History will execute it. A workspace can reopen with its record intact while its terminal remains at a shell prompt. Shutdown binding retention and exact session opening remain necessary, separate guarantees.

GSD must not fix this by claiming a native Pi identity, setting `auto_resume=true`, accessing signing secrets, or manufacturing user approval.

## Proposed public-command boundary

Publish GSD-owned commands with an ordinary, unprivileged `source=gsd`. Retain the GSD kind, exact session-file checkpoint, working directory, and literal launcher identity.

Use the supported public shell-command form only when every argument is rendered with a single POSIX quoting function. The rendered command contains exactly:

1. `env`;
2. the non-secret `GSD_HOME` assignment;
3. the existing GSD launcher arguments;
4. `--resume-exact`, the absolute existing session path, and the expected session ID.

Every argument, including empty strings and embedded single quotes, is quoted independently. No unquoted interpolation, shell expansion, inferred executable, generic Pi fallback, or transcript content is permitted. Tests must prove that executing the rendered command delivers the exact original argument array, including hostile-looking path characters, without executing injected commands.

The reason for a fully visible command rather than a captured launcher object is the native approval surface: newer cmux explicitly refuses to review a proposal with a hidden captured `launchCommand`. GSD must not bypass that restriction or sign a different payload from the one shown to the person approving it.

## Native approval and compatibility

Automatic execution remains a native cmux decision. GSD never sends an automatic permission, approval policy, or approval record. A manual or unsupported response remains manual, with a bounded diagnostic explaining that automatic restore is not yet approved.

The supported native path must review the original binding without reconstructing it. It must preserve its working directory, environment, checkpoint, and command, display the payload being approved, and sign the restricted full-command-prefix, cwd, and environment scope. Do not use an older command editor that discards cwd/environment or silently broadens a command prefix.

Native approval is prefix-based even with its generalization option off: the full displayed argument sequence becomes a prefix, and native matching may allow additional trailing arguments. Do not describe that signature as cryptographic equality of the complete command. The fixed prefix must contain the disposable GSD_HOME, launcher, exact session file, and session ID, and the native rule must bind the disposable cwd. GSD's own publication/adoption fences still require exact command equality and reject appended or altered arguments. The acceptance run must record this native limitation and use no trailing arguments.

Upstream cmux added an explicit **Review Approval** action in [04cdc082](https://github.com/manaflow-ai/cmux/commit/04cdc082e40295da0d37c36c3e3a391ecfbb9fd9). This is a source reference, not a claim that every installed cmux release contains it. Before host acceptance, identify the actual binary, verify that this native path is present, and verify the resulting approval scope. Leave any generalized-prefix option off for the disposable acceptance test.

If the installed host cannot provide that restricted native review, automatic acceptance remains blocked. Do not silently downgrade the requirement to manual restore, change shared trust settings, or restart other users' surfaces.

## Ownership, migration, and revocation

Publication, adoption, and clearing must agree on the new provenance. An owned ordinary binding must match the exact kind, source, rendered command, checkpoint, cwd, finite update timestamp, and resolved workspace/surface identity.

A legacy `agent-hook` binding may be migrated only when its structured launch arguments and the full session identity match this same interactive owner. A predecessor or different conversation must not be adopted. Migration grants no permission: the ordinary command is subject to native approval independently of the old flag.

A `show` preflight followed by unconditional `set` is not atomic. This follow-up therefore includes a native cmux compare-and-set dependency, not just a GSD provenance change.

The native host must advertise conditional resume publication. A set request carries exactly one expectation: no existing binding, or a complete expected checkpoint/source/update-time tuple for the existing binding. Native code validates the complete predicate and checks it atomically with assignment on the selected surface. Partial or contradictory conditions are invalid. A mismatch returns an explicit conflict and performs no mutation.

GSD includes that expectation in every publication, including initial publication and same-session legacy migration. It must not fall back to unconditional set on an old host, a conflict, an unsupported flag, a timeout, or malformed capability data. Newer or foreign generations survive a change between `show` and `set`.

Revocation retains its guarded clear and uses the actual observed source, checkpoint, and timestamp; it must not rely on a hard-coded legacy provenance. Tests must cover legacy cleanup as well as ordinary-command cleanup.

Normal shutdown ends live presence but retains the durable restore binding. Explicit opt-out may revoke only the owned binding. Children and subagents cannot replace the interactive parent's command.

## Implementation sequence

1. Reproduce the existing native close/reopen failure and add a focused regression before the production change.
2. Independently review this boundary, command rendering, migration, and native approval compatibility.
3. Add the native conditional-set schema, parser, capability, guarded mutation, CLI flags, and adversarial tests in a separate owned cmux source checkout. Review and verify that dependency without touching shared app installations or sessions.
4. Implement ordinary GSD publication and exact ownership checks against the advertised conditional-set contract, keeping automatic authority native. Add contract tests and run the focused Vault, exact-resume CLI, and terminal-cmux suites plus appropriate type/source checks.
5. Publish the exact candidate for CI and review. Triage human and automated findings against the current candidate SHA.
6. Use a private candidate runtime and an isolated compatible cmux instance for acceptance; do not patch the shared running installation.
7. Complete the literal automatic close/reopen and same-conversation continuation test before requesting issue closure.

## Verification matrix

| Check | Required proof |
| --- | --- |
| Public provenance | Ordinary GSD source; no native-agent identity or client-supplied automatic grant. |
| Command fidelity | Exact argv after shell decoding, including quotes, spaces, empty arguments, and expansion-looking characters. |
| Privacy | Binding contains only necessary launcher/session/cwd/storage metadata, not transcript text, auth contents, or raw environments. |
| Native scope | Actual native review preserves and signs the exact test cwd and required storage/command values. |
| Approval preservation | Matching signed approval survives ordinary republishing; changed cwd, home, environment, or command does not inherit it. |
| Legacy migration | Only the same exact legacy conversation is eligible; migration cannot carry an old automatic grant into ordinary trust. |
| Ownership and revocation | Foreign/newer bindings survive an adversarial change after show but before set; initial publication is conditional on absence; native assignment and predicate are atomic; owned cleanup is checkpoint/source/timestamp fenced. |
| Unsupported conditional set | Missing/malformed capability or an old native client causes no unconditional publication or fallback. |
| Host compatibility | Actual binary and source/package/runtime provenance recorded; unsupported hosts fail visibly without a success claim. |
| Literal automatic round trip | Exact native History target selected; GSD starts without an additional restore command; original file/ID/cwd/prefix retained. |
| Continuation | A new real user/assistant exchange is appended to that same file, with no replacement session. |
| Isolation and cleanup | Only recorded disposable targets and exact test approvals are changed and subsequently cleaned up. |

## Completion boundary

Keep #3014 open while the automatic host check is unproven. Green unit tests, record preservation, explicit manual native restore, a new process title, and `--resume-exact` success are distinct evidence classes; none substitutes for the required automatic native round trip.
