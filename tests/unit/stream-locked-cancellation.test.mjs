import test from "node:test";
import assert from "node:assert/strict";
import { createDisconnectAwareStream } from "../../open-sse/utils/streamHandler.js";

test("disconnect-aware stream swallows synchronous locked reader and writer cancellation errors", async () => {
  const controller = {
    isConnected: () => true,
    handleComplete() {},
    handleError() {},
    handleDisconnect() {},
  };
  const stream = createDisconnectAwareStream({
    readable: {
      getReader: () => ({
        read: async () => { throw new TypeError("Invalid state: ReadableStream is locked"); },
        cancel: () => { throw new TypeError("Invalid state: ReadableStream is locked"); },
      }),
    },
    writable: {
      getWriter: () => ({
        abort: () => { throw new TypeError("Invalid state: WritableStream is locked"); },
      }),
    },
  }, controller);

  const reader = stream.getReader();
  const result = await reader.read();
  assert.equal(result.done, true);
});
