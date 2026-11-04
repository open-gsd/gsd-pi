/**
 * Unit tests for cloud-model price resolution (ollama cloud cost reporting).
 *
 * The flash tier is the trap: glm-5.3 and glm-5.3-flash differ ~10x, so
 * resolution must be exact-ID (plus explicit aliases), never prefix
 * inference. These tests pin that invariant and the suffix-stripping rules
 * for daemon names ("glm-5.3-flash:cloud", "gpt-oss:120b-cloud").
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
	cloudModelKey,
	resolveCloudModelCost,
	CLOUD_MODEL_PRICES,
	CLOUD_MODEL_ALIASES,
	CLOUD_PRICES_SNAPSHOT_DATE,
	STALE_PRICE_SNAPSHOT_DAYS,
	priceSnapshotAgeDays,
	stalePriceSnapshotMessage,
} from "./cloud-prices.js";

test("cloudModelKey strips the ':cloud' marker", () => {
	assert.equal(cloudModelKey("glm-5.3-flash:cloud"), "glm-5.3-flash");
	assert.equal(cloudModelKey("glm-5.3:cloud"), "glm-5.3");
});

test("cloudModelKey strips the '-cloud' marker (tag-form cloud names)", () => {
	assert.equal(cloudModelKey("gpt-oss:120b-cloud"), "gpt-oss:120b");
	assert.equal(cloudModelKey("qwen3.5:397b-cloud"), "qwen3.5:397b");
});

test("cloudModelKey does not classify bare '-cloud' local names as cloud-routed", () => {
	// Real daemon cloud names are always "name:tag-cloud" — a colon precedes
	// the tag. A local model named "my-model-cloud" (no colon) must stay
	// local: free, and no drift notice.
	assert.equal(cloudModelKey("my-model-cloud"), undefined);
	assert.equal(cloudModelKey("cloud"), undefined);
});

test("cloudModelKey rejects degenerate marker-only names", () => {
	assert.equal(cloudModelKey(":cloud"), undefined);
	assert.equal(cloudModelKey("-cloud"), undefined);
});

test("cloudModelKey returns undefined for local models", () => {
	assert.equal(cloudModelKey("qwen2.5-coder:7b"), undefined);
	assert.equal(cloudModelKey("llama3"), undefined);
});

test("flash siblings resolve to their own rates, never each other's (the ~10x trap)", () => {
	const glm = resolveCloudModelCost("glm-5.3:cloud");
	const glmFlash = resolveCloudModelCost("glm-5.3-flash:cloud");
	assert.ok(glm && glmFlash);
	assert.equal(glm.input, 1.4);
	assert.equal(glm.output, 4.4);
	assert.equal(glmFlash.input, 0.15);
	assert.equal(glmFlash.output, 0.5);
	assert.notEqual(glm.input, glmFlash.input);
});

test("deepseek siblings stay distinct", () => {
	const pro = resolveCloudModelCost("deepseek-v4-pro:cloud");
	const flash = resolveCloudModelCost("deepseek-v4.1-flash:cloud");
	// On-peak rates are registered by decision (cost reads high, never low).
	assert.ok(pro && flash);
	assert.equal(pro.input, 1.32);
	assert.equal(pro.output, 3.96);
	assert.equal(flash.input, 0.3);
	assert.equal(flash.output, 1.2);
});

test("explicit aliases resolve to their target's rates", () => {
	// Each alias in the daemon-form suffix it actually appears with — both
	// stripping rules are exercised through the alias path.
	assert.deepEqual(resolveCloudModelCost("gemma4:31b-cloud"), resolveCloudModelCost("gemma4:cloud"));
	assert.deepEqual(resolveCloudModelCost("gemma4:31b:cloud"), resolveCloudModelCost("gemma4:cloud"));
	assert.deepEqual(
		resolveCloudModelCost("mistral-large-3:675b-cloud"),
		resolveCloudModelCost("mistral-large-3:cloud"),
	);
	assert.deepEqual(
		resolveCloudModelCost("nemotron-3-nano:30b-cloud"),
		resolveCloudModelCost("nemotron-3-nano:cloud"),
	);
	assert.deepEqual(
		resolveCloudModelCost("deepseek-v4.1-flash:1017-cloud"),
		resolveCloudModelCost("deepseek-v4.1-flash:cloud"),
	);
});

test("aliases never shadow a direct table entry", () => {
	// If a key ever appears both as alias and direct entry, the direct
	// entry must win so a table update can't be silently masked.
	for (const [alias, target] of Object.entries(CLOUD_MODEL_ALIASES)) {
		assert.equal(alias in CLOUD_MODEL_PRICES, false, `${alias} must not also be a direct entry`);
		assert.ok(target in CLOUD_MODEL_PRICES, `alias target ${target} must exist`);
	}
});

test("unknown cloud model resolves to undefined — never a family guess", () => {
	// glm-5.3 is in the table, but glm-5.4 must not inherit its rates
	// through any prefix path.
	assert.equal(resolveCloudModelCost("glm-5.4:cloud"), undefined);
	assert.equal(resolveCloudModelCost("some-new-model:cloud"), undefined);
});

test("local model resolves to undefined", () => {
	assert.equal(resolveCloudModelCost("qwen2.5-coder:7b"), undefined);
});

test("every table entry has positive rates", () => {
	for (const [id, rates] of Object.entries(CLOUD_MODEL_PRICES)) {
		assert.ok(rates.input > 0, `${id} input rate must be positive`);
		assert.ok(rates.output > 0, `${id} output rate must be positive`);
	}
});

test("snapshot date is a valid ISO date at or before today", () => {
	const parsed = new Date(`${CLOUD_PRICES_SNAPSHOT_DATE}T00:00:00Z`);
	assert.ok(!Number.isNaN(parsed.getTime()), "snapshot date must parse as ISO yyyy-mm-dd");
	assert.ok(parsed.getTime() <= Date.now(), "snapshot date must not be in the future");
});

test("priceSnapshotAgeDays counts days since the snapshot, not since the epoch", () => {
	assert.equal(priceSnapshotAgeDays(new Date("2026-11-04T00:00:00Z")), 0);
	assert.equal(priceSnapshotAgeDays(new Date("2026-12-04T00:00:00Z")), 30);
});

test("stalePriceSnapshotMessage stays quiet for a fresh snapshot", () => {
	assert.equal(stalePriceSnapshotMessage(new Date("2026-11-04T12:00:00Z")), undefined);
	// Just inside the staleness threshold.
	const justStale = new Date(`${CLOUD_PRICES_SNAPSHOT_DATE}T00:00:00Z`);
	justStale.setUTCDate(justStale.getUTCDate() + STALE_PRICE_SNAPSHOT_DAYS - 1);
	assert.equal(stalePriceSnapshotMessage(justStale), undefined);
});

test("stalePriceSnapshotMessage names the snapshot date once the threshold passes", () => {
	// Exactly at the threshold — the message must already be present.
	const atThreshold = new Date(`${CLOUD_PRICES_SNAPSHOT_DATE}T00:00:00Z`);
	atThreshold.setUTCDate(atThreshold.getUTCDate() + STALE_PRICE_SNAPSHOT_DAYS);
	const atThresholdMessage = stalePriceSnapshotMessage(atThreshold);
	assert.ok(atThresholdMessage, "message must be present exactly at the threshold");

	const stale = new Date(`${CLOUD_PRICES_SNAPSHOT_DATE}T00:00:00Z`);
	stale.setUTCDate(stale.getUTCDate() + STALE_PRICE_SNAPSHOT_DAYS + 10);
	const message = stalePriceSnapshotMessage(stale);
	assert.ok(message, "message must be present");
	assert.ok(message.includes(CLOUD_PRICES_SNAPSHOT_DATE), "message must name the snapshot date");
	assert.ok(message.includes("ollama.com/pricing"), "message must point at the authoritative source");
});
