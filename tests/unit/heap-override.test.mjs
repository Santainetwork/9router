import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

const read = (path) => readFileSync(join(root, path), "utf8");

test("native installer keeps control at 512 MiB and gives API workers 1024 MiB", () => {
  const source = read("scripts/install.sh");
  const control = source.match(/NODE_OPTIONS=--max-old-space-size=512/g) || [];
  const workers = source.match(/Environment=NODE_OPTIONS=--max-old-space-size=1024/g) || [];
  assert.equal(control.length, 2);
  assert.equal(workers.length, 1);
});
