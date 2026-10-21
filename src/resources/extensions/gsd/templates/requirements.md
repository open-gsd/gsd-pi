# Requirements

This file is the explicit capability and coverage contract for the project.

Use it to track what is actively in scope, what has been validated by completed work, what is intentionally deferred, and what is explicitly out of scope.

Guidelines:
- Keep requirements capability-oriented, not a giant feature wishlist.
- Requirements should be atomic, testable, and stated in plain language.
- Every **Active** requirement should be mapped to a slice, deferred, blocked with reason, or moved out of scope.
- Each requirement should have one accountable primary owner and may have supporting slices.
- Research may suggest requirements, but research does not silently make them binding.
- Validation means the requirement was actually proven by completed work and verification, not just discussed.

## Active

### R001 — {{requirementTitle}}
- Class: {{core-capability | primary-user-loop | launchability | continuity | failure-visibility | integration | quality-attribute | operability | admin/support | compliance/security | differentiator | constraint | anti-feature}}
- Status: active
- Description: {{what must be true in plain language}}
- Why it matters: {{why this matters to actual product usefulness/completeness}}
- Source: {{user | inferred | research | execution}}
- Primary owning slice: {{M001/S01 | none yet}}
- Supporting slices: {{M001/S02, M001/S03 | none}}
- Validation: {{unmapped | mapped | partial | validated}}
- Notes: {{constraints / acceptance nuance / why not yet validated}}

## Validated

### R010 — {{requirementTitle}}
- Class: {{failure-visibility}}
- Status: validated
- Description: {{what was proven}}
- Why it matters: {{why it matters}}
- Source: {{user | inferred | research | execution}}
- Primary owning slice: {{M001/S01}}
- Supporting slices: {{none}}
- Validation: validated
- Notes: {{what verification proved this}}

## Deferred

### R020 — {{requirementTitle}}
- Class: {{admin/support}}
- Status: deferred
- Description: {{useful later, not now}}
- Why it matters: {{why it might matter later}}
- Source: {{user | inferred | research | execution}}
- Primary owning slice: {{none}}
- Supporting slices: {{none}}
- Validation: unmapped
- Notes: {{why deferred now}}

## Out of Scope

### R030 — {{requirementTitle}}
- Class: {{anti-feature | constraint | core-capability}}
- Status: out-of-scope
- Description: {{what is explicitly excluded}}
- Why it matters: {{what scope confusion this prevents}}
- Source: {{user | inferred | research | execution}}
- Primary owning slice: {{none}}
- Supporting slices: {{none}}
- Validation: n/a
- Notes: {{why excluded}}

## Traceability

| ID | Class | Status | Primary owner | Supporting | Proof |
|---|---|---|---|---|---|
| R001 | primary-user-loop | active | M001/S01 | none | mapped |
| R010 | failure-visibility | validated | M001/S01 | none | validated |
| R020 | admin/support | deferred | none | none | unmapped |
| R030 | anti-feature | out-of-scope | none | none | n/a |

## Coverage Summary

- Active requirements: {{count}}
- Mapped to slices: {{count}}
- Validated: {{count}}
- Unmapped active requirements: {{count}}
