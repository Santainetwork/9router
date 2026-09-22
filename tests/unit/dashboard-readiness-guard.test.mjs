import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./helpers/alias-loader.mjs", import.meta.url));

process.env.NODE_ENV = "production";
process.env.NINEROUTER_PEER_TOKEN = "readiness-peer-token";

const { proxy } = await import(`../../src/dashboardGuard.js?readiness=${Date.now()}`);

function request(headers = {}, method = "GET") {
  return {
    method,
    url: "http://router.example.com/api/ready",
    nextUrl: new URL("http://router.example.com/api/ready"),
    headers: new Headers(headers),
    cookies: { get: () => undefined },
  };
}

test("dashboard guard allows readiness only from the trusted loopback peer", async () => {
  const local = await proxy(request({
    "x-9r-real-ip": "127.0.0.1",
    "x-9r-peer-token": process.env.NINEROUTER_PEER_TOKEN,
  }));
  assert.equal(local.headers.get("x-middleware-next"), "1");

  for (const headers of [
    {},
    { "x-9r-real-ip": "127.0.0.1", "x-9r-peer-token": "forged" },
    { "x-9r-real-ip": "203.0.113.7", "x-9r-peer-token": process.env.NINEROUTER_PEER_TOKEN },
    { "x-9r-real-ip": "127.0.0.1", "x-9r-peer-token": process.env.NINEROUTER_PEER_TOKEN, "x-9r-via-proxy": "1" },
    { "x-9r-cli-token": "valid-cli-token" },
  ]) {
    const remote = await proxy(request(headers));
    assert.equal(remote.status, 404);
    assert.deepEqual(await remote.json(), { error: "Not found" });
  }
});

test("dashboard guard denies remote readiness preflight", async () => {
  const remote = await proxy(request({}, "OPTIONS"));
  assert.equal(remote.status, 404);
  assert.deepEqual(await remote.json(), { error: "Not found" });
});
