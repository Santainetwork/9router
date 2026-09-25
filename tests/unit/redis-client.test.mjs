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

// Regression: a second connect() on a client that is already connecting resolves
// before the socket is ready, so concurrent callers got a client that rejects every
// command as offline. Concurrent callers must share one in-flight connection.
test("concurrent command callers share one in-flight connection", async () => {
  const calls = [];
  let finishConnect;
  const createClient = () => {
    const client = {
      isOpen: false,
      on() { return client; },
      connect() {
        calls.push("connect");
        return new Promise((resolve) => {
          finishConnect = () => { client.isOpen = true; resolve(); };
        });
      },
      async close() { client.isOpen = false; },
      destroy() {},
    };
    return client;
  };

  const manager = createRedisManager({ url: "redis://cache:6379", createClient });
  const first = manager.command();
  const second = manager.command();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((call) => call === "connect").length, 1);

  finishConnect();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.equal(a.isOpen, true);
  await manager.close();
});

// Regression: node-redis marks a client open the moment connect() starts, so a
// concurrent caller that only checks isOpen gets a client whose socket is not ready
// and every command fails with "The client is offline". Callers must await the
// in-flight connect, and a dedicated connection must be ready when handed out.
test("concurrent command and dedicated callers never receive a client before its socket is ready", async () => {
  const connects = [];
  const createClient = () => {
    const client = {
      isOpen: false,
      ready: false,
      on() { return client; },
      connect() {
        client.isOpen = true;
        return new Promise((resolve) => {
          connects.push(() => { client.ready = true; resolve(); });
        });
      },
      async eval() {
        if (!client.ready) throw new Error("The client is offline");
        return "1-0";
      },
      async blPop() {
        if (!client.ready) throw new Error("The client is offline");
        return null;
      },
      async close() { client.isOpen = false; },
      destroy() { client.isOpen = false; },
    };
    return client;
  };

  const manager = createRedisManager({ url: "redis://cache:6379", createClient });
  const first = manager.command();
  const second = manager.command();
  const dedicated = manager.dedicated();
  let settledEarly = false;
  second.then(() => { settledEarly = true; });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(connects.length, 2, "command slot shares one connect and dedicated opens its own");
  assert.equal(settledEarly, false, "command caller resolved before its socket was ready");

  for (const release of connects) release();
  const [a, b, d] = await Promise.all([first, second, dedicated]);
  assert.equal(a, b);
  assert.equal(await b.eval("return 1", { keys: [], arguments: [] }), "1-0");
  assert.equal(await d.blPop("n:receipt:x", 0.1), null);
  await manager.close();
});
