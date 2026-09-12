// Project/App: gsd-pi
// File Purpose: Every LegacyImport*Error class gets the same baseline
// formatting (class name, stage, code, context/evidence) with no exceptions
// -- no error class falls through to a bare, context-free message anymore.
// Later commits add plain-language explanations for specific codes on top
// of this same baseline; this file covers the baseline itself.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  isStructuredLegacyImportError,
  formatLegacyImportErrorBaseline,
  formatLegacyImportError,
  type StructuredLegacyImportError,
} from "../commands-maintenance.ts";
import { LegacyImportPreviewError } from "../legacy-import-preview.ts";
import { LegacyImportSourceError } from "../legacy-import-preview-source.ts";
import { LegacyImportClassificationError } from "../legacy-import-preview-classifier.ts";
import { LegacyImportBackupError } from "../legacy-import-backup.ts";

describe("isStructuredLegacyImportError", () => {
  test("recognizes any LegacyImport*Error carrying code/context/evidence", () => {
    const previewErr = new LegacyImportPreviewError(
      "create",
      "LEGACY_IMPORT_PREVIEW_BASE_CHANGED",
      "base changed during creation",
      true,
      { expected_revision: 1, observed_revision: 2 },
    );
    assert.ok(isStructuredLegacyImportError(previewErr));
  });

  test("rejects plain Error and non-LegacyImport errors", () => {
    assert.equal(isStructuredLegacyImportError(new Error("plain")), false);
    assert.equal(isStructuredLegacyImportError(new TypeError("oops")), false);
    assert.equal(isStructuredLegacyImportError("a string"), false);
    assert.equal(isStructuredLegacyImportError(null), false);
  });
});

describe("formatLegacyImportErrorBaseline", () => {
  test("reports class name, stage, code, and every context entry readably", () => {
    const err = new LegacyImportPreviewError(
      "create",
      "LEGACY_IMPORT_PREVIEW_BASE_CHANGED",
      "base changed during creation",
      true,
      { expected_revision: 1, observed_revision: 2 },
    );
    const message = formatLegacyImportErrorBaseline(err);
    assert.match(message, /\[LegacyImportPreviewError\]/);
    assert.match(message, /stage=create/);
    assert.match(message, /code=LEGACY_IMPORT_PREVIEW_BASE_CHANGED/);
    assert.match(message, /expected_revision: 1/);
    assert.match(message, /observed_revision: 2/);
  });

  test("falls back to evidence when context is absent (live-restore style errors)", () => {
    const errLike: StructuredLegacyImportError = {
      name: "LegacyImportLiveRestoreError",
      message: "restore failed",
      code: "LEGACY_IMPORT_LIVE_RESTORE_VERIFY_FAILED",
      stage: "verify",
      evidence: { attempt: 2, path: "/tmp/x" },
    };
    const message = formatLegacyImportErrorBaseline(errLike);
    assert.match(message, /\[LegacyImportLiveRestoreError\]/);
    assert.match(message, /attempt: 2/);
    assert.match(message, /path: \/tmp\/x/);
  });

  test("omits the Context section entirely when there is nothing to report", () => {
    const errLike: StructuredLegacyImportError = {
      name: "LegacyImportSourceError",
      message: "source unreadable",
      code: "LEGACY_IMPORT_SOURCE_UNREADABLE",
    };
    const message = formatLegacyImportErrorBaseline(errLike);
    assert.doesNotMatch(message, /Context:/);
  });

  test("real LegacyImportSourceError instances are recognized and formatted", () => {
    const err = new LegacyImportSourceError(
      "capture",
      "LEGACY_IMPORT_SOURCE_UNREADABLE",
      "legacy import source directory cannot be read",
      false,
      { root_id: "project-phases", logical_path: ".gsd/phases" },
    );
    assert.ok(isStructuredLegacyImportError(err));
    const message = formatLegacyImportErrorBaseline(err);
    assert.match(message, /\[LegacyImportSourceError\]/);
    assert.match(message, /root_id: project-phases/);
  });
});

describe("formatLegacyImportError", () => {
  test("with no known explanation yet implemented, shows only the baseline", () => {
    const err = new LegacyImportPreviewError(
      "create",
      "LEGACY_IMPORT_PREVIEW_BASE_CHANGED",
      "base changed during creation",
      true,
      { expected_revision: 1 },
    );
    const message = formatLegacyImportError(err);
    assert.equal(message, formatLegacyImportErrorBaseline(err));
  });

  test("a missing-PLAN lifecycle error prepends its explanation above the same baseline every other error gets", () => {
    const err = new LegacyImportClassificationError(
      "LEGACY_IMPORT_CLASSIFICATION_LIFECYCLE_AUTHORITY_INVALID",
      "legacy import canonical lifecycle has no hierarchy row",
      { target_key: "M009-rfuh2h/S02/T01" },
    );
    const message = formatLegacyImportError(err);
    const baseline = formatLegacyImportErrorBaseline(err);
    assert.match(message, /no PLAN establishes it as a real slice\/task/);
    assert.match(message, /M009-rfuh2h\/S02, task T01/);
    assert.ok(message.endsWith(baseline), "baseline must be appended verbatim, not replaced");
  });

  test("a foreign-key violation error prepends its explanation above the same baseline every other error gets", () => {
    const violations = [{ table: "quality_gates", rowid: 7, parent: "milestones", fkid: 0 }];
    const err = new LegacyImportBackupError(
      "LEGACY_IMPORT_BACKUP_FOREIGN_KEY_FAILED",
      "legacy import backup contains foreign-key violations",
      { violation_count: 1, violations },
      "verification",
      false,
    );
    const message = formatLegacyImportError(err);
    const baseline = formatLegacyImportErrorBaseline(err);
    assert.match(message, /row\(s\) whose foreign keys point at missing parent rows/);
    assert.match(message, /quality_gates: 1 row\(s\)/);
    assert.ok(message.endsWith(baseline), "baseline must be appended verbatim, not replaced");
  });
});
