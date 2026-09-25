import test from "node:test";
import assert from "node:assert/strict";
import { createRedisManager } from "../../src/lib/redis/client.js";

function fakeFactory(calls) {
  return (options) => {
    const client = {
      isOpen: false,
      on() { return client; },
      async connect() { client.isOpen = true; calls.push("connect"); },
      async ping() { calls.push("ping"); return "PONG"; },
      async close() { client.isOpen = false; calls.push("close"); },
      destroy() { client.isOpen = false; calls.push("destroy"); },
    };
    calls.push(options);
    return client;
  };
}

test("Redis manager uses bounded fail-closed client options and separate blocking connection", async () => {
  const calls = [];
  const manager = createRedisManager({ url: "rediss://user:pass@cache.example:6380/2", createClient: fakeFactory(calls) });
  const command = await manager.command();
  const blocking = await manager.blocking();
  assert.notEqual(command, blocking);
  const options = calls.filter((v) => typeof v === "object");
  assert.equal(options.length, 2);
  for (const option of options) {
    assert.equal(option.url, "rediss://user:pass@cache.example:6380/2");
    assert.equal(option.disableOfflineQueue, true);
    assert.ok(option.socket.connectTimeout > 0);
    assert.ok(option.commandOptions.timeout > 0);
    assert.equal(option.socket.reconnectStrategy(99), false);
  }
  assert.equal(await manager.health(), true);
  await manager.close();
  assert.equal(command.isOpen, false);
  assert.equal(blocking.isOpen, false);
});

test("Redis manager redacts URL and fails health closed", async () => {
  const createClient = () => {
    const client = { isOpen: false, on() { return client; }, async connect() { throw new Error("connect redis://u:secret@host"); }, destroy() {} };
    return client;
  };
  const manager = createRedisManager({ url: "redis://u:secret@host:6379", createClient });
  assert.equal(await manager.health(), false);
  assert.doesNotMatch(JSON.stringify(manager.status()), /secret|redis:\/\//);
});
