import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

const sidebar = readFileSync(join(root, "src/shared/components/Sidebar.js"), "utf8");
const layout = readFileSync(join(root, "src/shared/components/layouts/DashboardLayout.js"), "utf8");

test("sidebar renders exactly one desktop width class", () => {
  const aside = sidebar.match(/<aside className=\{([\s\S]*?)\}>/);
  assert.ok(aside, "sidebar aside element must exist");
  const cls = aside[1];
  // `cn` only joins class names, so emitting both widths lets CSS source order decide.
  assert.doesNotMatch(cls, /lg:w-64"[^)]*lg:w-16/, "compact must not stack lg:w-16 on lg:w-64");
  assert.match(cls, /compact \? "lg:w-16" : "lg:w-64"/, "desktop width must be chosen by compact state");
});

test("compact sidebar uses a narrow centered icon rail", () => {
  assert.match(sidebar, /compact \? "lg:w-16" : "lg:w-64"/);
  assert.match(sidebar, /compact && "lg:px-2"/);
  assert.match(sidebar, /compact && "lg:justify-center lg:gap-0 lg:px-0"/);
  assert.match(sidebar, /compact && "lg:hidden"/);
});

test("dashboard content uses compact responsive padding", () => {
  assert.match(layout, /"px-3 py-4 sm:p-5 lg:p-6"/);
  assert.doesNotMatch(layout, /lg:p-10/);
});
