// Regression guard for b7202637: the withWorkerRefusal refactor renamed the
// exported wrapper to doHandleEmbeddings while an inner function of the same
// name already existed. No unit suite parses the handler files as ES modules,
// so `npm run verify` stayed green while `next build` failed to parse. Pure
// syntax check (stdin, --input-type=module) needs no bundler aliases.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const handlersDir = path.join(REPO_ROOT, "src", "sse", "handlers");

test("every sse handler file parses as an ES module", () => {
  const names = readdirSync(handlersDir).filter((n) => n.endsWith(".js"));
  assert.ok(names.length >= 8, `expected the full handler set, found ${names.length}`);
  for (const name of names) {
    const source = readFileSync(path.join(handlersDir, name), "utf8");
    const check = spawnSync(process.execPath, ["--input-type=module", "--check"], {
      input: source,
      encoding: "utf8",
    });
    assert.equal(
      check.status,
      0,
      `${name} must parse: ${check.stderr.slice(0, 300)}`,
    );
  }
});
