import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const queue = readFileSync(
  fileURLToPath(new URL("../../src/app/(dashboard)/dashboard/queue-monitor/QueueMonitorClient.js", import.meta.url)),
  "utf8"
);

test("queue API resolves redacted snapshot keys to readable targets", () => {
  const api = readFileSync(
    fileURLToPath(new URL("../../src/app/api/queue/route.js", import.meta.url)),
    "utf8"
  );
  assert.match(api, /createHash\("sha256"\)[\s\S]*digest\("hex"\)/);
  assert.match(api, /new Map\(allProviders\.map\(\(c\) => \[snapshotKey\(c\.id\), c\]\)\)/);
  assert.match(api, /goBucketMap\.get\(`provider:\$\{snapshotKey\(c\.id\)\}`\)/);
  assert.match(api, /resetKey:\s*target\?\.id/);
  assert.match(queue, /handleReset\(b\.scope, b\.resetKey \|\| b\.key\)/);
});

test("live queue displays readable target labels instead of raw UID", () => {
  assert.match(queue, /<TableHead>Target<\/TableHead>/);
  assert.match(queue, /\{b\.label \|\| b\.key\}/);
  assert.doesNotMatch(queue, /<TableCell className="font-mono text-xs text-text-muted">\{b\.key\}<\/TableCell>/);
});
