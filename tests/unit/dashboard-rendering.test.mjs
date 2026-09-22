import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = (path) => readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");

const usageStats = source("shared/components/UsageStats.js");
const usageTable = source("app/(dashboard)/dashboard/usage/components/UsageTable.js");
const consoleLog = source("app/(dashboard)/dashboard/console-log/ConsoleLogClient.js");
const translator = source("app/(dashboard)/dashboard/translator/page.js");

test("UsageStats memoizes heavy children so SSE ticks do not re-render them", () => {
  assert.match(usageStats, /import \{[^}]*\bmemo\b[^}]*\} from "react"/);
  // Chart + topology only mount on the loaded path and must be stable references
  assert.match(usageStats, /const ProviderTopology = dynamic\(/);
  assert.match(usageStats, /const UsageChart = dynamic\(|import UsageChart from/);
  assert.ok(
    /memo\(UsageChart\)|const UsageChart = memo\(/.test(usageStats),
    "UsageChart must be wrapped in memo()"
  );
  assert.ok(
    /memo\(RecentRequests\)|const RecentRequests = memo\(/.test(usageStats),
    "RecentRequests must be wrapped in memo()"
  );
  // Provider list derived once, stable identity for the topology subtree
  assert.match(usageStats, /useMemo\(\s*\(\) =>/);
});

test("UsageTable memoizes row/cell subtrees and isolates expanded state persistence", () => {
  assert.match(usageTable, /import \{[^}]*\bmemo\b[^}]*\} from "react"/);
  assert.ok(
    /const ValueCells = memo\(|memo\(ValueCells\)/.test(usageTable),
    "ValueCells must be memoized so token/cost cells skip re-render"
  );
  // localStorage write must not run on first mount with an empty set
  assert.match(usageTable, /useState\(null\)/);
  assert.match(usageTable, /expanded === null/);
  assert.match(usageTable, /aria-expanded=/);
  // Value cells memo needs stable primitives, not a fresh object per render
  assert.doesNotMatch(usageTable, /<ValueCells item=\{\{/);
});

test("ConsoleLogClient bounds log buffers and preserves stream cleanup", () => {
  assert.match(consoleLog, /CONSOLE_LOG_CONFIG\.maxLines/);
  assert.match(consoleLog, /return \(\) => es\.close\(\)/);
  assert.doesNotMatch(consoleLog, /key=\{i\}/);
  assert.match(consoleLog, /content-visibility:auto/);
});

test("translator keeps Monaco lazy with a stable loading fallback and keeps detect semantics", () => {
  assert.match(translator, /const Editor = dynamic\(\s*\(\) => import\("@monaco-editor\/react"\),\s*\{[^}]*ssr: false/);
  assert.match(translator, /loading:/);
  assert.match(translator, /motion-safe:animate-pulse/);
  // auto-detection behaviour preserved on both explicit paths
  assert.match(translator, /if \(step\.id === 1\) detectMeta\(v \|\| ""\)/);
  assert.match(translator, /if \(stepId === 1\) await detectMeta\(data\.content\)/);
});
