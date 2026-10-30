// C07-A test helper only. This is not a provider, MCP, native graph, or runtime contract.
import { readFileSync } from "node:fs";

const oracle = JSON.parse(readFileSync(new URL("./expected-facts.json", import.meta.url), "utf8"));
const sourceLines = new Map(oracle.facts.map(fact => {
  const file = fact.source.split("#", 1)[0];
  return [file, readFileSync(new URL(file, import.meta.url), "utf8").split(/\r?\n/)];
}));
const availabilityStates = new Set([
  "available", "missing", "unsupported", "partial", "truncated", "stale", "failed",
]);

function hasKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function nonblank(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/** Assess hand-recorded fixture facts, never a raw graph/provider response. */
export function assessFixtureObservations(observation) {
  const result = (verdict, reasons) => ({
    scope: "C07-A-fixture-only",
    verdict,
    reasons,
    provenance: observation?.provenance ?? null,
    claimBoundary: "Fixture comparison only; provenance is declared, not authenticated. No native-route or provider accuracy proof.",
  });
  const fail = reason => result("FAIL", [reason]);

  if (!hasKeys(observation, ["format", "version", "fixture", "availability", "provenance", "facts"])
    || observation.format !== "gsd-graphify-c07-observations"
    || observation.version !== 1 || observation.fixture !== "graphify-known-answer") {
    return fail("Expected a C07-A fixture-only observation envelope, not a native graph or provider response.");
  }
  const provenance = observation.provenance;
  if (!hasKeys(provenance, ["kind", "reference", "sourceRevision"])
    || !["mock", "source-grounded"].includes(provenance.kind)
    || !nonblank(provenance.reference)
    || typeof provenance.sourceRevision !== "string"
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(provenance.sourceRevision)) {
    return fail("Provenance needs a mock/source-grounded kind, nonblank evidence reference, and full source revision.");
  }
  if (!availabilityStates.has(observation.availability) || !Array.isArray(observation.facts)) {
    return fail("Availability must be explicit and facts must be an array.");
  }

  const seen = new Set();
  for (const fact of observation.facts) {
    if (!hasKeys(fact, ["source", "relation", "target", "anchors"])) {
      return fail("Malformed fixture fact: expected source, relation, target, and anchors only.");
    }
    const expected = oracle.facts.find(item => item.source === fact.source);
    if (!expected) return fail("Out-of-scope source: only the four fixture oracle sources are assessable.");
    if (seen.has(fact.source)) return fail(`Duplicate or contradictory facts for ${fact.source}.`);
    seen.add(fact.source);
    if (fact.relation !== expected.relation || fact.target !== expected.target) {
      return fail(`Oracle mismatch for ${fact.source}: expected ${expected.relation} -> ${expected.target}.`);
    }

    const quotes = [expected.sourceEvidence, expected.callEvidence].filter(Boolean);
    if (!Array.isArray(fact.anchors) || fact.anchors.length !== quotes.length) {
      return fail(`Missing or extra source anchors for ${fact.source}.`);
    }
    const file = expected.source.split("#", 1)[0];
    const anchored = new Set();
    for (const anchor of fact.anchors) {
      if (!hasKeys(anchor, ["line", "text"]) || !Number.isSafeInteger(anchor.line)
        || anchor.line < 1 || !quotes.includes(anchor.text) || anchored.has(anchor.text)
        || !sourceLines.get(file)[anchor.line - 1]?.includes(anchor.text)) {
        return fail(`Invalid source anchor for ${fact.source}: use one-based fixture lines and exact oracle evidence.`);
      }
      anchored.add(anchor.text);
    }
  }

  // Unavailable/partial coverage is not an authoritative empty answer, even with correct facts.
  if (observation.availability !== "available") {
    return result("INCONCLUSIVE", [`Evidence is ${observation.availability}; caller completeness is not established.`]);
  }
  const missing = oracle.facts.filter(fact => !seen.has(fact.source));
  if (missing.length > 0) {
    return fail(`Missing oracle facts: ${missing.map(fact => fact.source).join(", ")}.`);
  }
  return result("PASS", []);
}
