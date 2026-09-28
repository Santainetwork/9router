import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const server = path.join(root, "custom-server.js");
const standalone = path.join(root, ".next", "standalone");

// custom-server.js ships inside .next/standalone as the process entrypoint.
// Relative ./src requires are NOT traced into the standalone artifact by
// Next's output file tracing, so any such require becomes MODULE_NOT_FOUND
// at boot in production. Keep custom-server.js self-contained: inline the
// logic or require only files the deploy step copies alongside it.
const RELATIVE_REQUIRE = /require\(\s*["']\.\/(src\/[^"']+)["']\s*\)/g;

test("custom-server.js must not require ./src files missing from the standalone artifact", { skip: !existsSync(standalone) && "no standalone build" }, () => {
  const source = readFileSync(server, "utf8");
  const missing = [];
  for (const match of source.matchAll(RELATIVE_REQUIRE)) {
    const target = path.join(standalone, match[1]);
    if (!existsSync(target)) missing.push(match[1]);
  }
  assert.deepEqual(missing, [], `MODULE_NOT_FOUND at boot in .next/standalone for: ${missing.join(", ")}`);
});
