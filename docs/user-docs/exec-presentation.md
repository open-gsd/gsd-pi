# Exec presentation (as-built contract)

This page describes how `gsd_exec` and `gsd_uat_exec` results are presented in the native TUI. It documents what the code and tests currently guarantee. It is not a claim that every host has been accepted in a real terminal; that is tracked separately.

## Purpose

- `purpose` is an optional argument for `gsd_exec`. Supplied strings, including blank ones, are preserved in the request and in result `details`.
- Display fallback and storage are separate. An omitted purpose is absent from `details` for display, but it is stored as `null` in `.meta.json`. Callers must not expect blank strings to be removed, and must not expect persisted purpose values to be non-null.
- For `gsd_uat_exec`, the public schema has no `purpose` argument. While the check runs, the label is derived from `milestoneId`, `sliceId`, `checkId`, and `intent` (`UAT <milestone>/<slice>/<check> (<intent>)`). That running label is display-only.
- The completed purpose is canonical: it is generated from normalized identifiers and the canonical intent, then stored in run metadata and result `details`.
- Precedence for a completed run: the purpose stored in the result `details` wins, then the call argument, then a runtime-based label (for example "Run a Bash script").
- Display text is sanitized (terminal escapes, bidi controls, and control characters removed) and whitespace-collapsed. The standalone call renderer caps it at 80 characters. The native host frame has no fixed length cap; see below.

## Where the purpose appears

- Standalone call card: shows the purpose once beneath the tool title.
- Native host frame: when the host owns the purpose (`gsdExecPurposeInFrame`), the call card renders nothing, so the purpose is shown once in the frame header.
- Native frame width: the header uses `singleRowDisplayText` without a length cap, then `truncateToWidth` with the width left in the header. A wide terminal can therefore show more than 80 characters.

## Output

- Structured `details` drive the result card: exit status, duration, stdout and stderr byte counts, and full original log paths. Paths are never shortened.
- Content text is never scanned for warning markers when structured `details` are present.
- Results without `details` (historical rows) fall back to a bounded view of the content text, including a recognised legacy recording footer.

## Recording warnings

- A recording warning appears when `details.run_not_recorded` is present, including when it is empty. The warning explains that the run is not verification or UAT evidence.
- Ordinary output that happens to contain warning-like text does not produce a warning when structured `details` are present.
- A genuine historical footer (details absent) is shown only when it matches the exact legacy footer shape.

## `structuredContent`

- The result renderer reads `details` and `content` only. `structuredContent` is not a renderer input. This is intentional: the native host passes `details`, and no transport requirement was demonstrated.

## Evidence limits

- Successful output is never by itself verification or UAT evidence. A recording failure stays visible and is not rolled up into success.
- Visual behaviour across real terminals, widths, and themes is verified by the separate acceptance work (#2916), not by these unit tests.
