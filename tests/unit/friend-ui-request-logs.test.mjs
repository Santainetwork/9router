import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const source = (path) => readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");

test("Friend CSS variant tokens complete", () => {
  const css = source("app/globals.css");

  assert.match(css, /html\[data-ui-variant="friend"\]/, "friend variant block must exist");
  assert.match(css, /--color-brand-25:\s*#f2f7ff/, "friend brand-25 token");
  assert.match(css, /--color-brand-950:\s*#161950/, "friend brand-950 token");
  assert.match(css, /--radius-brand:\s*8px/, "friend radius-brand 8px");
  assert.match(css, /--radius-brand-lg:\s*12px/, "friend radius-brand-lg 12px");
  assert.match(css, /--shadow-elev:\s*0\s+20px\s+24px/, "friend shadow-elev");
  assert.match(css, /--shadow-focus:\s*0\s+0\s+0\s+4px/, "friend shadow-focus");
  assert.match(css, /--color-danger:\s*#b42318/, "friend danger status color");
  assert.match(css, /--color-success:\s*#027a48/, "friend success status color");
});

test("Request logs route exists", () => {
  assert.ok(
    existsSync(new URL("../../src/app/(dashboard)/dashboard/request-logs/page.js", import.meta.url)),
    "request-logs page.js must exist"
  );
  const page = source("app/(dashboard)/dashboard/request-logs/page.js");
  assert.match(page, /RequestLogsClient/, "request-logs page must use inbound request log UI");
  assert.match(page, /Request Logs/i, "must have request logs title");
});

test("Request logs navigation appears in both dashboard themes", () => {
  const sidebar = source("shared/components/Sidebar.js");
  const sidebarAlt = source("shared/components/SidebarAlt.js");

  assert.match(sidebar, /\/dashboard\/request-logs/, "Santai sidebar links request-logs");
  assert.match(sidebar, /Request Logs/, "Santai sidebar labels request-logs");
  assert.match(sidebarAlt, /\/dashboard\/request-logs/, "Friend sidebar links request-logs");
  assert.match(sidebarAlt, /Request Logs/, "Friend sidebar labels request-logs");
});

test("Existing apiKeys allowedModels RBAC retained, no allowedEndpoints duplication", () => {
  const schema = source("lib/db/schema.js");
  // Production already has advanced RBAC: allowedModels allowlist + isModelAllowedBy.
  // PR #4560 RBAC (allowedModels/allowedEndpoints modal) is skipped per user request.
  assert.match(schema, /allowedModels:\s*"TEXT"/, "existing allowedModels column retained");
  assert.doesNotMatch(schema, /allowedEndpoints/, "no PR RBAC allowedEndpoints column added");
});

test("Inbound request log table is separate from provider request details", () => {
  const schema = source("lib/db/schema.js");
  assert.match(schema, /requestLogs:/, "inbound requests need dedicated storage");
  assert.match(schema, /requestDetails:/, "provider-side request details stay intact");
  assert.doesNotMatch(schema, /allowedEndpoints/, "skip duplicate PR RBAC");
});
