import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

const sidebar = readFileSync(join(root, "src/shared/components/Sidebar.js"), "utf8");

test("sidebar renders exactly one desktop width class", () => {
  const aside = sidebar.match(/<aside className=\{([\s\S]*?)\}>/);
  assert.ok(aside, "sidebar aside element must exist");
  const cls = aside[1];
  // `cn` only joins class names, so emitting both widths lets CSS source order decide.
  assert.doesNotMatch(cls, /lg:w-72"[^)]*lg:w-20/, "compact must not stack lg:w-20 on lg:w-72");
  assert.match(cls, /compact \? "lg:w-20" : "lg:w-72"/, "desktop width must be chosen by compact state");
});
