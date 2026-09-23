import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

const read = (path) => readFileSync(join(root, path), "utf8");

test("native installer gives control and API workers a 1024 MiB heap", () => {
  const source = read("scripts/install.sh");
  const matches = source.match(/NODE_OPTIONS=--max-old-space-size=1024/g) || [];
  assert.equal(matches.length, 3);
  assert.doesNotMatch(source, /NODE_OPTIONS=--max-old-space-size=512/);
});
