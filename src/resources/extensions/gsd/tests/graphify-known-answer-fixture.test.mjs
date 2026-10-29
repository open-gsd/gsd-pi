import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const fixtureDir = fileURLToPath(new URL("./fixtures/graphify-known-answer/", import.meta.url));

async function readFixture(path) {
  return readFile(join(fixtureDir, path), "utf8");
}

async function readManifest() {
  return JSON.parse(await readFixture("expected-facts.json"));
}

test("known-answer manifest is explicitly fixture-only, not a provider contract", async () => {
  const manifest = await readManifest();
  assert.equal(manifest.format, "gsd-graphify-known-answer-fixture");
  assert.equal(manifest.version, 1);
  assert.match(manifest.claimBoundary, /not a provider response or runtime contract/);
});

test("two direct call facts point to the helper and have source evidence", async () => {
  const manifest = await readManifest();
  const callFacts = manifest.facts.filter(fact => fact.relation === "calls");
  assert.equal(callFacts.length, 2);
  assert.deepEqual(
    callFacts.map(fact => fact.source).sort(),
    ["caller-primary.ts#renderPrimary", "caller-secondary.ts#renderSecondary"],
  );

  for (const fact of callFacts) {
    const sourcePath = fact.source.split("#", 1)[0];
    const source = await readFixture(sourcePath);
    assert.equal(fact.target, "helper.ts#formatLabel");
    assert.ok(source.includes(fact.sourceEvidence), `${fact.id} evidence is missing`);
  }

  const helper = await readFixture("helper.ts");
  assert.match(helper, /export function formatLabel\(/);
});

test("an import and value reference do not assert a calls relationship", async () => {
  const manifest = await readManifest();
  const fact = manifest.facts.find(item => item.id === "import-with-value-reference-is-not-a-call");
  const source = await readFixture("import-only.ts");

  assert.ok(fact);
  assert.equal(fact.relation, "imports");
  assert.equal(fact.source, "import-only.ts");
  assert.equal(fact.target, "helper.ts#formatLabel");
  assert.equal(fact.mustNotInfer, "calls");
  assert.ok(source.includes(fact.sourceEvidence));
  assert.match(source, /formatLabelReference = formatLabel;/);
  assert.doesNotMatch(source, /formatLabel\s*\(/);
});

test("dynamic dispatch stays unresolved instead of being assigned to the helper", async () => {
  const manifest = await readManifest();
  const fact = manifest.facts.find(item => item.id === "dynamic-dispatch-target-is-unresolved");
  const source = await readFixture("dynamic-dispatch.ts");

  assert.ok(fact);
  assert.equal(fact.relation, "dynamic-call");
  assert.equal(fact.source, "dynamic-dispatch.ts#invokeByName");
  assert.equal(fact.target, "unresolved");
  assert.equal(fact.mustNotResolveTo, "helper.ts#formatLabel");
  assert.ok(source.includes(fact.sourceEvidence));
  assert.ok(source.includes(fact.callEvidence));
});

test("the proof recipe names freshness and worktree boundaries without claiming execution", async () => {
  const manifest = await readManifest();
  const expected = new Set([
    "dirty-working-tree",
    "new-untracked-source",
    "deleted-source",
    "relevant-config-change",
    "same-relative-path-in-two-worktrees",
    "source-changes-during-query",
  ]);
  assert.deepEqual(new Set(manifest.boundaryScenarios), expected);
});
