import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../../src/app/(dashboard)/dashboard/combos/page.js", import.meta.url),
  "utf8"
);

test("combo page renders the filtered result in the searchable legacy card grid", () => {
  assert.match(source, /grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4/);
  assert.match(source, /return filteredCombos\.map\(\(combo\) =>/);
  assert.doesNotMatch(source, /return combos\.map\(\(combo\) =>/);
});

test("select all is scoped to visible filtered combos", () => {
  assert.match(source, /filteredCombos\.map\(\(combo\) => combo\.id\)/);
});

test("v0.5.85 combo compatibility remains enabled", () => {
  assert.match(source, /aggregateComboCapabilities/);
  assert.match(source, /upgradeLegacyModel/);
  assert.match(source, /mimo-v2\.6-flash-free/);
});
