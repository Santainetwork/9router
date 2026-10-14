// Regression: undici raises a bare TypeError("terminated") when the upstream
// TLS socket closes mid-stream. The disconnect-aware stream must treat it as a
// graceful transport close (no noisy handleError, no client-facing stream error),
// while a genuine application error must still surface.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDisconnectAwareStream } from "../../open-sse/utils/streamHandler.js";

function makeController() {
  const events = [];
  return {
    events,
    isConnected: () => true,
    handleComplete: () => events.push("complete"),
    handleError: (e) => events.push(["error", e.name, e.message]),
    handleDisconnect: (r) => events.push(["disc", r]),
    abort() {},
  };
}
function throwingTransform(err) {
  return {
    readable: new ReadableStream({ pull() { throw err; } }),
    writable: { getWriter: () => ({ abort: () => Promise.resolve() }) },
  };
}
async function drain(rs) {
  const r = rs.getReader();
  try {
    for (;;) { const { done } = await r.read(); if (done) break; }
    return "closed";
  } catch (e) {
    return `streamerror:${e.name}`;
  }
}

test("TypeError: terminated closes gracefully, releasing the slot via disconnect (no handleError)", async () => {
  const c = makeController();
  const out = await drain(createDisconnectAwareStream(throwingTransform(new TypeError("terminated")), c, null));
  assert.equal(out, "closed");
  assert.equal(c.events.length, 1);
  assert.equal(c.events[0][0], "disc");
  assert.match(c.events[0][1], /terminated/);
});

test("TypeError: terminated with a structured terminal closes without handleError", async () => {
  const c = makeController();
  const out = await drain(createDisconnectAwareStream(throwingTransform(new TypeError("terminated")), c, () => new TextEncoder().encode("data: [DONE]\n\n")));
  assert.equal(out, "closed");
  assert.equal(c.events.length, 1);
  assert.equal(c.events[0][0], "disc");
});

test("a genuine application error still surfaces (not masked as network close)", async () => {
  const c = makeController();
  const out = await drain(createDisconnectAwareStream(throwingTransform(new Error("boom real failure")), c, null));
  assert.equal(out, "streamerror:Error");
  assert.deepEqual(c.events, [["error", "Error", "boom real failure"]]);
});
