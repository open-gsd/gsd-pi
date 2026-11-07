# Exec host acceptance matrix for #2916

> Status: execution plan, not acceptance evidence. Every observation below is pending. Merged source, renderer unit tests and green CI do not establish installed-runtime or real-host acceptance.

This matrix implements the observation contract in [#2916](https://github.com/open-gsd/gsd-pi/issues/2916), under umbrella [#2913](https://github.com/open-gsd/gsd-pi/issues/2913). It complements the [cross-host contract](2913-cross-host-implementation-contract.md) and [exec presentation semantics](../../user-docs/exec-presentation.md). Optional activity/log-context proposals do not expand the exec acceptance gate.

## Evidence identity and installation gate

Before executing observations, record the exact source commit, immutable package/artifact identity, installed package version, managed-resource identity, host/adapter version, operating system, terminal dimensions, theme and observation timestamp. Bind each evidence reference to the actual tested source/artifact, not merely a CI workflow's checkout SHA.

Installation/restart is a separate operator-controlled step outside an active GSD session. This plan authorizes neither rebuilding/installing the runtime from a live session nor restarting another session. Verify source, installed package and managed-resource layers before claiming an observation applies to the release candidate. Never infer layer parity from a version label alone.

Use synthetic public fixtures. Evidence must not contain credentials, customer content or private workspace paths. Preserve durable evidence outside ephemeral terminal scrollback and reference it individually below.

## Required native and MCP observations

| ID | Surface and fixture | Required observation | Failure invariant | Status / evidence |
| --- | --- | --- | --- | --- |
| H01 | Native collapsed exec; normal width | One physical row; useful muted italic purpose; existing status, alignment and hints | Purpose does not hide a failure or evidence warning | Pending |
| H02 | Native expanded exec; long single-line stdout and stderr | Purpose appears once; accurate stream explanations; bounded visual preview | A single line cannot bypass the preview budget | Pending |
| H03 | Narrow width; safe Unicode; long safe paths | No budgeting exceptions/overflow; full safe path remains available expanded | Do not rewrite IDs, substitute basenames or corrupt Markdown links | Pending |
| H04 | Dark and light native themes | Existing theme tokens keep output readable | No hardcoded color dependency; status remains understandable without color alone | Pending |
| H05 | UAT streaming and completion | Running identifier-derived label; normalized canonical completed purpose | Display derivation does not change execution/evidence semantics or stored values | Pending |
| H06 | Empty, missing and capped streams | Distinct zero/missing/truncation explanations and captured-byte wording | No promise of an unlimited full log or exact on-disk file size | Pending |
| H07 | Nonzero exit; spawn, validation and policy errors; timeout; abort | Each existing status and diagnostic remains distinct | stderr content alone is not failure; timeout and abort are not success | Pending |
| H08 | Genuine unrecorded-evidence result, including exit zero and empty reason | Recording warning and available reason remain visible | No generic success rollup hides an evidence-recording failure | Pending |
| H09 | Ordinary output with warning-like marker text; structured details present | Literal output remains output | Do not infer warnings from content when structured details exist | Pending |
| H10 | Unrelated native tools | Existing rendering, rollups and hints remain unchanged | Do not apply a generic purpose contract to arbitrary tools | Pending |
| H11 | Real MCP registration, executor and adapter | Raw content preserved; additive structuredContent fields observed | No transport-level details property, native-renderer conflation or invented MCP protocol | Pending |

H07 requires separate evidence for each listed error/termination case. H03 and H04 require separate recorded configurations, not one screenshot relabelled as multiple observations. Native and MCP reports remain separate even when they use the same synthetic command.

## Per-observation receipt

Each receipt must include:

- Matrix ID and exact subcase/configuration.
- Expected behavior and actual observed behavior, including limitations.
- Exact tested source/artifact and verified runtime-layer identity.
- Host, environment, dimensions/theme and timestamp.
- Durable transcript, screenshot or structured adapter result reference, with sensitive content excluded.
- Verdict: passed, failed or pending; a defect link for failures.

A source-bound regression test may supplement a real-host receipt but cannot replace it. Unavailable hosts and genuinely human visual judgments remain pending; do not convert them into fabricated passed results. Preserve raw diagnostics when a recording failure means the run is not verification/UAT evidence.

## Closure rules

Keep #2916 open until every required item and subcase has source/artifact/environment-bound observed evidence, blocking defects are repaired and re-observed, and the required operator acceptance is recorded. Update each item individually. Do not close the umbrella from a docs merge or CI result.

This matrix does not authorize Vault acceptance, native CUA actions, trust-setting changes, unrelated session mutation or additional production protocols. Those boundaries remain separate.
