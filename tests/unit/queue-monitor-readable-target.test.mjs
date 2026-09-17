import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const queue = readFileSync(
  fileURLToPath(new URL("../../src/app/(dashboard)/dashboard/queue-monitor/QueueMonitorClient.js", import.meta.url)),
  "utf8"
);

test("live queue displays readable target labels instead of raw UID", () => {
  assert.match(queue, /<TableHead>Target<\/TableHead>/);
  assert.match(queue, /\{b\.label \|\| b\.key\}/);
  assert.doesNotMatch(queue, /<TableCell className="font-mono text-xs text-text-muted">\{b\.key\}<\/TableCell>/);
});
