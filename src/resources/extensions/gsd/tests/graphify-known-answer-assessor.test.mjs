import assert from "node:assert/strict";
import test from "node:test";
import { assessFixtureObservations } from "./fixtures/graphify-known-answer/assess-observations.mjs";

// Deliberately mocked observations, not extracted output or native-route evidence.
function mockObservations() {
  return {
    format: "gsd-graphify-c07-observations",
    version: 1,
    fixture: "graphify-known-answer",
    availability: "available",
    provenance: { kind: "mock", reference: "unit-test-only", sourceRevision: "0".repeat(40) },
    facts: [
      {
        source: "caller-primary.ts#renderPrimary", relation: "calls", target: "helper.ts#formatLabel",
        anchors: [{ line: 4, text: "return formatLabel(value);" }],
      },
      {
        source: "caller-secondary.ts#renderSecondary", relation: "calls", target: "helper.ts#formatLabel",
        anchors: [{ line: 3, text: "formatLabel(value)" }],
      },
      {
        source: "import-only.ts", relation: "imports", target: "helper.ts#formatLabel",
        anchors: [{ line: 1, text: 'import { formatLabel } from "./helper.js";' }],
      },
      {
        source: "dynamic-dispatch.ts#invokeByName", relation: "dynamic-call", target: "unresolved",
        anchors: [
          { line: 6, text: "const handler = registry[name];" },
          { line: 7, text: "handler(value)" },
        ],
      },
    ],
  };
}

function expectVerdict(observation, verdict, reason) {
  const result = assessFixtureObservations(observation);
  assert.equal(result.verdict, verdict);
  assert.equal(result.scope, "C07-A-fixture-only");
  assert.match(result.claimBoundary, /not authenticated/);
  if (reason) assert.match(result.reasons.join("\n"), reason);
  return result;
}

test("complete mocked fixture facts pass comparison, not native-route proof", () => {
  const observation = mockObservations();
  const before = JSON.stringify(observation);
  const result = expectVerdict(observation, "PASS");
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.provenance, observation.provenance);
  assert.equal(JSON.stringify(observation), before, "assessment must not mutate observations");
});

test("fact and anchor order do not affect a complete answer", () => {
  const observation = mockObservations();
  observation.facts.reverse();
  observation.facts[0].anchors.reverse();
  expectVerdict(observation, "PASS");
});

test("source-grounded is a preserved declaration, not authentication by the assessor", () => {
  const observation = mockObservations();
  observation.provenance = {
    kind: "source-grounded", reference: "example-pilot-log#answer-1", sourceRevision: "a".repeat(40),
  };
  const result = expectVerdict(observation, "PASS");
  assert.deepEqual(result.provenance, observation.provenance);
  assert.match(result.claimBoundary, /No native-route or provider accuracy proof/);
});

for (const index of [0, 1, 2, 3]) {
  test(`missing oracle fact ${index + 1} rejects a claimed complete answer`, () => {
    const observation = mockObservations();
    const [missing] = observation.facts.splice(index, 1);
    expectVerdict(observation, "FAIL", new RegExp(missing.source.replaceAll(".", "\\.")));
  });
}

const invalidFacts = [
  ["import-only is not a caller", observation => { observation.facts[2].relation = "calls"; }, /Oracle mismatch/],
  ["dynamic dispatch cannot invent the helper target", observation => {
    observation.facts[3].target = "helper.ts#formatLabel";
  }, /Oracle mismatch/],
  ["a fabricated direct target rejects", observation => { observation.facts[0].target = "elsewhere.ts#fake"; }, /Oracle mismatch/],
  ["duplicate direct callers reject even with matching facts", observation => {
    observation.facts.push(structuredClone(observation.facts[0]));
  }, /Duplicate/],
  ["a contradictory duplicate import fact rejects", observation => {
    observation.facts.push({ ...observation.facts[2], relation: "calls" });
  }, /contradictory/],
  ["an out-of-scope caller rejects", observation => {
    observation.facts.push({ ...observation.facts[0], source: "unknown.ts#render" });
  }, /Out-of-scope/],
  ["a path traversal source rejects without reading it", observation => {
    observation.facts[0].source = "../caller-primary.ts#renderPrimary";
  }, /Out-of-scope/],
  ["a missing anchor rejects", observation => { observation.facts[0].anchors = []; }, /source anchors/],
  ["dynamic lookup alone is insufficient without the invocation anchor", observation => {
    observation.facts[3].anchors.pop();
  }, /source anchors/],
  ["duplicated dynamic lookup anchors reject", observation => {
    observation.facts[3].anchors[1] = { ...observation.facts[3].anchors[0] };
  }, /Invalid source anchor/],
  ["an import-line anchor cannot stand in for a call-site anchor", observation => {
    observation.facts[0].anchors[0].line = 1;
  }, /Invalid source anchor/],
  ["invented evidence text rejects", observation => {
    observation.facts[0].anchors[0].text = "formatLabel(invented)";
  }, /Invalid source anchor/],
];
for (const [name, mutate, reason] of invalidFacts) {
  test(name, () => {
    const observation = mockObservations();
    mutate(observation);
    expectVerdict(observation, "FAIL", reason);
  });
}

test("an available empty answer is missing callers, not a PASS", () => {
  const observation = mockObservations();
  observation.facts = [];
  expectVerdict(observation, "FAIL", /Missing oracle facts/);
});

for (const state of ["missing", "unsupported", "partial", "truncated", "stale", "failed"]) {
  test(`${state} evidence stays inconclusive for both empty and otherwise correct facts`, () => {
    const observation = mockObservations();
    observation.availability = state;
    expectVerdict(observation, "INCONCLUSIVE", new RegExp(state));
    observation.facts = [];
    expectVerdict(observation, "INCONCLUSIVE", new RegExp(state));
  });
}

test("unavailable evidence cannot hide contradictory facts", () => {
  const observation = mockObservations();
  observation.availability = "unsupported";
  observation.facts[2].relation = "calls";
  expectVerdict(observation, "FAIL", /Oracle mismatch/);
});

test("malformed inputs and raw native entity graphs are not fixture observations", () => {
  for (const input of [undefined, null, false, 1, "", [], {}, { nodes: [], edges: [] }]) {
    expectVerdict(input, "FAIL", /fixture-only observation envelope/);
  }
});

const malformedObservations = [
  observation => { observation.version = 2; },
  observation => { observation.fixture = "another-project"; },
  observation => { observation.format = "provider-response"; },
  observation => { observation.nodes = []; },
  observation => { observation.availability = "unknown"; },
  observation => { delete observation.availability; },
  observation => { observation.facts = null; },
  observation => { observation.provenance = null; },
  observation => { observation.provenance.kind = "native-verified"; },
  observation => { observation.provenance.reference = " "; },
  observation => { observation.provenance.sourceRevision = "short-sha"; },
  observation => { delete observation.provenance.sourceRevision; },
  observation => { observation.facts[0] = null; },
  observation => { observation.facts[0].availability = "missing"; },
  observation => { delete observation.facts[0].target; },
  observation => { observation.facts[0].anchors = null; },
  observation => { observation.facts[0].anchors[0] = null; },
  observation => { observation.facts[0].anchors[0].line = 0; },
  observation => { observation.facts[0].anchors[0].line = -1; },
  observation => { observation.facts[0].anchors[0].line = 3.5; },
  observation => { observation.facts[0].anchors[0].line = "4"; },
  observation => { observation.facts[0].anchors[0].line = Number.MAX_SAFE_INTEGER + 1; },
  observation => { observation.facts[0].anchors[0].line = 9999; },
  observation => { observation.facts[0].anchors[0].file = "somewhere-else.ts"; },
];
for (const [index, mutate] of malformedObservations.entries()) {
  test(`malformed observation variant ${index + 1} rejects instead of passing or throwing`, () => {
    const observation = mockObservations();
    mutate(observation);
    expectVerdict(observation, "FAIL");
  });
}
