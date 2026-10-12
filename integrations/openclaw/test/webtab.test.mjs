import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { GSD_WEB_BASE_PATH, createWebTabHandler, registerWebTab } from "../dist/webtab.js";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function close(server) {
  server.close();
  server.closeAllConnections();
}

test("web tab handler forwards the prefixed path untouched", async () => {
  const seen = {};
  const upstream = createServer((req, res) => {
    seen.url = req.url;
    seen.method = req.method;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);
  const front = createServer((req, res) => {
    void createWebTabHandler(() => ({ port: upstreamPort }))(req, res);
  });
  const frontPort = await listen(front);
  try {
    const response = await fetch(`http://127.0.0.1:${frontPort}${GSD_WEB_BASE_PATH}/api/boot`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(seen.url, `${GSD_WEB_BASE_PATH}/api/boot`);
    assert.equal(seen.method, "GET");
  } finally {
    close(front);
    close(upstream);
  }
});

test("web tab handler reports 503 while the host port is unknown", async () => {
  const front = createServer((req, res) => {
    void createWebTabHandler(() => undefined)(req, res);
  });
  const frontPort = await listen(front);
  try {
    const response = await fetch(`http://127.0.0.1:${frontPort}${GSD_WEB_BASE_PATH}/`);
    assert.equal(response.status, 503);
  } finally {
    close(front);
  }
});

test("registerWebTab registers a gateway-authenticated prefix route and a tab descriptor", () => {
  const calls = { routes: [], descriptors: [], warnings: [] };
  registerWebTab(
    {
      logger: { warn: (message) => calls.warnings.push(message) },
      registerHttpRoute: (params) => calls.routes.push(params),
      session: { controls: { registerControlUiDescriptor: (descriptor) => calls.descriptors.push(descriptor) } },
    },
    () => 4321,
  );
  assert.equal(calls.routes.length, 1);
  assert.equal(calls.routes[0].path, GSD_WEB_BASE_PATH);
  assert.equal(calls.routes[0].auth, "gateway");
  assert.equal(calls.routes[0].match, "prefix");
  assert.equal(calls.descriptors.length, 1);
  assert.equal(calls.descriptors[0].surface, "tab");
  assert.equal(calls.descriptors[0].label, "GSD");
  assert.equal(calls.descriptors[0].path, `${GSD_WEB_BASE_PATH}/`);
  assert.equal(calls.warnings.length, 0);
});

test("registerWebTab warns instead of throwing when the gateway lacks HTTP routes", () => {
  const warnings = [];
  registerWebTab({ logger: { warn: (message) => warnings.push(message) } }, () => undefined);
  assert.equal(warnings.length, 1);
});

