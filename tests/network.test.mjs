import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  endpointFetch,
  privateAddress,
  validateNetwork,
} from "../packages/platform/network.ts";
import { CredentialStore } from "../packages/platform/credentials.ts";

test("private policy rejects public, metadata, mapped IPv6, missing pins and cloud mode", () => {
  for (const address of [
    "8.8.8.8",
    "169.254.169.254",
    "::ffff:127.0.0.1",
    "fe80::1",
  ])
    assert.equal(privateAddress(address), false);
  for (const address of [
    "10.2.3.4",
    "172.16.4.2",
    "192.168.1.1",
    "127.0.0.1",
    "fd00::1",
    "::1",
  ])
    assert.equal(privateAddress(address), true);
  for (const p of [
    { url: "https://private.test", boundary: "sovereign" },
    { url: "https://10.0.0.1", boundary: "cloud" },
    {
      url: "https://private.test",
      boundary: "sovereign",
      addresses: ["8.8.8.8"],
    },
    {
      url: "https://10.0.0.1",
      boundary: "sovereign",
      addresses: ["127.0.0.1"],
    },
  ])
    assert.throws(() => validateNetwork({ ...p, zeroEgress: true }));
});
test("sovereign simulator: no DNS, no transport fallback, JSON streaming and redirects denied", async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: "https://public.invalid" });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    res.write('{"source":"private"}\n');
    res.end('{"offline":true}\n');
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = "http://unresolvable.invalid:" + server.address().port;
  const p = {
    url,
    boundary: "sovereign",
    zeroEgress: true,
    addresses: ["127.0.0.1"],
  };
  const forbidden = async () => {
    throw Error("Public transport was invoked");
  };
  try {
    const r = await endpointFetch(
      p,
      url + "/api/agent/v1/capabilities",
      {},
      forbidden,
    );
    assert.match(await r.text(), /private/);
    await assert.rejects(
      endpointFetch(p, url + "/redirect", {}, forbidden),
      /redirect denied/,
    );
    await assert.rejects(
      endpointFetch(p, "https://public.invalid/api", {}, forbidden),
      /outside/,
    );
    assert.equal(hits, 2);
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      endpointFetch(p, url + "/api", { signal: ac.signal }, forbidden),
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});
test("headless credentials cannot cross profile boundaries", () => {
  const old = process.env.SARION_TOKEN,
    binding = process.env.SARION_TOKEN_PROFILE;
  try {
    process.env.SARION_TOKEN = "opaque-fixture";
    process.env.SARION_TOKEN_PROFILE = "private@https://private.test";
    const store = new CredentialStore();
    assert.equal(store.token("private@https://private.test"), "opaque-fixture");
    assert.throws(
      () => store.token("cloud@https://cloud.test"),
      /explicitly bound/,
    );
  } finally {
    if (old === undefined) delete process.env.SARION_TOKEN;
    else process.env.SARION_TOKEN = old;
    if (binding === undefined) delete process.env.SARION_TOKEN_PROFILE;
    else process.env.SARION_TOKEN_PROFILE = binding;
  }
});

test("private protocol discovery, model isolation, identity pinning and failure without cloud fallback", async () => {
  const { sovereignSimulator } = await import(
    "../scripts/sovereign-simulator.mjs"
  );
  const { CortexClient } = await import("../packages/cortex-client/index.ts");
  const { server, url } = await sovereignSimulator();
  try {
    const p = { url, boundary: "sovereign", zeroEgress: true };
    const c = new CortexClient(
      p,
      () => "simulator-only-not-a-real-credential",
      async () => {
        throw Error("Public fallback");
      },
    );
    const caps = await c.capabilities(AbortSignal.timeout(3000));
    assert.equal(caps.boundary.kind, "sovereign");
    assert.equal(caps.models[0].eligible, false);
    assert.equal((await c.request("/models")).models.length, 1);
    await assert.rejects(
      c.request("/sessions", {}),
      /Simulator has no inference/,
    );
    p.boundaryId = "foreign-private";
    await assert.rejects(
      c.capabilities(AbortSignal.timeout(3000)),
      /identity changed/,
    );
    await assert.rejects(
      new CortexClient(
        { ...p, boundaryId: undefined },
        () => "wrong",
      ).capabilities(AbortSignal.timeout(3000)),
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});
