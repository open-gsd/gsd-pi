You are running the GSD **secure-phase** workflow — retroactively verify threat mitigations for completed work.

## Target

{{target}}

## Process

1. **Load the threat context.** Read any security/threat notes for the target (milestone plan, CONTEXT, KNOWLEDGE security rules). If none exist, derive threats from the work itself: auth, authorization, input validation, secrets handling, data exposure, dependency risk.

2. **For each identified threat, confirm its mitigation.** Trace the threat to where the code mitigates it. Classify each: `mitigated` (evidence in code), `partial` (mitigation incomplete), `unmitigated` (no evidence), or `not-applicable`.

3. **Verify the mitigations hold.** Where a mitigation is a test, confirm the test exists and covers the threat. Where it's a code pattern, confirm it's applied consistently (not just in the happy path).

4. **Update the security record.** Write/append `.gsd/SECURITY.md` (or the project's security doc) with the threat-mitigation table and any new findings. Record durable security rules via `/gsd knowledge rule`.

5. **Report.** Summarize: mitigated count, partial/unmitigated findings (critical first), and recommended remediation.

## Success criteria

- Every threat is traced to a mitigation (or flagged unmitigated) with code evidence.
- Mitigations are verified for consistency, not just presence.
- The security record is updated, not just printed.
- Partial/unmitigated findings are prioritized and actionable.
