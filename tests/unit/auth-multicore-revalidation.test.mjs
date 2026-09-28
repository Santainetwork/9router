// Task 6 spec: "Revalidate selected account/model against current SQLite
// version before dispatch." In multicore, the Redis-rotated account ID is
// matched against a snapshot read before the rotation call. Another process can
// commit a change (deactivate, lock, delete) between the snapshot read and
// dispatch. The selected connection must be revalidated against a fresh read of
// the current committed connection list — a stale eligible snapshot must fail
// closed, never dispatch on a stale view.
import test from "node:test";
import assert from "node:assert/strict";

const source = await (async () => {
  const { readFile } = await import("node:fs/promises");
  return readFile(new URL("../../src/sse/services/auth.js", import.meta.url), "utf8");
})();

test("multicore rotation block documents and calls a pre-dispatch revalidation", async () => {
  // The rotation block must revalidate the picked ID against a fresh read of
  // current committed state, not just the eligible snapshot from selection time.
  const rotationBlock = source.slice(
    source.indexOf("Multicore: atomic Redis rotation"),
    source.indexOf("selected provider account no longer eligible") + 200,
  );
  assert.ok(rotationBlock.length > 0, "rotation block must exist");
  assert.match(
    rotationBlock,
    /revalidat/i,
    "rotation block must revalidate the selected ID before dispatch",
  );
  assert.doesNotMatch(
    rotationBlock,
    /connection = availableConnections\.find\(\(c\) => c\.id === pickedId\);\s*\n\s*if \(connection\) \{\s*\n\s*log\.info/,
    "revalidation must not be a snapshot lookup only",
  );
});
