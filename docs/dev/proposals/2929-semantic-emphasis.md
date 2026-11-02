# Semantic Emphasis Across GSD TUI and Hosts

**Status:** Design proposal for [#2929](https://github.com/open-gsd/gsd-pi/issues/2929), O06 under umbrella [#2913](https://github.com/open-gsd/gsd-pi/issues/2913). Implementation scope and visual acceptance still require maintainer review. The source baseline is upstream `main` at `e323d180efe3bd10f16beedf589ae06f14563e47`.

## Problem and Scope

The TUI and its host surfaces already have theme helpers and semantic color roles, but meaning-to-style mappings need a cross-surface audit. Long or low-emphasis supporting text can become difficult to read; outcomes and required actions must remain legible without color. The merged [#2941](https://github.com/open-gsd/gsd-pi/pull/2941) delivered a focused VS Code sidebar semantic-color slice. This proposal covers only a reviewed remainder; it does not reopen that delivery or infer universal contrast from token names.

## Existing Boundaries

- The native theme declares semantic roles and exposes `Theme.fg`/`Theme.bg`; the Markdown adapter already maps headings and strong text.
- The native status widget uses semantic TUI roles and textual status labels.
- The VS Code activity feed resolves its `ActivityModel` color IDs through `vscode.ThemeColor`; the model currently uses chart roles for execution outcomes and a neutral role for interrupted/unknown outcomes.
- The cmux extension publishes semantic status/log-level events; it does not own VS Code CSS colors.
- Raw logs, source text and clipboard bytes are data, not authored Markdown. Their contents must not be re-styled or rewritten to communicate status.

These are source observations at the stated revision, not screenshots or evidence that every host/theme renders them accessibly.

## Proposed Role Mapping

| Content | Proposed treatment | Boundary |
| --- | --- | --- |
| Authored heading | Existing Markdown heading role | Do not add a second color or parse raw logs as Markdown. |
| Authored strong text | Existing bold adapter | Avoid duplicate ANSI or styling already-rendered strings. |
| Supporting purpose/metadata | Readable muted role | Do not make long supporting text indiscriminately dim. |
| Outcome, blocker, required action | Normal emphasis plus text/icon label; existing semantic role where needed | Color is never the sole status signal; do not infer lifecycle state from styling. |
| Raw output, source, paths | Preserve literal content and original bytes | Presentation may bound a separate display label, never mutate stored/copied data. |
| VS Code status icon | Existing appropriate semantic `ThemeColor` and `ThemeIcon` | No hard-coded replacement palette or terminal-to-CSS translation. |

This mapping is a review proposal. Confirm ambiguous categories and the shared-adapter blast radius before changing source.

## Required Decisions Before Implementation

1. Which remaining callers and host surfaces are in scope after #2941? Keep terminal, cmux, VS Code webview and activity-feed ownership separate.
2. Do existing roles cover every selected meaning, or is a new theme token actually required? Any token/schema change needs explicit owner approval.
3. Which existing roles should represent supporting purpose, required action, unknown, interrupted, failure and success in each host?
4. What exact contrast, high-contrast, no-color and keyboard-focus observations are required before acceptance?
5. Which raw/source/copy paths must remain byte-identical in each surface?

## Regression and Host Evidence

After scope is accepted, add behavioral tests for existing custom-theme fallback, light/dark theme mapping, status labels with and without color, already-styled nested content, narrow wrapping, and unchanged raw/copy bytes. Do not rely only on regex over ANSI strings.

Review actual rendering under light, dark and high-contrast VS Code themes, reduced/no-color terminal output, and keyboard focus. Record host/version, dimensions, theme and exact source/artifact/runtime identity. Observe native TUI, cmux and VS Code separately where changed. Unit tests or use of a semantic token alone do not prove contrast or real-host acceptance; keep unavailable partitions open under #2916.

## Non-Goals

No theme-engine replacement, hard-coded palette, new ANSI parser, new live-theme-switch feature, global width policy, raw-output restyling, lifecycle semantic change, new notification authority, or installed-runtime patch is proposed. Related D02/D03/D04/D05 work remains separately reviewable under #2936, #2932, #2931 and #2935.
