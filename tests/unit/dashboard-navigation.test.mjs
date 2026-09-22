import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (file) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");

test("dashboard shell exposes responsive navigation and accessible loading primitives", () => {
  const layout = read("src/shared/components/layouts/DashboardLayout.js");
  const sidebar = read("src/shared/components/Sidebar.js");
  const loading = read("src/shared/components/Loading.js");
  const header = read("src/shared/components/Header.js");

  assert.match(header, /aria-label=["']Open navigation/);
  assert.match(header, /<nav aria-label="Breadcrumb"/);
  assert.match(layout, /aria-modal=/);
  assert.match(layout, /Escape/);
  assert.match(sidebar, /aria-current=\{isActive\(item\.href\) \? "page"/);
  assert.match(sidebar, /compact/);
  assert.match(sidebar, /title=\{compact \? item\.label/);
  assert.match(header, /title: "Overview"/);
  assert.match(loading, /export function TableSkeleton/);
  assert.match(loading, /motion-safe:animate-pulse/);
  assert.match(layout, /try \{ globalThis\.localStorage/);
  assert.doesNotMatch(sidebar, /transition-\[width\]/);
});
