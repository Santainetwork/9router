// Static checks for item 5 UI/UX work. No server or dependency required.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");
const dashboard = src("src/app/(dashboard)/dashboard/DashboardOverviewClient.js");
const queue = src("src/app/(dashboard)/dashboard/queue-monitor/QueueMonitorClient.js");
const usageCheck = src("src/app/usage-check/page.js");
const publicPortal = src("deploy/usage-check.html");

test("dashboard has Go gateway topology and setup path", () => {
  assert.match(dashboard, /Gateway topology/);
  for (const port of [":20128", ":20129", ":20140"]) assert.ok(dashboard.includes(port));
  assert.match(dashboard, /aria-labelledby="gateway-topology-title"/);
  assert.match(dashboard, /Finish setup/);
  assert.match(dashboard, /href="\/dashboard\/providers"/);
  assert.match(dashboard, /href="\/dashboard\/endpoint"/);
  assert.match(dashboard, /grid-cols-1 sm:grid-cols-2 lg:grid-cols-4/);
});

test("queue monitor and usage portals retain mobile and accessibility controls", () => {
  assert.match(queue, /px-4 sm:px-0/);
  assert.match(queue, /aria-label="Search keys, providers, or ids"/);
  assert.match(queue, /aria-label=\{paused \? "Resume live polling" : "Pause live polling"\}/);
  for (const code of [usageCheck, publicPortal]) assert.match(code, /role="progressbar"/);
  assert.match(usageCheck, /aria-pressed=\{liveActive\}/);
  assert.match(publicPortal, /<label class="label-title" for="key">/);
});
