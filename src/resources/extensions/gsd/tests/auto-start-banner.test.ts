/**
 * Dynamic routing start banner — honesty about an unresolved session model.
 *
 * Regression background: parallel workers can reach startAutoMode while the
 * session model is still the unknown/unknown placeholder (provider
 * registration in flight). The banner must never present the placeholder as
 * the model to be used; it reports that the session model is unresolved so
 * the message cannot mislead during future registry races.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { formatDynamicRoutingBanner, isPlaceholderSessionModel } from "../auto-start-banner.js";

const PLACEHOLDER = { provider: "unknown", id: "unknown", api: "unknown" };

test("isPlaceholderSessionModel matches the repairPlaceholderModel predicate", () => {
	assert.equal(isPlaceholderSessionModel(PLACEHOLDER), true, "the startup placeholder is a placeholder");
	assert.equal(isPlaceholderSessionModel({ provider: "ollama", id: "glm-5.3:cloud", api: "ollama-chat" }), false);
	assert.equal(isPlaceholderSessionModel(undefined), false, "no model is not a placeholder");
});

test("disabled routing with a real model keeps the exact current message", () => {
	const message = formatDynamicRoutingBanner({
		effectivelyEnabled: false,
		startModel: { provider: "ollama", id: "glm-5.3:cloud" },
		sessionModel: { provider: "ollama", id: "glm-5.3:cloud", api: "ollama-chat" },
	});
	assert.equal(message, "Dynamic routing: disabled — all tasks will use ollama/glm-5.3:cloud");
});

test("disabled routing with a placeholder session model reports unresolved, never unknown/unknown", () => {
	const message = formatDynamicRoutingBanner({
		effectivelyEnabled: false,
		startModel: null,
		sessionModel: PLACEHOLDER,
	});
	assert.ok(!message.includes("unknown/unknown"), "must not print the placeholder as the model: " + message);
	assert.match(message, /disabled — session model unresolved/, "must say the model is unresolved: " + message);
	assert.match(message, /providers may still be registering/, "must say why: " + message);
});

test("a real start-model snapshot wins over a placeholder live model", () => {
	const message = formatDynamicRoutingBanner({
		effectivelyEnabled: false,
		startModel: { provider: "ollama", id: "deepseek-v4-pro:cloud" },
		sessionModel: PLACEHOLDER,
	});
	assert.equal(message, "Dynamic routing: disabled — all tasks will use ollama/deepseek-v4-pro:cloud");
});

test("enabled routing keeps the current ceiling message", () => {
	const message = formatDynamicRoutingBanner({
		effectivelyEnabled: true,
		startModel: { provider: "ollama", id: "glm-5.3:cloud" },
		sessionModel: { provider: "ollama", id: "glm-5.3:cloud", api: "ollama-chat" },
	});
	assert.equal(message, "Dynamic routing: enabled — simple tasks may use cheaper models (ceiling: ollama/glm-5.3:cloud)");
});

test("enabled routing uses the heavy tier pin as the ceiling when configured", () => {
	const message = formatDynamicRoutingBanner({
		effectivelyEnabled: true,
		heavyTierModel: "glm-5.3:cloud",
		startModel: { provider: "ollama", id: "glm-5.3-flash:cloud" },
		sessionModel: { provider: "ollama", id: "glm-5.3-flash:cloud", api: "ollama-chat" },
	});
	assert.ok(message.includes("ceiling: glm-5.3:cloud"), "tier pin must win: " + message);
});

test("enabled routing with a placeholder model reports the ceiling as unresolved", () => {
	const message = formatDynamicRoutingBanner({
		effectivelyEnabled: true,
		startModel: null,
		sessionModel: PLACEHOLDER,
	});
	assert.ok(!message.includes("unknown/unknown"), "must not print the placeholder as the ceiling: " + message);
	assert.match(message, /ceiling: unresolved/, "must say the ceiling is unresolved: " + message);
});

test("no model at all keeps the legacy 'default' label", () => {
	const message = formatDynamicRoutingBanner({
		effectivelyEnabled: false,
		startModel: null,
		sessionModel: undefined,
	});
	assert.equal(message, "Dynamic routing: disabled — all tasks will use default");
});