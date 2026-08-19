import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../../custom-server.js", import.meta.url), "utf8");

test("custom server owns SIGTERM so Next does not close active streams early", () => {
  assert.match(source, /NEXT_MANUAL_SIG_HANDLE/);
  assert.match(source, /server\.close\(/);
  assert.match(source, /process\.once\(["']SIGTERM["']/);
});
